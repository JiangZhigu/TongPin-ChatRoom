from __future__ import annotations

from tongpin.admin.authz import conflict, cursor, identity, last_admin_guard, page, unavailable
from tongpin.contracts.base import APIError
from tongpin.domain.auth import public_user
from tongpin.domain.security import (
    audit,
    clean_text,
    identifier,
    validate_password,
    validate_username,
)
from tongpin.infra.db import now_ms


class AdministratorsAdmin:
    def administrator_view(self, conn, row):
        devices = conn.execute(
            "SELECT COUNT(*),MAX(last_seen_at) FROM sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at>? AND last_seen_at+idle_ms>?",
            (row["id"], now_ms(), now_ms()),
        ).fetchone()
        return {
            "user": identity(conn, row["id"]),
            "status": row["status"],
            "usable": row["status"] == "active"
            and not row["must_change_password"],
            "hasSecondFactor": False,
            "sessionCount": devices[0],
            "lastSeenAt": devices[1],
            "version": row["admin_version"],
        }

    @staticmethod
    def admin_invitation_view(conn, row):
        return {
            "id": row["id"],
            "user": identity(conn, row["user_id"]),
            "inviter": identity(conn, row["inviter_id"]),
            "purpose": row["purpose"],
            "status": "expired"
            if row["status"] == "pending" and row["expires_at"] <= now_ms()
            else row["status"],
            "createdAt": row["created_at"],
            "expiresAt": row["expires_at"],
        }

    def administrators(self, actor, *, after="", limit=50):
        boundary = cursor(after)
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            total = conn.execute(
                "SELECT COUNT(*) FROM users WHERE site_role='super_admin'"
            ).fetchone()[0]
            rows = conn.execute(
                "SELECT * FROM users WHERE site_role='super_admin' AND (?='' OR id>?) ORDER BY id LIMIT ?",
                (boundary[0] if boundary else "", boundary[0] if boundary else "", limit + 1),
            ).fetchall()
            return {
                "administrators": page(
                    rows, total, limit, lambda row: self.administrator_view(conn, row)
                ),
                "invitations": [
                    self.admin_invitation_view(conn, row)
                    for row in conn.execute(
                        "SELECT * FROM administrator_invitations ORDER BY created_at DESC,id DESC LIMIT 100"
                    )
                ],
            }

    def inspect_administrator(self, conn, action, target, parameters):
        if action == "administrator.cancel":
            invitation = conn.execute(
                "SELECT * FROM administrator_invitations WHERE id=?", (target,)
            ).fetchone()
            if not invitation:
                raise unavailable()
            if invitation["status"] != "pending" or invitation["expires_at"] <= now_ms():
                raise conflict("此管理员邀请已处理或已到期。")
            return dict(invitation), "管理员绑定邀请", "取消尚未完成的邀请及其绑定挑战。"
        user = conn.execute("SELECT * FROM users WHERE id=?", (target,)).fetchone()
        if not user:
            raise unavailable()
        if user["status"] != "active" or user["must_change_password"]:
            raise conflict("请先恢复账号可用状态并完成密码重置。")
        pending = conn.execute(
            "SELECT id FROM administrator_invitations WHERE user_id=? AND status='pending' AND expires_at>?",
            (target, now_ms()),
        ).fetchone()
        if action == "administrator.invite":
            if user["site_role"] != "user" or pending:
                raise conflict("目标已有站点权限或待完成的管理员邀请。")
            detail = "24小时内由本人验证当前密码并接受邀请，完成后才授予站点权限。"
        else:
            if user["site_role"] != "super_admin":
                raise conflict("目标当前不是超级管理员。")
            last_admin_guard(conn, user)
            detail = "撤销当前站点权限、第二因素和旧设备授权，保留普通账号。"
            if action == "administrator.factor_reset":
                detail += "人工核验后发出本人重新绑定邀请。"
        return (
            {
                "id": target,
                "version": user["admin_version"],
                "role": user["site_role"],
                "status": user["status"],
                "passwordReset": user["must_change_password"],
                "factor": bool(user["totp_secret"]),
                "pending": pending[0] if pending else None,
            },
            user["nickname"] + " · " + user["username"],
            detail,
        )

    def revoke_administrator_in(self, conn, uid):
        conn.execute(
            "UPDATE users SET site_role='user',totp_secret=NULL,totp_last_counter=-1,admin_version=admin_version+1,updated_at=? WHERE id=?",
            (now_ms(), uid),
        )
        conn.execute("DELETE FROM recovery_codes WHERE user_id=? AND kind='second_factor'", (uid,))
        conn.execute(
            "DELETE FROM reauth_tokens WHERE session_id IN(SELECT id FROM sessions WHERE user_id=?)",
            (uid,),
        )
        conn.execute(
            "UPDATE sessions SET revoked_at=COALESCE(revoked_at,?) WHERE user_id=?", (now_ms(), uid)
        )
        conn.execute(
            "UPDATE administrator_invitations SET status='cancelled',version=version+1 WHERE (user_id=? OR inviter_id=?) AND status='pending'",
            (uid, uid),
        )
        conn.execute(
            "DELETE FROM administrator_enrollments WHERE invitation_id IN(SELECT id FROM administrator_invitations WHERE user_id=? OR inviter_id=?)",
            (uid, uid),
        )

    def apply_administrator(self, conn, command, target, parameters):
        action = command["action"]
        if action == "administrator.cancel":
            conn.execute(
                "UPDATE administrator_invitations SET status='cancelled',version=version+1 WHERE id=?",
                (target,),
            )
            conn.execute("DELETE FROM administrator_enrollments WHERE invitation_id=?", (target,))
            return "绑定邀请已取消，旧绑定挑战立即失效。"
        if action == "administrator.factor_reset" and target == command["actor_id"]:
            raise APIError(
                "SELF_FACTOR_RESET", "本人第二因素恢复请使用恢复码或由另一名管理员核验处理。", 409
            )
        if action in ("administrator.revoke", "administrator.factor_reset"):
            self.revoke_administrator_in(conn, target)
        if action in ("administrator.invite", "administrator.factor_reset"):
            conn.execute(
                "UPDATE administrator_invitations SET status='expired',version=version+1 WHERE user_id=? AND status='pending' AND expires_at<=?",
                (target, now_ms()),
            )
            iid = identifier("adm_")
            conn.execute(
                "INSERT INTO administrator_invitations(id,user_id,inviter_id,purpose,status,created_at,expires_at) VALUES(?,?,?,?,'pending',?,?)",
                (
                    iid,
                    target,
                    command["actor_id"],
                    "grant" if action == "administrator.invite" else "factor_reset",
                    now_ms(),
                    now_ms() + 86400000,
                ),
            )
            self.runtime.events.notify(conn, target, "administrator.invited", iid)
        self.runtime.events.user_changed(conn, target)
        audit(
            conn,
            command["actor_id"],
            "admin.user.administrator_changed",
            target,
            reason=command["reason"],
            details={
                "operationId": command["id"],
                "requestId": command["request_id"],
                "action": action,
            },
        )
        return "站点权限与设备授权已更新。绑定邀请须由本人在账号与安全中完成。"

    @staticmethod
    def pending_enrollment(conn, uid):
        return conn.execute(
            "SELECT i.* FROM administrator_invitations i JOIN users u ON u.id=i.inviter_id WHERE i.user_id=? AND i.status='pending' AND i.expires_at>? AND u.status='active' AND u.site_role='super_admin' AND u.must_change_password=0 ORDER BY i.created_at DESC LIMIT 1",
            (uid, now_ms()),
        ).fetchone()

    def enrollment_status(self, actor):
        with self.runtime.db.read() as conn:
            actor = self.runtime.auth.current_in_transaction(conn, actor)
            invite = (
                self.pending_enrollment(conn, actor.id)
                if actor.user["site_role"] == "user"
                else None
            )
            return {
                "invitation": {
                    "id": invite["id"],
                    "purpose": invite["purpose"],
                    "expiresAt": invite["expires_at"],
                    "inviter": identity(conn, invite["inviter_id"]),
                }
                if invite
                else None
            }

    def enrollment_start(self, actor, data):
        self.runtime.auth.security.rate("administrator-enroll-start", actor.id, 5, 900)
        with self.runtime.db.write() as conn:
            actor = self.runtime.auth.current_in_transaction(conn, actor)
            invite = self.pending_enrollment(conn, actor.id)
            if not invite or actor.user["site_role"] != "user":
                raise unavailable()
            self.runtime.auth.consume_reauth(conn, actor, data.reauthToken, "administrator.enroll")
            eid = identifier("enr_")
            expiry = min(invite["expires_at"], now_ms() + 600000)
            conn.execute(
                "DELETE FROM administrator_enrollments WHERE expires_at<=? OR invitation_id=?",
                (now_ms(), invite["id"]),
            )
            conn.execute(
                "INSERT INTO administrator_enrollments VALUES(?,?,?,?,?)",
                (
                    eid,
                    invite["id"],
                    actor.session["id"],
                    "",
                    expiry,
                ),
            )
            audit(
                conn,
                actor.id,
                "account.admin_enrollment.start",
                actor.id,
                details={"invitationId": invite["id"]},
            )
            return {
                "enrollmentId": eid,
                "expiresAt": expiry,
            }

    def enrollment_finish(self, actor, data):
        self.runtime.auth.security.rate("administrator-enroll-verify", actor.id, 10, 900)
        with self.runtime.db.write() as conn:
            actor = self.runtime.auth.current_in_transaction(conn, actor)
            invite = self.pending_enrollment(conn, actor.id)
            challenge = conn.execute(
                "SELECT * FROM administrator_enrollments WHERE id=? AND session_id=? AND expires_at>?",
                (data.enrollmentId, actor.session["id"], now_ms()),
            ).fetchone()
            if (
                not invite
                or not challenge
                or challenge["invitation_id"] != invite["id"]
                or actor.user["site_role"] != "user"
            ):
                raise APIError(
                    "ENROLLMENT_EXPIRED", "绑定请求已失效或已处理，请重新核对管理员邀请。", 409
                )
            conn.execute(
                "UPDATE users SET site_role='super_admin',totp_secret=NULL,totp_last_counter=-1,admin_version=admin_version+1,updated_at=? WHERE id=?",
                (now_ms(), actor.id),
            )
            conn.execute(
                "UPDATE sessions SET revoked_at=COALESCE(revoked_at,?) WHERE user_id=? AND id<>?",
                (now_ms(), actor.id, actor.session["id"]),
            )
            conn.execute(
                "UPDATE sessions SET second_factor_at=NULL WHERE id=?", (actor.session["id"],)
            )
            conn.execute(
                "DELETE FROM reauth_tokens WHERE session_id IN(SELECT id FROM sessions WHERE user_id=?)",
                (actor.id,),
            )
            conn.execute("DELETE FROM recovery_codes WHERE user_id=?", (actor.id,))
            conn.execute(
                "UPDATE administrator_invitations SET status='accepted',version=version+1 WHERE id=?",
                (invite["id"],),
            )
            conn.execute(
                "DELETE FROM administrator_enrollments WHERE invitation_id=?", (invite["id"],)
            )
            user = conn.execute("SELECT * FROM users WHERE id=?", (actor.id,)).fetchone()
            audit(
                conn,
                actor.id,
                "account.admin_enrollment.complete",
                actor.id,
                details={
                    "invitationId": invite["id"],
                    "authorizedBy": invite["inviter_id"],
                    "siteRole": "super_admin",
                },
            )
            self.runtime.events.user_changed(conn, actor.id)
            result = {"user": public_user(user)}
        self.runtime.revalidate_connections()
        return result

    def recover_local_administrator(self, username, password, reason):
        # Only the offline maintenance entry initializes without an async server
        # loop. Its exclusive DATA_DIR lock must already be held.
        if self.runtime.loop is not None or self.runtime.lock._lock is None:
            raise RuntimeError("Administrator host recovery requires offline exclusive maintenance")
        username = validate_username(username)
        reason = clean_text(reason, 5, 1000, "reason")
        validate_password(password)
        password_hash = self.runtime.auth.security.passwords.hash(password)
        with self.runtime.db.write() as conn:
            user = conn.execute(
                "SELECT * FROM users WHERE username=? COLLATE NOCASE AND site_role='super_admin' AND status IN('active','banned')",
                (username,),
            ).fetchone()
            if not user:
                raise ValueError(
                    "Only an existing non-deleted administrator can be recovered locally"
                )
            self.revoke_administrator_in(conn, user["id"])
            conn.execute(
                "UPDATE users SET password_hash=?,totp_secret=NULL,totp_last_counter=-1,site_role='super_admin',status='active',status_reason='',must_change_password=0,updated_at=? WHERE id=?",
                (password_hash, now_ms(), user["id"]),
            )
            conn.execute("DELETE FROM reset_credentials WHERE user_id=?", (user["id"],))
            conn.execute("DELETE FROM recovery_codes WHERE user_id=?", (user["id"],))
            audit(
                conn,
                None,
                "admin.user.host_recovery",
                user["id"],
                reason=reason,
                details={
                    "hostMaintenance": True,
                    "sessionsRevoked": True,
                    "passwordOnly": True,
                },
            )
        return {"recovered": True}
