from __future__ import annotations

import json

from tongpin.contracts.base import APIError
from tongpin.domain.security import audit
from tongpin.infra.db import now_ms

DAY = 86400000


class LifecycleService:
    def __init__(self, runtime):
        self.runtime = runtime

    def initialize(self):
        with self.runtime.db.write() as conn:
            self.schedule(conn, 30000)

    def schedule(self, conn, delay=3600000):
        pending = conn.execute(
            "SELECT id,run_after FROM jobs WHERE kind='retention.cleanup' AND status='pending' ORDER BY run_after LIMIT 1"
        ).fetchone()
        if pending and pending["run_after"] > now_ms() + delay:
            conn.execute(
                "UPDATE jobs SET run_after=? WHERE id=?", (now_ms() + delay, pending["id"])
            )
        elif not pending:
            self.runtime.jobs.enqueue_in_transaction(
                conn, "retention.cleanup", run_after=now_ms() + delay
            )

    def preview_in(self, conn, actor):
        groups = conn.execute(
            "SELECT id,name,status FROM conversations WHERE kind='group' AND owner_id=? AND status<>'dissolved' ORDER BY created_at,id LIMIT 100",
            (actor.id,),
        ).fetchall()
        other_admin = conn.execute(
            "SELECT 1 FROM users WHERE id<>? AND site_role='super_admin' AND status='active' AND totp_secret IS NOT NULL LIMIT 1",
            (actor.id,),
        ).fetchone()
        return {
            "coolingDays": self.runtime.policy.get(conn)["deletion_cooling_days"],
            "ownedGroups": [dict(row) for row in groups],
            "lastAdministrator": actor.user["site_role"] == "super_admin" and not other_admin,
            "sharedMessagesRetained": True,
        }

    def deletion_preview(self, actor):
        with self.runtime.db.read() as conn:
            actor = self.runtime.auth.current_in_transaction(conn, actor)
            return self.preview_in(conn, actor)

    def deletion_receipt(self, token, data):
        # A revoked session grants no access. Together with the exact consumed
        # reauthentication token it can only replay this account's deletion receipt.
        with self.runtime.db.read() as conn:
            receipt = conn.execute(
                "SELECT u.deletion_at FROM users u JOIN sessions s ON s.user_id=u.id "
                "JOIN reauth_tokens r ON r.session_id=s.id WHERE s.token_hash=? "
                "AND r.digest=? AND r.action='account.delete' AND r.consumed_at IS NOT NULL "
                "AND s.revoked_at IS NOT NULL AND u.status='deleting' "
                "AND u.deletion_at>? AND u.username=?",
                (
                    self.runtime.auth.security.digest(token),
                    self.runtime.auth.security.digest(data.reauthToken, "reauth"),
                    now_ms(),
                    data.confirmation,
                ),
            ).fetchone()
            if receipt:
                return {"deleted": True, "recoverBefore": receipt[0]}
        return None

    def deletion_request(self, token, data):
        receipt = self.deletion_receipt(token, data)
        if receipt:
            return receipt
        try:
            actor = self.runtime.auth.load(token)
            return self.delete_account(actor, data)
        except APIError as error:
            if error.code == "AUTH_REQUIRED":
                receipt = self.deletion_receipt(token, data)
                if receipt:
                    return receipt
                # Keep a pending UI and its local-data decision available for recovery.
                raise APIError(
                    "DELETION_UNCONFIRMED",
                    "无法核对这次注销，请保留本机内容并重新登录或通过恢复码核对账号状态。",
                    403,
                ) from error
            raise

    def delete_account(self, actor, data):
        with self.runtime.db.write() as conn:
            actor = self.runtime.auth.current_in_transaction(conn, actor)
            if data.confirmation != actor.user["username"]:
                raise APIError("VALIDATION_ERROR", "请填写本人登录名确认注销。", 422)
            impact = self.preview_in(conn, actor)
            if impact["ownedGroups"]:
                raise APIError("OWNER_MUST_TRANSFER", "请先转让或解散自己拥有的群聊。", 409)
            if impact["lastAdministrator"]:
                raise APIError("LAST_ADMINISTRATOR", "最后一个可用超级管理员不能直接注销。", 409)
            self.runtime.auth.consume_reauth(conn, actor, data.reauthToken, "account.delete")
            deadline = now_ms() + impact["coolingDays"] * DAY
            conn.execute(
                "UPDATE users SET status='deleting',deletion_at=?,updated_at=? WHERE id=?",
                (deadline, now_ms(), actor.id),
            )
            conn.execute(
                "UPDATE sessions SET revoked_at=COALESCE(revoked_at,?) WHERE user_id=?",
                (now_ms(), actor.id),
            )
            conn.execute(
                "DELETE FROM reauth_tokens WHERE session_id IN(SELECT id FROM sessions WHERE user_id=?) AND digest<>?",
                (actor.id, self.runtime.auth.security.digest(data.reauthToken, "reauth")),
            )
            conn.execute(
                "UPDATE reauth_tokens SET expires_at=? WHERE digest=? AND consumed_at IS NOT NULL",
                (deadline, self.runtime.auth.security.digest(data.reauthToken, "reauth")),
            )
            audit(
                conn,
                actor.id,
                "account.delete.request",
                actor.id,
                details={"recoverBefore": deadline},
            )
            self.runtime.events.user_changed(conn, actor.id)
            self.schedule(conn, 30000)
        self.runtime.revalidate_connections()
        self.runtime.presence_changed(actor.id)
        return {"deleted": True, "recoverBefore": deadline}

    def cleanup(self, job=None):
        counts = {
            "messagesPurged": 0,
            "accountsPurged": 0,
            "membershipsClosed": 0,
            "eventsPurged": 0,
            "auditPurged": 0,
        }
        with self.runtime.files.storage_lock, self.runtime.db.write() as conn:
            hold = conn.execute(
                "SELECT value FROM instance_metadata WHERE key='backup_active'"
            ).fetchone()
            if hold and hold[0] == "1":
                self.schedule(conn, 60000)
                return counts | {"heldByBackup": True}
            policy, timestamp = self.runtime.policy.get(conn), now_ms()
            removed = conn.execute(
                "SELECT id,conversation_id FROM messages WHERE status IN('recalled','moderated') AND removed_at<=? ORDER BY removed_at,id LIMIT 100",
                (timestamp - policy["deleted_content_days"] * DAY,),
            ).fetchall()
            for row in removed:
                # Unbinding alone would make a ready upload visible to its owner.
                # Revoke the file state in the same transaction before file GC.
                conn.execute(
                    "UPDATE attachments SET message_id=NULL,state='expired',expires_at=?,error_code='CONTENT_PURGED' WHERE message_id=?",
                    (timestamp, row["id"]),
                )
                conn.execute("DELETE FROM message_reactions WHERE message_id=?", (row["id"],))
                conn.execute(
                    "UPDATE messages SET status='purged',text='',reply_id=NULL,mentioned_ids='[]',mention_all=0,removed_reason=NULL WHERE id=?",
                    (row["id"],),
                )
                self.runtime.events.publish(
                    conn,
                    self.runtime.access.recipients(conn, row["conversation_id"]),
                    "message.updated",
                    row["id"],
                    row["conversation_id"],
                )
                counts["messagesPurged"] += 1
            users = conn.execute(
                "SELECT * FROM users WHERE status='deleting' AND deletion_at<=? ORDER BY deletion_at,id LIMIT 20",
                (timestamp,),
            ).fetchall()
            more_accounts = False
            for user in users:
                # A restored/inconsistent database must not orphan an active owner.
                if conn.execute(
                    "SELECT 1 FROM conversations WHERE kind='group' AND owner_id=? AND status<>'dissolved' LIMIT 1",
                    (user["id"],),
                ).fetchone():
                    continue
                uid = user["id"]
                remaining = 20 - counts["membershipsClosed"]
                for member in conn.execute(
                    "SELECT conversation_id FROM memberships WHERE user_id=? AND left_at IS NULL LIMIT ?",
                    (uid, remaining),
                ).fetchall():
                    self.runtime.groups.remove_in(conn, member[0], uid, "leave")
                    counts["membershipsClosed"] += 1
                if conn.execute(
                    "SELECT 1 FROM memberships WHERE user_id=? AND left_at IS NULL LIMIT 1", (uid,)
                ).fetchone():
                    more_accounts = True
                    continue
                pending_groups = conn.execute(
                    "SELECT DISTINCT conversation_id FROM group_applications WHERE user_id=? AND status='pending' LIMIT 50",
                    (uid,),
                ).fetchall()
                for group in pending_groups:
                    conn.execute(
                        "UPDATE group_applications SET status='cancelled',updated_at=? WHERE user_id=? AND conversation_id=? AND status='pending'",
                        (timestamp, uid, group[0]),
                    )
                    self.runtime.groups.changed(conn, group[0])
                if conn.execute(
                    "SELECT 1 FROM group_applications WHERE user_id=? AND status='pending' LIMIT 1",
                    (uid,),
                ).fetchone():
                    more_accounts = True
                    continue
                conn.execute(
                    "UPDATE users SET status='deleted',nickname='已注销用户',bio='',password_hash='!',site_role='user',preferences='{}',totp_secret=NULL,totp_last_counter=-1,avatar_id=NULL,muted_until=NULL,quota_bytes=NULL,updated_at=? WHERE id=?",
                    (timestamp, uid),
                )
                conn.execute(
                    "UPDATE attachments SET avatar_bound=0,state='expired',expires_at=?,error_code='ACCOUNT_DELETED' WHERE owner_id=? AND message_id IS NULL",
                    (timestamp, uid),
                )
                conn.execute(
                    "DELETE FROM reauth_tokens WHERE session_id IN(SELECT id FROM sessions WHERE user_id=?)",
                    (uid,),
                )
                conn.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
                conn.execute("DELETE FROM recovery_codes WHERE user_id=?", (uid,))
                conn.execute("DELETE FROM reset_credentials WHERE user_id=?", (uid,))
                conn.execute("DELETE FROM bookmarks WHERE user_id=?", (uid,))
                conn.execute("DELETE FROM friend_preferences WHERE user_id=?", (uid,))
                conn.execute("DELETE FROM blocks WHERE user_id=?", (uid,))
                conn.execute("DELETE FROM notifications WHERE user_id=?", (uid,))
                conn.execute(
                    "UPDATE friend_requests SET note='',status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END,updated_at=? WHERE sender_id=? OR target_id=?",
                    (timestamp, uid, uid),
                )
                self.runtime.events.user_changed(conn, uid)
                audit(conn, None, "account.delete.complete", uid)
                counts["accountsPurged"] += 1
            old_events = conn.execute(
                "SELECT id FROM user_events WHERE created_at<? ORDER BY id LIMIT 1000",
                (timestamp - policy["events_days"] * DAY,),
            ).fetchall()
            if old_events:
                boundary = max(row[0] for row in old_events)
                conn.executemany(
                    "DELETE FROM user_events WHERE id=?", [(row[0],) for row in old_events]
                )
                conn.execute(
                    "UPDATE instance_metadata SET value=CAST(MAX(CAST(value AS INTEGER),?) AS TEXT) WHERE key='event_floor'",
                    (boundary,),
                )
                counts["eventsPurged"] = len(old_events)
            counts["auditPurged"] = conn.execute(
                "DELETE FROM audit_events WHERE id IN(SELECT id FROM audit_events WHERE created_at<? ORDER BY id LIMIT 1000)",
                (timestamp - policy["audit_days"] * DAY,),
            ).rowcount
            conn.execute(
                "DELETE FROM rate_buckets WHERE key IN(SELECT key FROM rate_buckets WHERE expires_at<? LIMIT 1000)",
                (timestamp,),
            )
            self.runtime.files.schedule_cleanup(conn, 0)
            more = (
                more_accounts
                or len(removed) == 100
                or len(users) == 20
                or len(old_events) == 1000
                or counts["auditPurged"] == 1000
            )
            self.schedule(conn, 1000 if more else 3600000)
            conn.execute(
                "INSERT INTO instance_metadata(key,value) VALUES('retention_last',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (json.dumps({"at": timestamp, **counts}),),
            )
        self.runtime.revalidate_connections()
        return counts | {"heldByBackup": False}
