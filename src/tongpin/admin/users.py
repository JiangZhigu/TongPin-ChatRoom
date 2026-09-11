from __future__ import annotations

import secrets

from tongpin.admin.authz import conflict, cursor, identity, last_admin_guard, page, unavailable
from tongpin.contracts.base import APIError
from tongpin.infra.db import now_ms


class UsersAdmin:
    def user_view(self, conn, row):
        stamp = now_ms()
        sessions = conn.execute(
            "SELECT MAX(last_seen_at),SUM(revoked_at IS NULL AND expires_at>? AND last_seen_at+idle_ms>?) FROM sessions WHERE user_id=?",
            (stamp, stamp, row["id"]),
        ).fetchone()
        owned = conn.execute(
            "SELECT COUNT(*) FROM conversations WHERE kind='group' AND owner_id=? AND status<>'dissolved'",
            (row["id"],),
        ).fetchone()[0]
        used = conn.execute(
            "SELECT COALESCE(SUM(quota_bytes),0) FROM attachments WHERE owner_id=? AND state NOT IN('reserved','uploading')",
            (row["id"],),
        ).fetchone()[0]
        return identity(conn, row["id"]) | {
            "bio": row["bio"],
            "siteRole": row["site_role"],
            "status": row["status"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "deletionAt": row["deletion_at"],
            "lastSeenAt": sessions[0],
            "sessionCount": int(sessions[1] or 0)
            if row["status"] == "active" and not row["must_change_password"]
            else 0,
            "ownedGroupCount": owned,
            "storageBytes": used,
            "quotaBytes": row["quota_bytes"]
            if row["quota_bytes"] is not None
            else self.runtime.policy.get(conn)["user_quota_bytes"],
            "mutedUntil": row["muted_until"],
            "statusReason": row["status_reason"],
            "muteReason": row["mute_reason"],
            "restrictionReason": row["restriction_reason"],
            "uploadDisabled": bool(row["upload_disabled"]),
            "groupCreationDisabled": bool(row["group_creation_disabled"]),
            "mustChangePassword": bool(row["must_change_password"]),
            "hasSecondFactor": bool(row["totp_secret"]),
            "version": row["admin_version"],
        }

    def users(self, actor, *, query="", status="", role="", sort="newest", after="", limit=50):
        if (
            len(query) > 80
            or status not in ("", "active", "banned", "deleting", "deleted")
            or role not in ("", "user", "super_admin")
            or sort not in ("newest", "oldest", "username")
        ):
            raise APIError("VALIDATION_ERROR", "用户筛选或排序无效。", 422)
        clauses, args = ["1=1"], []
        if query:
            clauses.append("(username LIKE ? ESCAPE '\\' OR nickname LIKE ? ESCAPE '\\')")
            escaped = (
                "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            )
            args.extend([escaped, escaped])
        for key, value in (("status", status), ("site_role", role)):
            if value:
                clauses.append(key + "=?")
                args.append(value)
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            where = " AND ".join(clauses)
            total = conn.execute("SELECT COUNT(*) FROM users WHERE " + where, args).fetchone()[0]
            marker = cursor(after, 2)
            field, direction, relation = (
                ("username", "ASC", ">")
                if sort == "username"
                else (
                    "created_at",
                    "DESC" if sort == "newest" else "ASC",
                    "<" if sort == "newest" else ">",
                )
            )
            if marker:
                where += f" AND ({field},id){relation}(?,?)"
                args += marker
            rows = conn.execute(
                f"SELECT * FROM users WHERE {where} ORDER BY {field} {direction},id {direction} LIMIT ?",
                [*args, limit + 1],
            ).fetchall()
            return page(
                rows,
                total,
                limit,
                lambda row: self.user_view(conn, row),
                key=lambda row: [row[field], row["id"]],
            )

    def user_detail(self, actor, uid):
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
            if not row:
                raise unavailable()
            return {
                "user": self.user_view(conn, row),
                "ownedGroups": self.groups_in(conn, owner=uid, limit=20),
            }

    def inspect_user(self, conn, action, uid, parameters):
        row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not row or row["status"] == "deleted":
            raise unavailable()
        if action == "user.restore":
            if (
                row["status"] != "deleting"
                or not row["deletion_at"]
                or row["deletion_at"] <= now_ms()
            ):
                raise conflict("只能恢复尚在冷静期内的注销账号。")
        elif action == "user.unban":
            if row["status"] != "banned":
                raise conflict("目标当前未被封禁。")
        elif action != "user.logout_all" and row["status"] != "active":
            raise conflict("此操作要求目标账号处于可用状态。")
        if action in ("user.ban", "user.password_reset"):
            last_admin_guard(conn, row)
        snapshot = {
            key: row[key]
            for key in (
                "id",
                "admin_version",
                "status",
                "site_role",
                "muted_until",
                "deletion_at",
                "upload_disabled",
                "group_creation_disabled",
                "must_change_password",
            )
        }
        return snapshot, f"{row['nickname']}（{row['username']}）", row["status"]

    def revoke_user_sessions(self, conn, uid):
        conn.execute(
            "UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL",
            (now_ms(), uid),
        )
        conn.execute(
            "DELETE FROM reauth_tokens WHERE session_id IN(SELECT id FROM sessions WHERE user_id=?)",
            (uid,),
        )

    def apply_user(self, conn, command, uid, parameters):
        action, stamp = command["action"], now_ms()
        self.inspect_user(conn, action, uid, parameters)
        changes = {}
        if action == "user.ban":
            changes = {"status": "banned", "status_reason": command["reason"]}
        elif action == "user.unban":
            changes = {"status": "active", "status_reason": ""}
        elif action == "user.mute":
            changes = {"muted_until": parameters["until"], "mute_reason": command["reason"]}
        elif action == "user.unmute":
            changes = {"muted_until": None, "mute_reason": ""}
        elif action == "user.restrict":
            changes = {
                "upload_disabled": int(parameters["uploadDisabled"]),
                "group_creation_disabled": int(parameters["groupCreationDisabled"]),
                "restriction_reason": command["reason"],
            }
        elif action == "user.restore":
            changes = {"status": "active", "deletion_at": None, "status_reason": ""}
        elif action == "user.password_reset":
            changes = {"must_change_password": 1}
            credential = secrets.token_urlsafe(32)
            expiry = stamp + 3600000
            conn.execute("DELETE FROM reset_credentials WHERE user_id=?", (uid,))
            conn.execute(
                "INSERT INTO reset_credentials(digest,user_id,issued_by,expires_at,consumed_at,created_at) VALUES(?,?,?,?,NULL,?)",
                (
                    self.runtime.auth.security.digest(credential, "manual-reset"),
                    uid,
                    command["actor_id"],
                    expiry,
                    stamp,
                ),
            )
            self.secrets.set(
                command["id"],
                {
                    "credential": credential,
                    "expiresAt": expiry,
                    "username": identity(conn, uid)["username"],
                    "actorId": command["actor_id"],
                    "sessionId": command["session_id"],
                },
            )
        if action in ("user.ban", "user.logout_all", "user.password_reset", "user.restore"):
            self.revoke_user_sessions(conn, uid)
        if changes:
            conn.execute(
                "UPDATE users SET "
                + ",".join(key + "=?" for key in changes)
                + ",updated_at=?,admin_version=admin_version+1 WHERE id=?",
                [*changes.values(), stamp, uid],
            )
        self.runtime.events.user_changed(conn, uid)
        self.runtime.events.notify(conn, uid, "account.restriction", uid, command["actor_id"])
        return "已完成，当前账号权限与设备会话已重新计算。"
