from __future__ import annotations

import hashlib
import json

from tongpin.contracts.base import APIError
from tongpin.domain.access import user_summary
from tongpin.domain.chat import activity_cursor, next_activity
from tongpin.domain.security import audit, identifier
from tongpin.infra.db import now_ms


class GroupService:
    def __init__(self, runtime):
        from tongpin.domain.group_invites import GroupInvitationService

        self.runtime = runtime
        self.invites = GroupInvitationService(runtime, self)

    def meta(self, conn, actor, cid, *, manage=False, owner=False, active=False):
        actor = self.runtime.auth.current_in_transaction(conn, actor)
        meta = self.runtime.access.conversation(conn, actor.id, cid)
        if meta["row"]["kind"] != "group":
            raise APIError("RESOURCE_UNAVAILABLE", "群聊不存在或已无法访问。", 404)
        if (owner and meta["role"] != "owner") or (
            manage and meta["role"] not in ("owner", "admin")
        ):
            raise APIError("FORBIDDEN", "当前群角色无权执行此操作。", 403)
        if active and meta["row"]["status"] != "active":
            raise APIError("CONVERSATION_FROZEN", "群聊当前已暂停管理操作。", 403)
        if active and self.runtime.policy.get(conn)["maintenance"]:
            raise APIError("MAINTENANCE", "服务维护中，暂时无法修改群聊。", 503)
        return meta

    @staticmethod
    def version(meta, expected):
        if meta["row"]["role_version"] != expected:
            raise APIError("VERSION_CONFLICT", "群信息或成员已改变，请刷新后重新确认操作。", 409)

    def owner_capacity(self, conn, uid):
        count = conn.execute(
            "SELECT COUNT(*) FROM conversations WHERE kind='group' AND owner_id=? AND status<>'dissolved'",
            (uid,),
        ).fetchone()[0]
        if count >= self.runtime.policy.get(conn)["owned_group_limit"]:
            raise APIError("OWNED_GROUP_LIMIT", "当前拥有的群聊数量已达到上限。", 409)

    @staticmethod
    def command(conn, actor, operation, data, result=None):
        payload = data.model_dump(exclude={"reauthToken"})
        if "friendUserIds" in payload:
            payload["friendUserIds"] = sorted(set(payload["friendUserIds"]))
        digest = hashlib.sha256(
            json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
        ).hexdigest()
        old = conn.execute(
            "SELECT * FROM group_commands WHERE actor_id=? AND operation=? AND client_key=?",
            (actor.id, operation, data.clientRequestId),
        ).fetchone()
        if old:
            if old["payload_hash"] != digest:
                raise APIError(
                    "IDEMPOTENCY_CONFLICT", "操作标识已用于不同内容，请先确认原操作结果。", 409
                )
            return old["result_id"]
        if result is not None:
            conn.execute(
                "INSERT INTO group_commands VALUES(?,?,?,?,?,?)",
                (actor.id, operation, data.clientRequestId, digest, result, now_ms()),
            )
        return None

    def changed(self, conn, cid):
        self.runtime.events.publish(
            conn, self.runtime.access.recipients(conn, cid), "conversation.updated", cid, cid
        )

    def system_message(self, conn, cid, text):
        row = conn.execute("SELECT last_seq FROM conversations WHERE id=?", (cid,)).fetchone()
        seq, mid, stamp = row["last_seq"] + 1, identifier("m_"), now_ms()
        conn.execute(
            "UPDATE conversations SET last_seq=?,updated_at=? WHERE id=?", (seq, stamp, cid)
        )
        conn.execute(
            "INSERT INTO messages(id,conversation_id,seq,payload_hash,kind,text,created_at) VALUES(?,?,?,'system','system',?,?)",
            (mid, cid, seq, text, stamp),
        )
        self.runtime.events.publish(
            conn, self.runtime.access.recipients(conn, cid), "message.created", mid, cid
        )

    def add_member(self, conn, cid, uid, role="member"):
        group = conn.execute("SELECT last_seq FROM conversations WHERE id=?", (cid,)).fetchone()
        if (
            conn.execute(
                "SELECT COUNT(*) FROM memberships WHERE conversation_id=? AND left_at IS NULL",
                (cid,),
            ).fetchone()[0]
            >= self.runtime.policy.get(conn)["group_limit"]
        ):
            raise APIError("GROUP_FULL", "群人数已达到上限。", 409)
        period, stamp = identifier("mp_"), now_ms()
        conn.execute(
            "INSERT INTO memberships(id,conversation_id,user_id,role,visible_from_seq,joined_at) VALUES(?,?,?,?,?,?)",
            (period, cid, uid, role, group["last_seq"] + 1, stamp),
        )
        conn.execute(
            "INSERT INTO conversation_preferences(user_id,conversation_id,read_seq) VALUES(?,?,?) ON CONFLICT(user_id,conversation_id) DO UPDATE SET read_seq=excluded.read_seq,archived=0",
            (uid, cid, group["last_seq"]),
        )
        conn.execute(
            "UPDATE conversations SET role_version=role_version+1,updated_at=? WHERE id=?",
            (stamp, cid),
        )
        user = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        self.system_message(conn, cid, user_summary(user)["nickname"] + " 加入了群聊")
        self.changed(conn, cid)
        return period

    def create(self, actor, data):
        self.runtime.auth.security.rate("group-create", actor.id, 30, 3600)
        if not data.name.strip():
            raise APIError("VALIDATION_ERROR", "请填写群名称。", 422)
        with self.runtime.db.write() as conn:
            actor = self.runtime.auth.current_in_transaction(conn, actor)
            old = self.command(conn, actor, "create", data)
            if old:
                return self.detail_in(conn, actor, old)
            if self.runtime.policy.get(conn)["maintenance"]:
                raise APIError("MAINTENANCE", "服务维护中，暂时无法建群。", 503)
            self.owner_capacity(conn, actor.id)
            for uid in set(data.friendUserIds):
                if uid == actor.id:
                    raise APIError("VALIDATION_ERROR", "不需要邀请自己。", 422)
                self.runtime.access.direct_write(conn, actor.id, uid)
            cid, stamp = identifier("g_"), now_ms()
            conn.execute(
                "INSERT INTO conversations(id,kind,owner_id,name,description,created_at,updated_at) VALUES(?,'group',?,?,?,?,?)",
                (cid, actor.id, data.name.strip(), data.description.strip(), stamp, stamp),
            )
            self.add_member(conn, cid, actor.id, "owner")
            for uid in sorted(set(data.friendUserIds)):
                self.invites.create_in(conn, actor, cid, "direct", uid, 1, 24)
            self.command(conn, actor, "create", data, cid)
            audit(
                conn,
                actor.id,
                "group.create",
                cid,
                details={"invitedCount": len(set(data.friendUserIds))},
            )
            result = self.detail_in(conn, actor, cid)
        return result

    def transfer_view(self, conn, row):
        state = (
            "expired"
            if row["status"] == "pending" and row["expires_at"] <= now_ms()
            else row["status"]
        )
        return {
            "id": row["id"],
            "conversationId": row["conversation_id"],
            "from": user_summary(
                conn.execute("SELECT * FROM users WHERE id=?", (row["from_id"],)).fetchone()
            ),
            "to": user_summary(
                conn.execute("SELECT * FROM users WHERE id=?", (row["to_id"],)).fetchone()
            ),
            "targetPeriodId": row["target_period_id"],
            "status": state,
            "expiresAt": row["expires_at"],
            "createdAt": row["created_at"],
        }

    def detail_in(self, conn, actor, cid):
        meta = self.meta(conn, actor, cid)
        row, role = meta["row"], meta["role"]
        manager = role in ("owner", "admin")
        enabled = row["status"] == "active" and not self.runtime.policy.get(conn)["maintenance"]
        transfer = conn.execute(
            "SELECT * FROM group_transfers WHERE conversation_id=? AND status='pending' AND expires_at>?",
            (cid, now_ms()),
        ).fetchone()
        return {
            "conversation": self.runtime.chat.conversation_view(conn, actor.id, cid),
            "version": row["role_version"],
            "settings": {
                "announcement": row["announcement"],
                "announcementPinned": bool(row["announcement_pinned"]),
                "reviewRequired": bool(row["review_required"]),
                "inviteRole": row["invite_role"],
                "everyoneMuted": bool(row["everyone_muted"]),
                "slowSeconds": row["slow_seconds"],
            },
            "capabilities": {
                "canEdit": manager and enabled,
                "canInvite": enabled and (manager or row["invite_role"] == "members"),
                "canReview": manager and enabled,
                "canAssignRoles": role == "owner" and enabled,
                "canTransfer": role == "owner" and enabled,
                "canDissolve": role == "owner",
                "canLeave": role != "owner",
            },
            "transfer": self.transfer_view(conn, transfer) if transfer else None,
        }

    def get(self, actor, cid):
        with self.runtime.db.read() as conn:
            return self.detail_in(conn, actor, cid)

    def update(self, actor, cid, data):
        values = data.model_dump(exclude_unset=True, exclude_none=True, exclude={"expectedVersion"})
        if not values or ("name" in values and not values["name"].strip()):
            raise APIError("VALIDATION_ERROR", "请填写有效的群信息变更。", 422)
        columns = {
            "name": "name",
            "description": "description",
            "announcement": "announcement",
            "announcementPinned": "announcement_pinned",
            "reviewRequired": "review_required",
            "inviteRole": "invite_role",
            "everyoneMuted": "everyone_muted",
            "slowSeconds": "slow_seconds",
        }
        with self.runtime.db.write() as conn:
            meta = self.meta(conn, actor, cid, manage=True, active=True)
            self.version(meta, data.expectedVersion)
            if set(values) & {"reviewRequired", "inviteRole"} and meta["role"] != "owner":
                raise APIError("FORBIDDEN", "只有群主能修改入群和邀请策略。", 403)
            for key, value in values.items():
                conn.execute(
                    f"UPDATE conversations SET {columns[key]}=? WHERE id=?",
                    (int(value) if isinstance(value, bool) else value, cid),
                )
            conn.execute(
                "UPDATE conversations SET role_version=role_version+1,write_version=write_version+?,updated_at=? WHERE id=?",
                (int(bool(set(values) & {"everyoneMuted", "slowSeconds"})), now_ms(), cid),
            )
            audit(conn, actor.id, "group.settings", cid, details={"fields": sorted(values)})
            if "announcement" in values:
                self.system_message(conn, cid, "群公告已更新")
            self.changed(conn, cid)
            return self.detail_in(conn, actor, cid)

    def members(self, actor, cid, after="", limit=50):
        boundary, last_id = activity_cursor(after)
        with self.runtime.db.read() as conn:
            self.meta(conn, actor, cid)
            rows = conn.execute(
                "SELECT * FROM memberships WHERE conversation_id=? AND left_at IS NULL AND (?=0 OR joined_at<? OR(joined_at=? AND id<?)) ORDER BY joined_at DESC,id DESC LIMIT ?",
                (cid, boundary, boundary, boundary, last_id, limit + 1),
            ).fetchall()
            items = [
                {
                    "user": user_summary(
                        conn.execute("SELECT * FROM users WHERE id=?", (row["user_id"],)).fetchone()
                    ),
                    "periodId": row["id"],
                    "role": row["role"],
                    "joinedAt": row["joined_at"],
                    "mutedUntil": row["muted_until"],
                }
                for row in rows[:limit]
            ]
            return {"items": items, "nextCursor": next_activity(rows, limit, "joined_at")}

    @staticmethod
    def target(conn, meta, actor, uid, period):
        row = conn.execute(
            "SELECT * FROM memberships WHERE conversation_id=? AND user_id=? AND left_at IS NULL",
            (meta["row"]["id"], uid),
        ).fetchone()
        if not row or row["id"] != period:
            raise APIError("VERSION_CONFLICT", "该成员的加入状态已改变，请刷新后再操作。", 409)
        if (
            uid == actor.id
            or row["role"] == "owner"
            or (meta["role"] == "admin" and row["role"] != "member")
        ):
            raise APIError("FORBIDDEN", "当前角色不能管理自己、群主或同级管理员。", 403)
        return row

    def member_update(self, actor, cid, uid, data):
        fields = data.model_fields_set & {"role", "mutedUntil"}
        if not fields or ("role" in fields and data.role is None):
            raise APIError("VALIDATION_ERROR", "请选择有效的成员变更。", 422)
        if (
            data.mutedUntil is not None
            and not now_ms() < data.mutedUntil <= now_ms() + 30 * 86400000
        ):
            raise APIError(
                "VALIDATION_ERROR", "禁言结束时间须在未来30天内，解除禁言请选清除。", 422
            )
        with self.runtime.db.write() as conn:
            meta = self.meta(conn, actor, cid, manage=True, active=True)
            self.version(meta, data.expectedVersion)
            self.target(conn, meta, actor, uid, data.periodId)
            if "role" in fields and meta["role"] != "owner":
                raise APIError("FORBIDDEN", "只有群主能任免管理员。", 403)
            if "role" in fields:
                conn.execute("UPDATE memberships SET role=? WHERE id=?", (data.role, data.periodId))
            if "mutedUntil" in fields:
                conn.execute(
                    "UPDATE memberships SET muted_until=? WHERE id=?",
                    (data.mutedUntil, data.periodId),
                )
            conn.execute(
                "UPDATE memberships SET write_version=write_version+1 WHERE id=?", (data.periodId,)
            )
            conn.execute(
                "UPDATE conversations SET role_version=role_version+1,updated_at=? WHERE id=?",
                (now_ms(), cid),
            )
            audit(
                conn,
                actor.id,
                "group.member.update",
                cid,
                details={
                    "targetId": uid,
                    "fields": sorted(fields),
                    "role": data.role if "role" in fields else None,
                },
            )
            self.changed(conn, cid)
            return self.detail_in(conn, actor, cid)

    def remove_in(self, conn, cid, uid, reason):
        conn.execute(
            "UPDATE memberships SET left_at=?,left_reason=?,write_version=write_version+1 WHERE conversation_id=? AND user_id=? AND left_at IS NULL",
            (now_ms(), reason, cid, uid),
        )
        conn.execute(
            "UPDATE group_transfers SET status='cancelled',updated_at=? WHERE conversation_id=? AND to_id=? AND status='pending'",
            (now_ms(), cid, uid),
        )
        conn.execute(
            "UPDATE conversations SET role_version=role_version+1,updated_at=? WHERE id=?",
            (now_ms(), cid),
        )
        self.runtime.events.publish(conn, [uid], "access.revoked", cid, cid)
        self.system_message(
            conn, cid, "一位成员离开了群聊" if reason == "leave" else "一位成员已被移出群聊"
        )
        self.changed(conn, cid)

    def remove(self, actor, cid, uid, data):
        with self.runtime.db.write() as conn:
            meta = self.meta(conn, actor, cid, manage=True, active=True)
            self.version(meta, data.expectedVersion)
            self.target(conn, meta, actor, uid, data.periodId)
            self.remove_in(conn, cid, uid, "removed")
            audit(
                conn,
                actor.id,
                "group.member.remove",
                cid,
                reason=data.reason,
                details={"targetId": uid},
            )
            return self.detail_in(conn, actor, cid)

    def leave(self, actor, cid):
        with self.runtime.db.write() as conn:
            meta = self.meta(conn, actor, cid)
            if meta["role"] == "owner":
                raise APIError("OWNER_MUST_TRANSFER", "群主须先转让群主或解散群聊。", 409)
            self.remove_in(conn, cid, actor.id, "leave")
            audit(conn, actor.id, "group.leave", cid)
        return {"left": True}

    def dissolve(self, actor, cid, data):
        with self.runtime.db.write() as conn:
            meta = self.meta(conn, actor, cid, owner=True)
            self.version(meta, data.expectedVersion)
            self.runtime.auth.consume_reauth(conn, actor, data.reauthToken, "group_dissolve:" + cid)
            recipients = self.runtime.access.recipients(conn, cid)
            stamp = now_ms()
            conn.execute(
                "UPDATE conversations SET status='dissolved',dissolved_at=?,updated_at=?,role_version=role_version+1,write_version=write_version+1 WHERE id=?",
                (stamp, stamp, cid),
            )
            conn.execute(
                "UPDATE memberships SET left_at=?,left_reason='dissolved',write_version=write_version+1 WHERE conversation_id=? AND left_at IS NULL",
                (stamp, cid),
            )
            conn.execute(
                "UPDATE group_invites SET revoked_at=COALESCE(revoked_at,?) WHERE conversation_id=?",
                (stamp, cid),
            )
            self.invites.expire_in(conn, cid)
            conn.execute(
                "UPDATE group_transfers SET status='cancelled',updated_at=? WHERE conversation_id=? AND status='pending'",
                (stamp, cid),
            )
            self.runtime.events.publish(conn, recipients, "access.revoked", cid, cid)
            audit(
                conn,
                actor.id,
                "group.dissolve",
                cid,
                details={"formerMemberCount": len(recipients)},
            )
        return {"dissolved": True}

    def start_transfer(self, actor, cid, data):
        with self.runtime.db.write() as conn:
            meta = self.meta(conn, actor, cid, owner=True, active=True)
            old = self.command(conn, actor, "transfer:" + cid, data)
            if old:
                return self.transfer_view(
                    conn,
                    conn.execute("SELECT * FROM group_transfers WHERE id=?", (old,)).fetchone(),
                )
            self.version(meta, data.expectedVersion)
            target = self.target(conn, meta, actor, data.targetUserId, data.targetPeriodId)
            user = conn.execute(
                "SELECT status FROM users WHERE id=?", (data.targetUserId,)
            ).fetchone()
            if user["status"] != "active":
                raise APIError("RESOURCE_UNAVAILABLE", "受让成员当前不可用。", 404)
            self.owner_capacity(conn, data.targetUserId)
            conn.execute(
                "UPDATE group_transfers SET status='expired',updated_at=? WHERE conversation_id=? AND status='pending' AND expires_at<=?",
                (now_ms(), cid, now_ms()),
            )
            if conn.execute(
                "SELECT 1 FROM group_transfers WHERE conversation_id=? AND status='pending'", (cid,)
            ).fetchone():
                raise APIError("TRANSFER_PENDING", "已有转让等待确认，请先取消或等待处理。", 409)
            self.runtime.auth.consume_reauth(conn, actor, data.reauthToken, "group_transfer:" + cid)
            tid, stamp = identifier("gt_"), now_ms()
            conn.execute(
                "INSERT INTO group_transfers VALUES(?,?,?,?,?,'pending',?,?,?)",
                (
                    tid,
                    cid,
                    actor.id,
                    data.targetUserId,
                    target["id"],
                    stamp,
                    stamp,
                    stamp + 86400000,
                ),
            )
            self.command(conn, actor, "transfer:" + cid, data, tid)
            self.runtime.jobs.enqueue_in_transaction(
                conn,
                "groups.expire",
                {"conversationId": cid},
                entity_id=tid,
                run_after=stamp + 86400000,
            )
            audit(
                conn,
                actor.id,
                "group.transfer.request",
                cid,
                details={"targetId": data.targetUserId, "transferId": tid},
            )
            self.runtime.events.notify(conn, data.targetUserId, "group.transfer", cid, actor.id)
            self.changed(conn, cid)
            return self.transfer_view(
                conn, conn.execute("SELECT * FROM group_transfers WHERE id=?", (tid,)).fetchone()
            )

    def decide_transfer(self, actor, cid, tid, action):
        with self.runtime.db.write() as conn:
            meta = self.meta(conn, actor, cid, active=action == "accept")
            row = conn.execute(
                "SELECT * FROM group_transfers WHERE id=? AND conversation_id=?", (tid, cid)
            ).fetchone()
            if not row:
                raise APIError("RESOURCE_UNAVAILABLE", "转让申请不存在。", 404)
            allowed = row["from_id"] if action == "cancel" else row["to_id"]
            if actor.id != allowed:
                raise APIError("FORBIDDEN", "不能代替另一位成员处理转让。", 403)
            current = self.transfer_view(conn, row)
            if current["status"] != "pending":
                return current
            if meta["row"]["owner_id"] != row["from_id"]:
                raise APIError("VERSION_CONFLICT", "群主状态已改变，转让无法继续。", 409)
            state = {"accept": "accepted", "reject": "rejected", "cancel": "cancelled"}[action]
            if action == "accept":
                if meta["periodId"] != row["target_period_id"]:
                    raise APIError("VERSION_CONFLICT", "加入期已改变，原转让不可接受。", 409)
                original = conn.execute(
                    "SELECT status FROM users WHERE id=?", (row["from_id"],)
                ).fetchone()
                if original["status"] != "active":
                    raise APIError("RESOURCE_UNAVAILABLE", "原群主账号当前不可用。", 409)
                self.owner_capacity(conn, actor.id)
                # Lower first to preserve the single-owner unique index throughout the transaction.
                conn.execute(
                    "UPDATE memberships SET role='member',write_version=write_version+1 WHERE conversation_id=? AND role='owner' AND left_at IS NULL",
                    (cid,),
                )
                conn.execute(
                    "UPDATE memberships SET role='owner',write_version=write_version+1 WHERE id=?",
                    (row["target_period_id"],),
                )
                conn.execute(
                    "UPDATE conversations SET owner_id=?,role_version=role_version+1,updated_at=? WHERE id=?",
                    (actor.id, now_ms(), cid),
                )
                self.system_message(conn, cid, "群主转让已完成")
            conn.execute(
                "UPDATE group_transfers SET status=?,updated_at=? WHERE id=?",
                (state, now_ms(), tid),
            )
            audit(conn, actor.id, "group.transfer." + action, cid, details={"transferId": tid})
            self.runtime.events.notify(
                conn, row["from_id"], "group.transfer.updated", cid, actor.id
            )
            self.changed(conn, cid)
            return self.transfer_view(
                conn, conn.execute("SELECT * FROM group_transfers WHERE id=?", (tid,)).fetchone()
            )

    def audit_log(self, actor, cid, after="", limit=50):
        boundary, last_id = activity_cursor(after)
        with self.runtime.db.read() as conn:
            self.meta(conn, actor, cid, manage=True)
            rows = conn.execute(
                "SELECT * FROM audit_events WHERE subject_id=? AND action LIKE 'group.%' AND (?=0 OR created_at<? OR(created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?",
                (cid, boundary, boundary, boundary, last_id, limit + 1),
            ).fetchall()
            items = []
            for row in rows[:limit]:
                actor_row = (
                    conn.execute("SELECT * FROM users WHERE id=?", (row["actor_id"],)).fetchone()
                    if row["actor_id"]
                    else None
                )
                items.append(
                    {
                        "id": str(row["id"]),
                        "actor": user_summary(actor_row) if actor_row else None,
                        "action": row["action"],
                        "reason": row["reason"],
                        "details": json.loads(row["details"]),
                        "createdAt": row["created_at"],
                    }
                )
            return {"items": items, "nextCursor": next_activity(rows, limit)}

    def expire_job(self, job):
        cid = job["payload"]["conversationId"]
        with self.runtime.db.write() as conn:
            self.invites.expire_in(conn, cid)
            affected = conn.execute(
                "UPDATE group_transfers SET status='expired',updated_at=? WHERE conversation_id=? AND status='pending' AND expires_at<=?",
                (now_ms(), cid, now_ms()),
            ).rowcount
            if affected:
                self.changed(conn, cid)
        return {"expiredTransfers": affected}
