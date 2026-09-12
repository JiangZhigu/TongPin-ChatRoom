from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import re
import secrets
import unicodedata
from contextlib import contextmanager
from threading import Lock

import pyotp
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from cryptography.fernet import Fernet
from PIL import Image, ImageDraw, ImageFont

from tongpin.contracts.base import APIError
from tongpin.infra.cache import BoundedCache
from tongpin.infra.db import now_ms


def identifier(prefix=""):
    return prefix + secrets.token_urlsafe(18)


def clean_text(value: str, minimum: int, maximum: int, field: str, trim=False):
    if trim:
        value = value.strip()
    if not minimum <= len(value) <= maximum or any(
        unicodedata.category(c) in {"Cc", "Cs"} for c in value
    ):
        raise APIError(
            "VALIDATION_ERROR",
            "请检查输入长度或特殊字符。",
            422,
            {field: f"请输入{minimum}–{maximum}个字符，不能包含控制字符。"},
        )
    if minimum and (not value.strip() or value != value.strip()):
        raise APIError(
            "VALIDATION_ERROR", "输入不能包含首尾空白。", 422, {field: "请去掉首尾空白。"}
        )
    return value


def validate_username(value):
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{3,23}", value):
        raise APIError(
            "VALIDATION_ERROR",
            "登录名格式无效。",
            422,
            {"username": "字母开头，4–24位英文字母、数字或下划线。"},
        )
    return value.lower()


def validate_password(value):
    if not 8 <= len(value) <= 128 or any(unicodedata.category(c) in {"Cc", "Cs"} for c in value):
        raise APIError(
            "VALIDATION_ERROR",
            "密码长度或字符不符合要求。",
            422,
            {"password": "密码应为8–128个字符，不能包含控制字符。"},
        )
    compact = value.casefold().replace(" ", "")
    weak = {
        "password123456789",
        "123456789012345",
        "1234567890123456",
        "qwertyuiopasdfgh",
        "thisisapassword",
        "correcthorsebatterystaple",
    }
    if len(set(compact)) < 6 or compact in weak or re.fullmatch(r"(.{1,6})\1{2,}", compact):
        raise APIError(
            "WEAK_PASSWORD",
            "密码过于常见或重复，请使用更难猜的长密码。",
            422,
            {"password": "请换一个不常见、字符不重复的长密码。"},
        )
    return value


def audit(conn, actor, action, subject=None, reason="", result="success", device="", details=None):
    conn.execute(
        "INSERT INTO audit_events(actor_id,subject_id,action,reason,result,device,details,created_at) VALUES(?,?,?,?,?,?,?,?)",
        (
            actor,
            subject,
            action,
            reason[:1000],
            result,
            device[:200],
            json.dumps(details or {}, ensure_ascii=False),
            now_ms(),
        ),
    )


class Security:
    LOGIN_CAPTCHA_THRESHOLD = 5
    LOGIN_FAILURE_TTL_MS = 15 * 60 * 1000

    def __init__(self, runtime):
        self.runtime = runtime
        self.passwords = PasswordHasher(
            time_cost=3, memory_cost=65536, parallelism=2, hash_len=32, salt_len=16
        )
        self.dummy_hash = self.passwords.hash(secrets.token_urlsafe(32))
        self.captchas = BoundedCache(max_entries=10000, max_bytes=16 * 1024**2, ttl=120)
        self.tickets = BoundedCache(max_entries=10000, max_bytes=4 * 1024**2, ttl=60)
        # A fixed number of locks bounds memory and serializes the threshold check,
        # password verification and counter update for one source/account pair.
        self._login_locks = tuple(Lock() for _ in range(64))
        self.fernet = Fernet(
            base64.urlsafe_b64encode(hashlib.sha256(runtime.secret.encode()).digest())
        )

    def digest(self, value, purpose="token"):
        return hmac.new(
            self.runtime.secret.encode(), (purpose + "\0" + value).encode(), hashlib.sha256
        ).hexdigest()

    def csrf(self, credential):
        return self.digest(credential, "csrf")

    def verify_password(self, digest, password):
        try:
            return self.passwords.verify(digest or self.dummy_hash, password)
        except (VerificationError, InvalidHashError):
            return False

    @contextmanager
    def login_attempt(self, username, ip):
        key = self.digest(json.dumps([ip, username.lower()]), "login-failures")
        with self._login_locks[int(key[:8], 16) % len(self._login_locks)]:
            yield key

    def login_requires_captcha(self, key):
        with self.runtime.db.read() as conn:
            row = conn.execute(
                "SELECT attempts,expires_at FROM rate_buckets WHERE key=?", (key,)
            ).fetchone()
        return bool(row and row["expires_at"] > now_ms()
                    and row["attempts"] >= self.LOGIN_CAPTCHA_THRESHOLD)

    def record_login_failure(self, conn, key):
        now = now_ms()
        conn.execute("DELETE FROM rate_buckets WHERE expires_at<=?", (now,))
        row = conn.execute("SELECT attempts FROM rate_buckets WHERE key=?", (key,)).fetchone()
        if row is None and conn.execute("SELECT COUNT(*) FROM rate_buckets").fetchone()[0] >= 20000:
            raise APIError("TEMPORARY_UNAVAILABLE", "访问频繁，请稍后重试。", 503)
        failures = min(self.LOGIN_CAPTCHA_THRESHOLD, (row["attempts"] if row else 0) + 1)
        conn.execute(
            "INSERT INTO rate_buckets(key,window_start,attempts,expires_at) VALUES(?,?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET attempts=excluded.attempts,expires_at=excluded.expires_at",
            (key, now, failures, now + self.LOGIN_FAILURE_TTL_MS),
        )
        return failures >= self.LOGIN_CAPTCHA_THRESHOLD

    @staticmethod
    def require_login_captcha():
        raise APIError(
            "LOGIN_CAPTCHA_REQUIRED",
            "用户名或密码已连续5次验证失败，请填写图形验证码后重试。",
            401,
        )

    def rate(self, category, key, maximum, seconds):
        now = now_ms()
        digest = self.digest(category + ":" + str(key), "rate")
        denied = False
        with self.runtime.db.write() as conn:
            policy_key = {
                "register": "registration_per_hour",
                "login-ip": "login_ip_per_15m",
                "login-user": "login_user_per_15m",
                "message-send": "message_per_minute",
                "group-create": "group_create_per_hour",
            }.get(category)
            if policy_key:
                maximum = self.runtime.policy.get(conn)[policy_key]
            conn.execute("DELETE FROM rate_buckets WHERE expires_at<?", (now,))
            count = conn.execute("SELECT COUNT(*) FROM rate_buckets").fetchone()[0]
            row = conn.execute("SELECT * FROM rate_buckets WHERE key=?", (digest,)).fetchone()
            if row is None:
                if count >= 20000:
                    raise APIError("TEMPORARY_UNAVAILABLE", "访问频繁，请稍后重试。", 503)
                conn.execute(
                    "INSERT INTO rate_buckets VALUES(?,?,1,?)", (digest, now, now + seconds * 1000)
                )
                expiry = now + seconds * 1000
            else:
                conn.execute("UPDATE rate_buckets SET attempts=attempts+1 WHERE key=?", (digest,))
                denied, expiry = row["attempts"] >= maximum, row["expires_at"]
        if denied:
            raise APIError(
                "RATE_LIMITED",
                "操作过于频繁，请稍后重试。",
                429,
                retry_after_ms=max(1000, expiry - now),
            )

    def new_captcha(self, flow, ip):
        self.rate("captcha", ip, 60, 300)
        challenge = identifier("cap_")
        text = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(6))
        image = Image.new("RGB", (232, 78), "#edf5fc")
        draw = ImageDraw.Draw(image)
        for _ in range(12):
            draw.line(
                [
                    (secrets.randbelow(232), secrets.randbelow(78)),
                    (secrets.randbelow(232), secrets.randbelow(78)),
                ],
                fill=(145 + secrets.randbelow(50), 175 + secrets.randbelow(50), 215),
                width=1,
            )
        font = ImageFont.load_default(size=34)
        for index, char in enumerate(text):
            draw.text(
                (13 + index * 35, 14 + secrets.randbelow(12)),
                char,
                fill=(30, 64 + secrets.randbelow(35), 95),
                font=font,
            )
        output = io.BytesIO()
        image.save(output, format="PNG")
        self.captchas.set(
            self.digest(flow, "flow"),
            {"id": challenge, "answer": self.digest(text, "captcha"), "attempts": 5},
        )
        return {
            "captchaId": challenge,
            "image": "data:image/png;base64," + base64.b64encode(output.getvalue()).decode(),
            "expiresAt": now_ms() + 120000,
        }

    def consume_captcha(self, flow, challenge, answer):
        def consume(value):
            if value["id"] != challenge or value["attempts"] <= 0:
                return False
            value["attempts"] -= 1
            return hmac.compare_digest(
                value["answer"], self.digest(answer.strip().upper(), "captcha")
            )

        valid = self.captchas.consume(self.digest(flow, "flow"), consume)
        if valid is not True:
            raise APIError(
                "CAPTCHA_INVALID",
                "验证码错误或已失效，请刷新后重试。",
                422,
                {"captchaAnswer": "请核对验证码或换一张。"},
            )

    def recovery_codes(self, conn, user_id, kind="password"):
        conn.execute("DELETE FROM recovery_codes WHERE user_id=? AND kind=?", (user_id, kind))
        codes = [secrets.token_hex(16) for _ in range(8)]
        for code in codes:
            conn.execute(
                "INSERT INTO recovery_codes VALUES(?,?,?,?,?,NULL)",
                (identifier(), user_id, kind, self.digest(code, "recovery"), now_ms()),
            )
        return ["-".join(code[i : i + 8] for i in range(0, 32, 8)) for code in codes]

    def consume_recovery(self, conn, user_id, value, kind="password"):
        digest = self.digest(value.strip().replace("-", "").lower(), "recovery")
        cursor = conn.execute(
            "UPDATE recovery_codes SET consumed_at=? WHERE user_id=? AND kind=? AND digest=? AND consumed_at IS NULL",
            (now_ms(), user_id, kind, digest),
        )
        return cursor.rowcount == 1

    def second_factor(self, conn, user, value):
        if not value:
            raise APIError(
                "SECOND_FACTOR_REQUIRED", "此账号需要管理员动态码或第二因素恢复码。", 401
            )
        if self.consume_recovery(conn, user["id"], value, "second_factor"):
            return
        if user["totp_secret"] and re.fullmatch(r"\d{6}", value):
            secret = self.fernet.decrypt(user["totp_secret"].encode()).decode()
            totp = pyotp.TOTP(secret)
            counter = now_ms() // 30000
            for candidate in (counter - 1, counter, counter + 1):
                if candidate > user["totp_last_counter"] and hmac.compare_digest(
                    totp.at(candidate * 30), value
                ):
                    conn.execute(
                        "UPDATE users SET totp_last_counter=? WHERE id=?", (candidate, user["id"])
                    )
                    return
        raise APIError("SECOND_FACTOR_INVALID", "动态码无效、已使用或恢复码已消费，请重试。", 401)
