from __future__ import annotations

import asyncio
import base64
import io
import json
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import httpx
import pyotp
import pytest
import pytest_asyncio
from PIL import Image

from tongpin.asgi import create_application
from tongpin.contracts.auth import ReauthInput, RecoverInput
from tongpin.contracts.base import APIError
from tongpin.domain.auth import AuthService
from tongpin.domain.security import validate_password
from tongpin.infra.cache import BoundedCache
from tongpin.infra.db import now_ms

PASSWORD = "Shore!lantern29 clouds"
OTHER_PASSWORD = "River?meadow83 stars"
ORIGIN = "http://127.0.0.1:8765"


@pytest_asyncio.fixture
async def running_app(settings):
    app = create_application(settings)
    await app.runtime.start()
    try:
        yield app
    finally:
        await app.runtime.stop()


@pytest_asyncio.fixture
async def client(running_app):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=running_app), base_url=ORIGIN, headers={"Origin": ORIGIN}
    ) as client:
        bootstrap = (await client.get("/api/v1/auth/bootstrap")).json()["data"]
        client.headers["X-CSRF-Token"] = bootstrap["csrfToken"]
        yield client


def registration_mode(runtime, mode):
    with runtime.db.write() as conn:
        old = runtime.policy.get(conn)
        version = old.pop("version") + 1
        conn.execute(
            "INSERT INTO policy_versions VALUES(?,?,NULL,?,?)",
            (
                version,
                json.dumps(old | {"registration_mode": mode}),
                "Isolated synthetic test fixture",
                now_ms(),
            ),
        )


async def captcha(client):
    # Patch randomness only within the isolated test process; the product has no answer endpoint.
    with patch("tongpin.domain.security.secrets.choice", lambda alphabet: alphabet[0]):
        response = await client.get("/api/v1/auth/captcha")
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert set(data) == {"captchaId", "image", "expiresAt"}
    assert Image.open(io.BytesIO(base64.b64decode(data["image"].split(",")[1]))).size == (232, 78)
    return {"captchaId": data["captchaId"], "captchaAnswer": "AAAAAA"}


async def register(client, username="friend_one", **extra):
    response = await client.post(
        "/api/v1/auth/register",
        json={
            "username": username,
            "nickname": "同名昵称",
            "password": PASSWORD,
            "termsVersion": "development-1",
            "acceptTerms": True,
            **(await captcha(client)),
            **extra,
        },
    )
    if response.is_success:
        client.headers["X-CSRF-Token"] = response.json()["data"]["csrfToken"]
    return response


async def login(client, username="friend_one", **extra):
    data = (await client.get("/api/v1/auth/bootstrap")).json()["data"]
    client.headers["X-CSRF-Token"] = data["csrfToken"]
    response = await client.post(
        "/api/v1/auth/login",
        json={
            "username": username,
            "password": PASSWORD,
            "remember": False,
            **(await captcha(client)),
            **extra,
        },
    )
    if response.is_success:
        client.headers["X-CSRF-Token"] = response.json()["data"]["csrfToken"]
    return response


def seed_admin(runtime, username="site_admin"):
    service = runtime.auth
    secret = pyotp.random_base32()
    with runtime.db.write() as conn:
        user = service.create_user(
            conn,
            username,
            "隔离管理员",
            service.security.passwords.hash(PASSWORD),
            site_role="super_admin",
            totp_secret=service.security.fernet.encrypt(secret.encode()).decode(),
        )
        codes = service.security.recovery_codes(conn, user["id"])
        factors = service.security.recovery_codes(conn, user["id"], "second_factor")
    return user["id"], secret, codes, factors


@pytest.mark.asyncio
async def test_registration_closed_open_unique_and_no_secret_leak(client, running_app):
    registration_mode(running_app.runtime, "closed")
    response = await register(client)
    assert response.status_code == 403 and response.json()["error"]["code"] == "REGISTRATION_CLOSED"
    registration_mode(running_app.runtime, "open")
    first = await register(client)
    assert first.status_code == 201, first.text
    result = first.json()["data"]
    assert len(result["recoveryCodes"]) == 8
    cookie = first.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=Lax" in cookie and "Path=/" in cookie
    second = await register(client, username="FRIEND_ONE")
    assert second.status_code == 409
    third = await register(client, username="friend_two")
    assert third.status_code == 201
    assert third.json()["data"]["user"]["nickname"] == result["user"]["nickname"]
    with running_app.runtime.db.read() as conn:
        users = conn.execute("SELECT password_hash FROM users").fetchall()
        rows = conn.execute("SELECT digest FROM recovery_codes").fetchall()
        logs = [dict(row) for row in conn.execute("SELECT * FROM audit_events")]
    assert len(users) == 2 and users[0][0] != users[1][0]
    assert all(user[0].startswith("$argon2id$v=19$m=65536,t=3,p=2$") for user in users)
    assert all(len(row[0]) == 64 for row in rows)
    assert PASSWORD not in json.dumps(logs)
    me = (await client.get("/api/v1/auth/me")).json()["data"]
    assert "recoveryCodes" not in me and "password_hash" not in json.dumps(me)
    assert (await client.get("/api/v1/admin/auth")).status_code == 403


@pytest.mark.asyncio
async def test_csrf_origin_extra_fields_and_cookie_rotation(client, running_app):
    registration_mode(running_app.runtime, "open")
    assert (await register(client)).status_code == 201
    original_token = client.cookies.get("tp_session")
    original_headers = dict(client.headers)
    for headers in ({"Origin": "https://wrong.invalid"}, {"X-CSRF-Token": "wrong"}):
        response = await client.patch(
            "/api/v1/account/profile", json={"nickname": "新昵称", "bio": ""}, headers=headers
        )
        assert response.status_code == 403
    malicious = await client.patch(
        "/api/v1/account/profile",
        json={"nickname": "新昵称", "bio": "", "siteRole": "super_admin", "id": "attacker"},
    )
    assert malicious.status_code == 422
    assert (await login(client)).status_code == 200
    assert client.cookies.get("tp_session") != original_token
    with pytest.raises(APIError):
        running_app.runtime.auth.load(original_token)
    assert (
        await client.patch(
            "/api/v1/account/profile", json={"nickname": "真实昵称", "bio": "你好 👩🏽‍💻"}
        )
    ).status_code == 200
    assert (await client.get("/api/v1/auth/me")).json()["data"]["user"]["nickname"] == "真实昵称"
    assert original_headers["origin"] == ORIGIN


def test_captcha_atomic_attempts_rotation_expiry_and_restart(settings):
    from tongpin.runtime import Runtime

    runtime = Runtime(settings)
    runtime.initialize()
    try:
        security = runtime.auth.security

        def new(flow):
            with patch("tongpin.domain.security.secrets.choice", lambda alphabet: alphabet[0]):
                return security.new_captcha(flow, flow)

        current = new("concurrent-flow")

        def consume(_):
            try:
                security.consume_captcha("concurrent-flow", current["captchaId"], "AAAAAA")
                return True
            except APIError:
                return False

        with ThreadPoolExecutor(6) as executor:
            assert sum(executor.map(consume, range(6))) == 1
        current = new("attempt-flow")
        for _ in range(5):
            with pytest.raises(APIError):
                security.consume_captcha("attempt-flow", current["captchaId"], "WRONG")
        with pytest.raises(APIError):
            security.consume_captcha("attempt-flow", current["captchaId"], "AAAAAA")
        old = new("rotate-flow")
        new("rotate-flow")
        with pytest.raises(APIError):
            security.consume_captcha("rotate-flow", old["captchaId"], "AAAAAA")
        clock = [0.0]
        security.captchas = BoundedCache(ttl=120, clock=lambda: clock[0])
        old = new("expired-flow")
        clock[0] = 121
        with pytest.raises(APIError):
            security.consume_captcha("expired-flow", old["captchaId"], "AAAAAA")
        old = new("restart-flow")
        after_restart = AuthService(runtime)
        with pytest.raises(APIError):
            after_restart.security.consume_captcha("restart-flow", old["captchaId"], "AAAAAA")
        security.rate("persisted-limit", "one-key", 1, 600)
        with pytest.raises(APIError) as error:
            after_restart.security.rate("persisted-limit", "one-key", 1, 600)
        assert error.value.code == "RATE_LIMITED"
    finally:
        runtime.executor.close()
        runtime.lock.release()


@pytest.mark.asyncio
async def test_session_idle_absolute_and_sensitive_action_bound_once(client, running_app):
    registration_mode(running_app.runtime, "open")
    assert (await register(client)).status_code == 201
    token = client.cookies.get("tp_session")
    actor = running_app.runtime.auth.load(token)
    reauth = await client.post(
        "/api/v1/auth/reauth", json={"password": PASSWORD, "action": "recovery_codes"}
    )
    credential = reauth.json()["data"]["reauthToken"]
    wrong = await client.post(
        "/api/v1/account/password", json={"password": OTHER_PASSWORD, "reauthToken": credential}
    )
    assert wrong.status_code == 403
    result = await client.post("/api/v1/account/recovery-codes", json={"reauthToken": credential})
    assert result.status_code == 200 and len(result.json()["data"]["recoveryCodes"]) == 8
    assert (
        await client.post("/api/v1/account/recovery-codes", json={"reauthToken": credential})
    ).status_code == 403
    with running_app.runtime.db.write() as conn:
        conn.execute(
            "UPDATE sessions SET last_seen_at=? WHERE id=?",
            (now_ms() - actor.session["idle_ms"] - 1, actor.session["id"]),
        )
    assert (await client.get("/api/v1/auth/me")).status_code == 401
    assert (await login(client, remember=True)).status_code == 200
    actor = running_app.runtime.auth.load(client.cookies.get("tp_session"))
    assert actor.session["idle_ms"] == 7 * 86400000
    with running_app.runtime.db.write() as conn:
        conn.execute(
            "UPDATE sessions SET expires_at=? WHERE id=?", (now_ms() - 1, actor.session["id"])
        )
    assert (await client.get("/api/v1/auth/me")).status_code == 401


@pytest.mark.asyncio
async def test_recovery_once_race_revokes_all_sessions(client, running_app):
    registration_mode(running_app.runtime, "open")
    result = (await register(client)).json()["data"]
    token = client.cookies.get("tp_session")
    service = running_app.runtime.auth
    payloads = []
    for i in range(2):
        flow = "recovery-isolated-" + str(i)
        with patch("tongpin.domain.security.secrets.choice", lambda alphabet: alphabet[0]):
            image = service.security.new_captcha(flow, flow)
        payloads.append(
            (
                RecoverInput(
                    username="friend_one",
                    recoveryCode=result["recoveryCodes"][0],
                    password=OTHER_PASSWORD,
                    captchaId=image["captchaId"],
                    captchaAnswer="AAAAAA",
                ),
                flow,
            )
        )

    def recover(item):
        try:
            return service.recover(item[0], item[1], item[1], "isolated-test")["recovered"]
        except APIError:
            return False

    outcomes = await asyncio.gather(*(asyncio.to_thread(recover, item) for item in payloads))
    assert sum(outcomes) == 1
    with pytest.raises(APIError):
        service.load(token)
    assert (await login(client, password=OTHER_PASSWORD)).status_code == 200
    with running_app.runtime.db.read() as conn:
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM recovery_codes WHERE consumed_at IS NOT NULL"
            ).fetchone()[0]
            == 1
        )


@pytest.mark.asyncio
async def test_admin_second_factor_replay_and_independent_recovery_codes(client, running_app):
    uid, secret, codes, factors = seed_admin(running_app.runtime)
    assert (await login(client, username="site_admin")).json()["error"][
        "code"
    ] == "SECOND_FACTOR_REQUIRED"
    code = pyotp.TOTP(secret).now()
    response = await login(client, username="site_admin", secondFactor=code, admin=True)
    assert response.status_code == 200, response.text
    assert (await client.get("/api/v1/admin/auth")).json()["data"]["user"]["id"] == uid
    assert (await login(client, username="site_admin", secondFactor=code)).status_code == 401
    assert (await login(client, username="site_admin", secondFactor=codes[0])).status_code == 401
    assert (await login(client, username="site_admin", secondFactor=factors[0])).status_code == 200
    assert (await login(client, username="site_admin", secondFactor=factors[0])).status_code == 401
    actor = running_app.runtime.auth.load(client.cookies.get("tp_session"))
    challenge = running_app.runtime.auth.reauth(
        actor, ReauthInput(password=PASSWORD, action="some_admin_action", secondFactor=factors[1])
    )
    with running_app.runtime.db.write() as conn:
        running_app.runtime.auth.consume_reauth(
            conn, actor, challenge["reauthToken"], "some_admin_action", admin=True
        )
    with running_app.runtime.db.read() as conn:
        row = conn.execute("SELECT totp_secret FROM users WHERE id=?", (uid,)).fetchone()
        assert secret not in row[0]


@pytest.mark.asyncio
async def test_invite_only_cannot_use_group_token_and_consumes_once(client, running_app):
    registration_mode(running_app.runtime, "invite-only")
    assert (await register(client, siteInvite="some-group-token")).status_code == 403
    service = running_app.runtime.auth
    with running_app.runtime.db.write() as conn:
        conn.execute(
            "INSERT INTO site_invites VALUES(?,?,NULL,?,?,1,0,NULL)",
            (
                "inv-1",
                service.security.digest("isolated-site-invite", "site_invite"),
                now_ms(),
                now_ms() + 60000,
            ),
        )
    assert (await register(client, siteInvite="isolated-site-invite")).status_code == 201
    assert (
        await register(client, username="friend_two", siteInvite="isolated-site-invite")
    ).status_code == 403


def test_password_no_trimming_no_truncation_unicode():
    value = "  Long passphrase with leading spaces  "
    assert validate_password(value) == value
    assert validate_password("山林河流晨光🌿𠮷测试密码长句十五位")
    for password in ("123456789012345", "abcdefgh" * 20, "a" * 20, "Contains\x00control chars"):
        with pytest.raises(APIError):
            validate_password(password)


@pytest.mark.parametrize("password", ["Abc9!xyz", "山林河流晨光🌿𠮷", "Abc9!xyz" * 16])
def test_password_accepts_eight_through_128_codepoints(password):
    assert validate_password(password) == password


@pytest.mark.parametrize("password", ["Abc9!xy", "山林河流晨光🌿", "Abc9!xyz" * 16 + "Z"])
def test_password_rejects_outside_eight_through_128_codepoints(password):
    with pytest.raises(APIError) as error:
        validate_password(password)
    assert error.value.code == "VALIDATION_ERROR"


@pytest.mark.asyncio
async def test_eight_character_password_register_change_and_recover(client, running_app):
    registration_mode(running_app.runtime, "open")
    short, initial, changed, recovered = "Abc9!xy", "Abc9!xyz", "Def8?uvw", "Ghi7#rst"
    assert (await register(client, password=short)).status_code == 422
    registration = await register(client, password=initial)
    assert registration.status_code == 201, registration.text
    code = registration.json()["data"]["recoveryCodes"][0]
    reauth = await client.post(
        "/api/v1/auth/reauth", json={"password": initial, "action": "change_password"}
    )
    assert reauth.status_code == 200, reauth.text
    token = reauth.json()["data"]["reauthToken"]
    rejected = await client.post(
        "/api/v1/account/password", json={"password": short, "reauthToken": token}
    )
    assert rejected.status_code == 422, rejected.text
    response = await client.post(
        "/api/v1/account/password", json={"password": changed, "reauthToken": token}
    )
    assert response.status_code == 200, response.text
    assert (await client.get("/api/v1/auth/me")).status_code == 401
    assert (await login(client, password=changed)).status_code == 200
    for password, status in [(short, 422), (recovered, 200)]:
        response = await client.post(
            "/api/v1/auth/recover",
            json={
                "username": "friend_one", "password": password, "recoveryCode": code,
                **(await captcha(client)),
            },
        )
        assert response.status_code == status, response.text
    assert (await login(client, password=recovered)).status_code == 200


@pytest.mark.asyncio
async def test_ws_ticket_cookie_binding_single_use_and_revoked_session(client, running_app):
    registration_mode(running_app.runtime, "open")
    assert (await register(client)).status_code == 201
    token = client.cookies.get("tp_session")
    service = running_app.runtime.auth
    ticket = (await client.post("/api/v1/auth/ws-ticket", json={})).json()["data"]["ticket"]
    with pytest.raises(APIError):
        service.authorize_ticket(ticket, "other-cookie")
    actor = service.authorize_ticket(ticket, token)
    with pytest.raises(APIError):
        service.authorize_ticket(ticket, token)
    ticket = service.websocket_ticket(actor)["ticket"]
    service.logout(actor)
    with pytest.raises(APIError):
        service.authorize_ticket(ticket, token)
