from __future__ import annotations

import hmac
import json
import secrets
import sqlite3
from dataclasses import dataclass
from http.cookies import SimpleCookie

from tongpin.contracts.base import APIError
from tongpin.domain.security import (
    Security,
    audit,
    clean_text,
    identifier,
    validate_password,
    validate_username,
)
from tongpin.infra.db import now_ms

DAY = 86400000


@dataclass
class Principal:
    user: dict
    session: dict

    @property
    def id(self):
        return self.user["id"]


def public_user(user):
    return {
        "id": user["id"],
        "username": user["username"],
        "nickname": user["nickname"],
        "bio": user["bio"],
        "siteRole": user["site_role"],
        "status": user["status"],
        "createdAt": user["created_at"],
        "preferences": json.loads(user["preferences"]),
    }


class AuthService:
    def __init__(self, runtime):
        self.runtime = runtime
        self.security = Security(runtime)

    @property
    def cookie_name(self):
        return "__Host-tp_session" if self.runtime.settings.production else "tp_session"

    @property
    def flow_cookie_name(self):
        return "__Host-tp_flow" if self.runtime.settings.production else "tp_flow"

    def cookie_from(self, header):
        cookie = SimpleCookie()
        try:
            cookie.load(header)
            return cookie[self.cookie_name].value if self.cookie_name in cookie else ""
        except (ValueError, KeyError):
            return ""

    def load(self, token, touch=True):
        if not token or len(token) > 128:
            raise APIError("AUTH_REQUIRED", "请先登录，或重新登录已过期的会话。", 401)
        return self.load_hash(self.security.digest(token), touch=touch)

    def load_hash(self, token_hash, touch=True):
        now = now_ms()
        with self.runtime.db.read() as conn:
            session = conn.execute(
                "SELECT * FROM sessions WHERE token_hash=?", (token_hash,)
            ).fetchone()
            user = (
                conn.execute("SELECT * FROM users WHERE id=?", (session["user_id"],)).fetchone()
                if session
                else None
            )
        if (
            not session
            or not user
            or user["status"] != "active"
            or session["revoked_at"] is not None
            or session["expires_at"] <= now
            or session["last_seen_at"] + session["idle_ms"] <= now
        ):
            raise APIError("AUTH_REQUIRED", "登录已失效，请重新登录。", 401)
        if touch and session["last_seen_at"] < now - 60000:
            with self.runtime.db.write() as conn:
                conn.execute(
                    "UPDATE sessions SET last_seen_at=? WHERE id=? AND revoked_at IS NULL",
                    (now, session["id"]),
                )
        return Principal(dict(user), dict(session))

    def require_admin(self, principal):
        if (
            principal.user["site_role"] != "super_admin"
            or not principal.session["second_factor_at"]
            or not principal.user["totp_secret"]
        ):
            raise APIError("FORBIDDEN", "此操作需要已完成第二因素验证的全站管理员。", 403)
        return principal

    def current_in_transaction(self, conn, principal, admin=False):
        # Repeat authorization after acquiring the writer lock, closing revocation races.
        row = conn.execute(
            "SELECT * FROM sessions WHERE id=?", (principal.session["id"],)
        ).fetchone()
        user = conn.execute("SELECT * FROM users WHERE id=?", (principal.id,)).fetchone()
        now = now_ms()
        if (
            not row
            or not user
            or user["status"] != "active"
            or row["revoked_at"] is not None
            or row["expires_at"] <= now
            or row["last_seen_at"] + row["idle_ms"] <= now
        ):
            raise APIError("AUTH_REQUIRED", "登录已失效，请重新登录。", 401)
        result = Principal(dict(user), dict(row))
        return self.require_admin(result) if admin else result

    def create_user(
        self, conn, username, nickname, password_hash, *, site_role="user", totp_secret=None
    ):
        uid = identifier("u_")
        created = now_ms()
        try:
            conn.execute(
                "INSERT INTO users(id,username,nickname,password_hash,site_role,totp_secret,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                (uid, username, nickname, password_hash, site_role, totp_secret, created, created),
            )
        except sqlite3.IntegrityError as error:
            raise APIError(
                "USERNAME_UNAVAILABLE",
                "此登录名已使用，请换一个。",
                409,
                {"username": "此登录名不可用。"},
            ) from error
        return conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()

    def issue_session(self, conn, user, remember, device, factor=False):
        raw = secrets.token_urlsafe(32)
        now, sid = now_ms(), identifier("ses_")
        expiry = now + (30 if remember else 7) * DAY
        conn.execute(
            "INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,NULL)",
            (
                sid,
                self.security.digest(raw),
                user["id"],
                now,
                now,
                expiry,
                (7 if remember else 1) * DAY,
                device[:200],
                now if factor else None,
            ),
        )
        # Keep a finite number of live devices; callers see every revocation in the list/audit.
        stale = [
            row["id"]
            for row in conn.execute(
                "SELECT id FROM sessions WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET 20",
                (user["id"],),
            )
        ]
        if stale:
            conn.executemany(
                "UPDATE sessions SET revoked_at=? WHERE id=?", [(now, item) for item in stale]
            )
        return raw, {
            "user": public_user(user),
            "csrfToken": self.security.csrf(raw),
            "expiresAt": expiry,
        }

    def register(self, data, flow, ip, device):
        self.security.rate("register", ip, 20, 3600)
        self.security.consume_captcha(flow, data.captchaId, data.captchaAnswer)
        username = validate_username(data.username)
        nickname = clean_text(data.nickname, 1, 32, "nickname")
        validate_password(data.password)
        password_hash = self.security.passwords.hash(data.password)
        with self.runtime.db.write() as conn:
            policy = self.runtime.policy.get(conn)
            if not data.acceptTerms or data.termsVersion != policy["terms_version"]:
                raise APIError("TERMS_REQUIRED", "请阅读并同意当前版本的用户说明。", 422)
            mode = policy["registration_mode"]
            if mode == "closed":
                raise APIError("REGISTRATION_CLOSED", "本站暂未开放注册。", 403)
            if mode == "invite-only":
                used = conn.execute(
                    "UPDATE site_invites SET used=used+1 WHERE digest=? AND revoked_at IS NULL AND expires_at>? AND used<max_uses",
                    (self.security.digest(data.siteInvite, "site_invite"), now_ms()),
                )
                if used.rowcount != 1:
                    raise APIError(
                        "SITE_INVITE_INVALID", "站点邀请码无效、已过期或名额已用完。", 403
                    )
            user = self.create_user(conn, username, nickname, password_hash)
            codes = self.security.recovery_codes(conn, user["id"])
            token, result = self.issue_session(conn, user, False, device)
            audit(conn, user["id"], "account.register", user["id"], device=device)
        return token, result | {"recoveryCodes": codes}

    def login(self, data, flow, ip, device, old_token=""):
        self.security.rate("login-ip", ip, 100, 900)
        self.security.rate("login-user", data.username.lower(), 15, 900)
        self.security.consume_captcha(flow, data.captchaId, data.captchaAnswer)
        with self.runtime.db.read() as conn:
            user = conn.execute(
                "SELECT * FROM users WHERE username=? COLLATE NOCASE", (data.username,)
            ).fetchone()
        verified = self.security.verify_password(
            user["password_hash"] if user else None, data.password
        )
        if not verified or not user or user["status"] != "active":
            with self.runtime.db.write() as conn:
                audit(
                    conn,
                    None,
                    "account.login",
                    user["id"] if user else None,
                    result="denied",
                    device=device,
                )
            raise APIError("LOGIN_FAILED", "登录名、密码或账号状态不正确。", 401)
        with self.runtime.db.write() as conn:
            current = conn.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
            if current["password_hash"] != user["password_hash"] or current["status"] != "active":
                raise APIError("LOGIN_FAILED", "登录名、密码或账号状态不正确。", 401)
            if data.admin and current["site_role"] != "super_admin":
                raise APIError("FORBIDDEN", "此账号没有全站管理权限。", 403)
            factor = current["site_role"] == "super_admin"
            if factor:
                self.security.second_factor(conn, current, data.secondFactor)
            if self.security.passwords.check_needs_rehash(user["password_hash"]):
                conn.execute(
                    "UPDATE users SET password_hash=? WHERE id=?",
                    (self.security.passwords.hash(data.password), user["id"]),
                )
            if old_token:
                conn.execute(
                    "UPDATE sessions SET revoked_at=? WHERE token_hash=?",
                    (now_ms(), self.security.digest(old_token)),
                )
            token, result = self.issue_session(conn, current, data.remember, device, factor=factor)
            audit(conn, user["id"], "account.login", user["id"], device=device)
        self.runtime.revalidate_connections()
        return token, result

    def recover(self, data, flow, ip, device):
        self.security.rate("recover-ip", ip, 30, 3600)
        self.security.rate("recover-user", data.username.lower(), 10, 3600)
        self.security.consume_captcha(flow, data.captchaId, data.captchaAnswer)
        validate_password(data.password)
        new_hash = self.security.passwords.hash(data.password)
        with self.runtime.db.write() as conn:
            user = conn.execute(
                "SELECT * FROM users WHERE username=? COLLATE NOCASE", (data.username,)
            ).fetchone()
            if (
                not user
                or user["status"] not in {"active", "deleting"}
                or not self.security.consume_recovery(conn, user["id"], data.recoveryCode)
            ):
                raise APIError("RECOVERY_FAILED", "登录名或恢复凭据无效。", 401)
            if user["site_role"] == "super_admin":
                self.security.second_factor(conn, user, data.secondFactor)
            if (
                user["status"] == "deleting"
                and user["deletion_at"] is not None
                and user["deletion_at"] <= now_ms()
            ):
                raise APIError("RECOVERY_FAILED", "恢复期限已结束，请联系运营者。", 401)
            conn.execute(
                "UPDATE users SET password_hash=?,status='active',deletion_at=NULL,updated_at=? WHERE id=?",
                (new_hash, now_ms(), user["id"]),
            )
            conn.execute(
                "UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL",
                (now_ms(), user["id"]),
            )
            conn.execute(
                "DELETE FROM reauth_tokens WHERE session_id IN (SELECT id FROM sessions WHERE user_id=?)",
                (user["id"],),
            )
            audit(conn, user["id"], "account.recover", user["id"], device=device)
        self.runtime.revalidate_connections()
        return {"recovered": True}

    def logout(self, principal):
        with self.runtime.db.write() as conn:
            conn.execute(
                "UPDATE sessions SET revoked_at=? WHERE id=?", (now_ms(), principal.session["id"])
            )
            audit(conn, principal.id, "account.logout", principal.id)
        self.runtime.revalidate_connections()
        return {"loggedOut": True}

    def reauth(self, principal, data):
        self.security.rate("reauth", principal.id, 30, 900)
        if not self.security.verify_password(principal.user["password_hash"], data.password):
            raise APIError("REAUTH_FAILED", "身份验证失败，请检查密码。", 401)
        token = secrets.token_urlsafe(32)
        expiry = now_ms() + 300000
        with self.runtime.db.write() as conn:
            current = self.current_in_transaction(conn, principal)
            if current.user["password_hash"] != principal.user["password_hash"]:
                raise APIError("REAUTH_FAILED", "凭据已更新，请重新登录。", 401)
            if current.user["site_role"] == "super_admin":
                self.security.second_factor(conn, current.user, data.secondFactor)
            conn.execute("DELETE FROM reauth_tokens WHERE expires_at<?", (now_ms(),))
            conn.execute(
                "INSERT INTO reauth_tokens VALUES(?,?,?,?,NULL)",
                (
                    self.security.digest(token, "reauth"),
                    principal.session["id"],
                    data.action,
                    expiry,
                ),
            )
            audit(
                conn,
                principal.id,
                "account.reauthenticate",
                principal.id,
                details={"action": data.action},
            )
        return {"reauthToken": token, "expiresAt": expiry}

    def consume_reauth(self, conn, principal, token, action, admin=False):
        current = self.current_in_transaction(conn, principal, admin=admin)
        used = conn.execute(
            "UPDATE reauth_tokens SET consumed_at=? WHERE digest=? AND session_id=? AND action=? AND expires_at>? AND consumed_at IS NULL",
            (
                now_ms(),
                self.security.digest(token, "reauth"),
                current.session["id"],
                action,
                now_ms(),
            ),
        )
        if used.rowcount != 1:
            raise APIError("REAUTH_REQUIRED", "请重新验证身份后再执行此操作。", 403)
        return current

    def sessions(self, principal):
        with self.runtime.db.read() as conn:
            rows = conn.execute(
                "SELECT * FROM sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at>? AND last_seen_at+idle_ms>? ORDER BY created_at DESC LIMIT 20",
                (principal.id, now_ms(), now_ms()),
            ).fetchall()
        return {
            "items": [
                {
                    "id": r["id"],
                    "device": r["device"],
                    "createdAt": r["created_at"],
                    "lastSeenAt": r["last_seen_at"],
                    "expiresAt": r["expires_at"],
                    "current": r["id"] == principal.session["id"],
                }
                for r in rows
            ]
        }

    def revoke_session(self, principal, sid, token):
        with self.runtime.db.write() as conn:
            self.consume_reauth(conn, principal, token, "revoke_session:" + sid)
            found = conn.execute(
                "UPDATE sessions SET revoked_at=? WHERE id=? AND user_id=?",
                (now_ms(), sid, principal.id),
            )
            if found.rowcount != 1:
                raise APIError("RESOURCE_UNAVAILABLE", "此设备会话不存在。", 404)
            audit(
                conn,
                principal.id,
                "account.revoke_session",
                principal.id,
                details={"sessionId": sid},
            )
        self.runtime.revalidate_connections()
        return {"revoked": True}

    def change_password(self, principal, data):
        validate_password(data.password)
        new_hash = self.security.passwords.hash(data.password)
        with self.runtime.db.write() as conn:
            self.consume_reauth(conn, principal, data.reauthToken, "change_password")
            conn.execute(
                "UPDATE users SET password_hash=?,updated_at=? WHERE id=?",
                (new_hash, now_ms(), principal.id),
            )
            conn.execute(
                "UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL",
                (now_ms(), principal.id),
            )
            audit(conn, principal.id, "account.change_password", principal.id)
        self.runtime.revalidate_connections()
        return {"changed": True}

    def regenerate_codes(self, principal, token):
        with self.runtime.db.write() as conn:
            self.consume_reauth(conn, principal, token, "recovery_codes")
            codes = self.security.recovery_codes(conn, principal.id)
            audit(conn, principal.id, "account.regenerate_recovery", principal.id)
        return {"recoveryCodes": codes}

    def profile(self, principal, data):
        nickname, bio = (
            clean_text(data.nickname, 1, 32, "nickname"),
            clean_text(data.bio, 0, 200, "bio"),
        )
        with self.runtime.db.write() as conn:
            self.current_in_transaction(conn, principal)
            conn.execute(
                "UPDATE users SET nickname=?,bio=?,updated_at=? WHERE id=?",
                (nickname, bio, now_ms(), principal.id),
            )
            self.runtime.events.user_changed(conn, principal.id)
            user = conn.execute("SELECT * FROM users WHERE id=?", (principal.id,)).fetchone()
        return {"user": public_user(user)}

    def preferences(self, principal, data):
        with self.runtime.db.write() as conn:
            current = self.current_in_transaction(conn, principal)
            prefs = json.loads(current.user["preferences"])
            prefs.update(data.model_dump(exclude_none=True))
            conn.execute(
                "UPDATE users SET preferences=?,updated_at=? WHERE id=?",
                (json.dumps(prefs), now_ms(), principal.id),
            )
            self.runtime.events.user_changed(conn, principal.id)
            user = conn.execute("SELECT * FROM users WHERE id=?", (principal.id,)).fetchone()
        self.runtime.presence_changed(principal.id)
        return {"user": public_user(user)}

    def security_events(self, principal):
        with self.runtime.db.read() as conn:
            rows = conn.execute(
                "SELECT id,action,created_at,device,result FROM audit_events WHERE subject_id=? AND (action LIKE 'account.%' OR action LIKE 'admin.user%') ORDER BY id DESC LIMIT 50",
                (principal.id,),
            ).fetchall()
        return {
            "items": [
                {
                    "id": str(r["id"]),
                    "action": r["action"],
                    "createdAt": r["created_at"],
                    "device": r["device"],
                    "result": r["result"],
                }
                for r in rows
            ]
        }

    def websocket_ticket(self, principal):
        token = secrets.token_urlsafe(32)
        self.security.tickets.set(
            self.security.digest(token, "ticket"), {"tokenHash": principal.session["token_hash"]}
        )
        return {"ticket": token, "expiresAt": now_ms() + 60000}

    def authorize_ticket(self, token, cookie):
        ticket = self.security.tickets.get(self.security.digest(token, "ticket"))
        if not ticket or not hmac.compare_digest(ticket["tokenHash"], self.security.digest(cookie)):
            raise APIError("AUTH_REQUIRED", "实时连接认证失败。", 401)
        result = self.security.tickets.consume(
            self.security.digest(token, "ticket"), lambda _: True
        )
        if result is not True:
            raise APIError("AUTH_REQUIRED", "实时连接凭据已消费。", 401)
        return self.load(cookie)

    def authorize_upload_scope(self, scope):
        headers = {
            k.decode("latin1").lower(): v.decode("latin1") for k, v in scope.get("headers", [])
        }
        token = self.cookie_from(headers.get("cookie", ""))
        principal = self.load(token)
        if headers.get("origin") not in self.runtime.settings.origins or not hmac.compare_digest(
            headers.get("x-csrf-token", ""), self.security.csrf(token)
        ):
            raise APIError("CSRF_REJECTED", "上传请求验证失败，请刷新后重试。", 403)
        return principal
