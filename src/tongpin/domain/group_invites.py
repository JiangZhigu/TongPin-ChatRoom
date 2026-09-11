from __future__ import annotations

import re
import secrets

from tongpin.contracts.base import APIError
from tongpin.domain.access import user_summary
from tongpin.domain.chat import activity_cursor, next_activity
from tongpin.domain.security import audit, identifier
from tongpin.infra.db import now_ms


class GroupInvitationService:
    def __init__(self, runtime, groups):
        self.runtime = runtime
        self.groups = groups

    @staticmethod
    def member(conn, cid, uid):
        return conn.execute(
            "SELECT * FROM memberships WHERE conversation_id=? AND user_id=? AND left_at IS NULL",
            (cid, uid),
        ).fetchone()

    @staticmethod
    def row(conn, iid):
        row = conn.execute("SELECT * FROM group_invites WHERE id=?", (iid,)).fetchone()
        if not row:
            raise APIError("INVITE_UNAVAILABLE", "邀请不存在或已无法使用。", 404)
        return row

    def from_token(self, conn, token):
        if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{40,128}", token):
            raise APIError("INVITE_UNAVAILABLE", "邀请链接无效。", 404)
        row = conn.execute(
            "SELECT * FROM group_invites WHERE token_digest=?",
            (self.runtime.auth.security.digest(token, "group-invite"),),
        ).fetchone()
        if not row:
            raise APIError("INVITE_UNAVAILABLE", "邀请不存在或已无法使用。", 404)
        return row

    @staticmethod
    def reserved(conn, cid, iid=None):
        # Reservations are derived from live rows under the same write lock.
        # Expiry/revocation immediately frees a seat, even before the durable job runs.
        stamp = now_ms()
        return conn.execute(
            "SELECT COUNT(*) FROM group_applications a JOIN group_invites i ON i.id=a.invite_id JOIN conversations c ON c.id=a.conversation_id WHERE a.conversation_id=? AND (? IS NULL OR a.invite_id=?) AND a.status='pending' AND a.expires_at>? AND i.revoked_at IS NULL AND i.expires_at>? AND c.status<>'dissolved'",
            (cid, iid, iid, stamp, stamp),
        ).fetchone()[0]

    def state(self, conn, row):
        group = conn.execute(
            "SELECT * FROM conversations WHERE id=?", (row["conversation_id"],)
        ).fetchone()
        if group["status"] != "active":
            return "unavailable"
        if row["revoked_at"] is not None:
            return "revoked"
        if row["expires_at"] <= now_ms():
            return "expired"
        if row["used_count"] + self.reserved(conn, group["id"], row["id"]) >= row["max_uses"]:
            return "exhausted"
        active = conn.execute(
            "SELECT COUNT(*) FROM memberships WHERE conversation_id=? AND left_at IS NULL",
            (group["id"],),
        ).fetchone()[0]
        if (
            active + self.reserved(conn, group["id"])
            >= self.runtime.policy.get(conn)["group_limit"]
        ):
            return "full"
        return "available"

    def invite_view(self, conn, actor_id, row):
        group = conn.execute(
            "SELECT name FROM conversations WHERE id=?", (row["conversation_id"],)
        ).fetchone()
        member = self.member(conn, row["conversation_id"], actor_id) if actor_id else None
        reserved = self.reserved(conn, row["conversation_id"], row["id"])
        return {
            "id": row["id"],
            "conversationId": row["conversation_id"],
            "groupName": group["name"],
            "kind": row["kind"],
            "creator": user_summary(
                conn.execute("SELECT * FROM users WHERE id=?", (row["creator_id"],)).fetchone()
            ),
            "target": user_summary(
                conn.execute("SELECT * FROM users WHERE id=?", (row["target_id"],)).fetchone()
            )
            if row["target_id"]
            else None,
            "maxUses": row["max_uses"],
            "used": row["used_count"],
            "reserved": reserved,
            "remaining": max(0, row["max_uses"] - row["used_count"] - reserved),
            "expiresAt": row["expires_at"],
            "createdAt": row["created_at"],
            "state": self.state(conn, row),
            "canRevoke": bool(
                member
                and (member["role"] in ("owner", "admin") or row["creator_id"] == actor_id)
                and row["revoked_at"] is None
            ),
        }

    def application_view(self, conn, row):
        invite = self.row(conn, row["invite_id"])
        group = conn.execute(
            "SELECT name,status FROM conversations WHERE id=?", (row["conversation_id"],)
        ).fetchone()
        state = row["status"]
        if state == "pending" and (
            row["expires_at"] <= now_ms()
            or invite["expires_at"] <= now_ms()
            or invite["revoked_at"] is not None
            or group["status"] == "dissolved"
        ):
            state = "expired"
        return {
            "id": row["id"],
            "conversationId": row["conversation_id"],
            "groupName": group["name"],
            "inviteId": row["invite_id"],
            "user": user_summary(
                conn.execute("SELECT * FROM users WHERE id=?", (row["user_id"],)).fetchone()
            ),
            "status": state,
            "currentMember": bool(self.member(conn, row["conversation_id"], row["user_id"])),
            "expiresAt": row["expires_at"],
            "createdAt": row["created_at"],
        }

    def _managers(self, conn, cid):
        return [
            row[0]
            for row in conn.execute(
                "SELECT user_id FROM memberships WHERE conversation_id=? AND left_at IS NULL AND role IN('owner','admin')",
                (cid,),
            )
        ]

    def _notify_application(self, conn, row, actor_id=None):
        self.runtime.events.notify(
            conn, row["user_id"], "group.application.updated", row["id"], actor_id
        )
        for uid in self._managers(conn, row["conversation_id"]):
            self.runtime.events.publish(conn, [uid], "notification.updated", row["id"])

    def expire_in(self, conn, cid):
        stamp = now_ms()
        rows = conn.execute(
            "SELECT a.* FROM group_applications a JOIN group_invites i ON i.id=a.invite_id JOIN conversations c ON c.id=a.conversation_id WHERE a.conversation_id=? AND a.status='pending' AND (a.expires_at<=? OR i.expires_at<=? OR i.revoked_at IS NOT NULL OR c.status='dissolved')",
            (cid, stamp, stamp),
        ).fetchall()
        for row in rows:
            conn.execute(
                "UPDATE group_applications SET status='expired',updated_at=? WHERE id=? AND status='pending'",
                (stamp, row["id"]),
            )
            self._notify_application(conn, row)
        return len(rows)

    def create_in(self, conn, actor, cid, kind, target, max_uses, hours):
        if kind == "direct":
            if target == actor.id or self.member(conn, cid, target):
                raise APIError("ALREADY_MEMBER", "这位好友已在群聊中。", 409)
            self.runtime.access.direct_write(conn, actor.id, target)
        token = secrets.token_urlsafe(32) if kind == "link" else None
        iid, stamp = identifier("gi_"), now_ms()
        conn.execute(
            "INSERT INTO group_invites(id,conversation_id,creator_id,kind,target_id,token_digest,max_uses,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
            (
                iid,
                cid,
                actor.id,
                kind,
                target,
                self.runtime.auth.security.digest(token, "group-invite") if token else None,
                max_uses,
                stamp,
                stamp + hours * 3600000,
            ),
        )
        self.runtime.jobs.enqueue_in_transaction(
            conn,
            "groups.expire",
            {"conversationId": cid},
            entity_id=iid,
            run_after=stamp + hours * 3600000,
        )
        if target:
            self.runtime.events.notify(conn, target, "group.invited", iid, actor.id)
        audit(
            conn,
            actor.id,
            "group.invite.create",
            cid,
            details={"inviteId": iid, "kind": kind, "maxUses": max_uses, "expiresHours": hours},
        )
        return self.row(conn, iid), token

    def create(self, actor, cid, data):
        self.runtime.auth.security.rate("group-invite-create", actor.id, 60, 3600)
        with self.runtime.db.write() as conn:
            meta = self.groups.meta(conn, actor, cid, active=True)
            if meta["role"] == "member" and meta["row"]["invite_role"] != "members":
                raise APIError("FORBIDDEN", "只有群主或管理员可以创建邀请。", 403)
            old = self.groups.command(conn, actor, "invite:" + cid, data)
            if old:
                return {
                    "invite": self.invite_view(conn, actor.id, self.row(conn, old)),
                    "token": None,
                }
            row, token = self.create_in(
                conn, actor, cid, data.kind, data.targetUserId, data.maxUses, data.expiresHours
            )
            self.groups.command(conn, actor, "invite:" + cid, data, row["id"])
            return {"invite": self.invite_view(conn, actor.id, row), "token": token}

    def list(self, actor, cid, after="", limit=50):
        boundary, last_id = activity_cursor(after)
        with self.runtime.db.read() as conn:
            meta = self.groups.meta(conn, actor, cid)
            manager = meta["role"] in ("owner", "admin")
            rows = conn.execute(
                "SELECT * FROM group_invites WHERE conversation_id=? AND (? OR creator_id=?) AND (?=0 OR created_at<? OR(created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?",
                (cid, manager, actor.id, boundary, boundary, boundary, last_id, limit + 1),
            ).fetchall()
            return {
                "items": [self.invite_view(conn, actor.id, row) for row in rows[:limit]],
                "nextCursor": next_activity(rows, limit),
            }

    def mine(self, actor, after="", limit=50):
        boundary, last_id = activity_cursor(after)
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            rows = conn.execute(
                "SELECT * FROM group_invites WHERE target_id=? AND (?=0 OR created_at<? OR(created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?",
                (actor.id, boundary, boundary, boundary, last_id, limit + 1),
            ).fetchall()
            return {
                "items": [self.invite_view(conn, actor.id, row) for row in rows[:limit]],
                "nextCursor": next_activity(rows, limit),
            }

    def preview(self, token, actor=None):
        with self.runtime.db.read() as conn:
            if actor:
                actor = self.runtime.auth.current_in_transaction(conn, actor)
            row = self.from_token(conn, token)
            group = conn.execute(
                "SELECT * FROM conversations WHERE id=?", (row["conversation_id"],)
            ).fetchone()
            state, application = self.state(conn, row), None
            if actor and self.member(conn, group["id"], actor.id):
                state = "already_member"
            elif actor:
                pending = conn.execute(
                    "SELECT * FROM group_applications WHERE conversation_id=? AND user_id=? AND status='pending'",
                    (group["id"], actor.id),
                ).fetchone()
                if pending:
                    application = self.application_view(conn, pending)
                    if application["status"] == "pending":
                        state = "pending"
            return {
                "inviteId": row["id"],
                "conversationId": group["id"],
                "name": group["name"],
                "description": group["description"],
                "memberCount": conn.execute(
                    "SELECT COUNT(*) FROM memberships WHERE conversation_id=? AND left_at IS NULL",
                    (group["id"],),
                ).fetchone()[0],
                "requiresApproval": bool(group["review_required"]),
                "expiresAt": row["expires_at"],
                "maxUses": row["max_uses"],
                "remaining": max(
                    0,
                    row["max_uses"]
                    - row["used_count"]
                    - self.reserved(conn, group["id"], row["id"]),
                ),
                "state": state,
                "application": application,
            }

    def revoke(self, actor, cid, iid):
        with self.runtime.db.write() as conn:
            meta = self.groups.meta(conn, actor, cid)
            row = self.row(conn, iid)
            if row["conversation_id"] != cid:
                raise APIError("RESOURCE_UNAVAILABLE", "邀请不属于当前群聊。", 404)
            if meta["role"] == "member" and row["creator_id"] != actor.id:
                raise APIError("FORBIDDEN", "只能撤销自己有权管理的邀请。", 403)
            if row["revoked_at"] is None:
                conn.execute("UPDATE group_invites SET revoked_at=? WHERE id=?", (now_ms(), iid))
                self.expire_in(conn, cid)
                audit(conn, actor.id, "group.invite.revoke", cid, details={"inviteId": iid})
            return self.invite_view(conn, actor.id, self.row(conn, iid))

    def ensure_capacity(self, conn, invite, *, included=False):
        group = conn.execute(
            "SELECT * FROM conversations WHERE id=?", (invite["conversation_id"],)
        ).fetchone()
        if (
            group["status"] != "active"
            or invite["revoked_at"] is not None
            or invite["expires_at"] <= now_ms()
        ):
            raise APIError("INVITE_UNAVAILABLE", "邀请已过期、撤销或群聊不可用。", 409)
        reserved = self.reserved(conn, group["id"], invite["id"])
        offset = 0 if included else 1
        if invite["used_count"] + reserved + offset > invite["max_uses"]:
            raise APIError("INVITE_EXHAUSTED", "邀请名额已用完或被待审核申请预留。", 409)
        active = conn.execute(
            "SELECT COUNT(*) FROM memberships WHERE conversation_id=? AND left_at IS NULL",
            (group["id"],),
        ).fetchone()[0]
        if (
            active + self.reserved(conn, group["id"]) + offset
            > self.runtime.policy.get(conn)["group_limit"]
        ):
            raise APIError("GROUP_FULL", "群人数和待审核名额已达到上限。", 409)
        if self.runtime.policy.get(conn)["maintenance"]:
            raise APIError("MAINTENANCE", "服务维护中，暂时无法加入。", 503)
        return group

    def approve_in(self, conn, row, invite):
        self.ensure_capacity(conn, invite, included=True)
        target = conn.execute("SELECT status FROM users WHERE id=?", (row["user_id"],)).fetchone()
        if target["status"] != "active":
            raise APIError("RESOURCE_UNAVAILABLE", "申请账号当前不可用。", 409)
        if invite["kind"] == "direct":
            self.runtime.access.direct_write(conn, invite["creator_id"], row["user_id"])
        self.groups.add_member(conn, row["conversation_id"], row["user_id"])
        conn.execute(
            "UPDATE group_applications SET status='approved',updated_at=? WHERE id=? AND status='pending'",
            (now_ms(), row["id"]),
        )
        conn.execute("UPDATE group_invites SET used_count=used_count+1 WHERE id=?", (invite["id"],))

    def apply(self, actor, iid, data, token=None):
        self.runtime.auth.security.rate("group-apply", actor.id, 60, 3600)
        with self.runtime.db.write() as conn:
            actor = self.runtime.auth.current_in_transaction(conn, actor)
            invite = self.row(conn, iid)
            if invite["kind"] == "link":
                if self.from_token(conn, token)["id"] != iid:
                    raise APIError("INVITE_UNAVAILABLE", "邀请链接与目标不匹配。", 404)
            elif invite["target_id"] != actor.id:
                raise APIError("RESOURCE_UNAVAILABLE", "这份邀请不属于当前账号。", 404)
            old = self.groups.command(conn, actor, "apply:" + iid, data)
            if old:
                return self.application_view(
                    conn,
                    conn.execute("SELECT * FROM group_applications WHERE id=?", (old,)).fetchone(),
                )
            cid = invite["conversation_id"]
            self.expire_in(conn, cid)
            if self.member(conn, cid, actor.id):
                group = conn.execute("SELECT name FROM conversations WHERE id=?", (cid,)).fetchone()
                return {
                    "id": None,
                    "conversationId": cid,
                    "groupName": group["name"],
                    "inviteId": iid,
                    "user": user_summary(actor.user),
                    "status": "already_member",
                    "currentMember": True,
                    "expiresAt": invite["expires_at"],
                    "createdAt": now_ms(),
                }
            pending = conn.execute(
                "SELECT * FROM group_applications WHERE conversation_id=? AND user_id=? AND status='pending'",
                (cid, actor.id),
            ).fetchone()
            if pending:
                self.groups.command(conn, actor, "apply:" + iid, data, pending["id"])
                return self.application_view(conn, pending)
            group = self.ensure_capacity(conn, invite)
            if invite["kind"] == "direct":
                self.runtime.access.direct_write(conn, invite["creator_id"], actor.id)
            rid, stamp = identifier("ga_"), now_ms()
            conn.execute(
                "INSERT INTO group_applications VALUES(?,?,?,?,'pending',?,?,?)",
                (rid, cid, iid, actor.id, stamp, stamp, invite["expires_at"]),
            )
            self.groups.command(conn, actor, "apply:" + iid, data, rid)
            row = conn.execute("SELECT * FROM group_applications WHERE id=?", (rid,)).fetchone()
            if not group["review_required"]:
                self.approve_in(conn, row, invite)
            else:
                for uid in self._managers(conn, cid):
                    self.runtime.events.notify(conn, uid, "group.application", rid, actor.id)
            self._notify_application(conn, row, actor.id)
            audit(
                conn,
                actor.id,
                "group.application.create",
                cid,
                details={"applicationId": rid, "inviteId": iid},
            )
            return self.application_view(
                conn, conn.execute("SELECT * FROM group_applications WHERE id=?", (rid,)).fetchone()
            )

    def applications(self, actor, cid=None, after="", limit=50):
        boundary, last_id = activity_cursor(after)
        with self.runtime.db.read() as conn:
            if cid:
                self.groups.meta(conn, actor, cid, manage=True)
            else:
                self.runtime.auth.current_in_transaction(conn, actor)
            rows = conn.execute(
                "SELECT * FROM group_applications WHERE (? IS NOT NULL AND conversation_id=? OR ? IS NULL AND user_id=?) AND (?=0 OR created_at<? OR(created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?",
                (cid, cid, cid, actor.id, boundary, boundary, boundary, last_id, limit + 1),
            ).fetchall()
            return {
                "items": [self.application_view(conn, row) for row in rows[:limit]],
                "nextCursor": next_activity(rows, limit),
            }

    def decide(self, actor, rid, action):
        with self.runtime.db.write() as conn:
            actor = self.runtime.auth.current_in_transaction(conn, actor)
            row = conn.execute("SELECT * FROM group_applications WHERE id=?", (rid,)).fetchone()
            if not row:
                raise APIError("RESOURCE_UNAVAILABLE", "入群申请不存在。", 404)
            if action == "cancel":
                if row["user_id"] != actor.id:
                    raise APIError("RESOURCE_UNAVAILABLE", "这不是当前账号的申请。", 404)
            else:
                self.groups.meta(
                    conn, actor, row["conversation_id"], manage=True, active=action == "approve"
                )
            self.expire_in(conn, row["conversation_id"])
            row = conn.execute("SELECT * FROM group_applications WHERE id=?", (rid,)).fetchone()
            if row["status"] != "pending":
                return self.application_view(conn, row)
            if action == "approve":
                self.approve_in(conn, row, self.row(conn, row["invite_id"]))
            else:
                conn.execute(
                    "UPDATE group_applications SET status=?,updated_at=? WHERE id=?",
                    ("rejected" if action == "reject" else "cancelled", now_ms(), rid),
                )
            self._notify_application(conn, row, actor.id)
            audit(
                conn,
                actor.id,
                "group.application." + action,
                row["conversation_id"],
                details={"applicationId": rid, "targetId": row["user_id"]},
            )
            return self.application_view(
                conn, conn.execute("SELECT * FROM group_applications WHERE id=?", (rid,)).fetchone()
            )
