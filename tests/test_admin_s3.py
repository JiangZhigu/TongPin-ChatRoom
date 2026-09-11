from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor

import httpx
import pyotp
import pytest
from test_admin import ORIGIN, PASSWORD, execute, fails, preview, reauth
from test_admin import admin_app as admin_app  # noqa: PLC0414

from tongpin.contracts.admin_s3 import AuditFilters, EnrollmentFinish, EnrollmentStart, LogFilters
from tongpin.contracts.auth import ReauthInput
from tongpin.contracts.base import APIError
from tongpin.domain.security import audit
from tongpin.infra.db import now_ms
from tongpin.runtime import Runtime

pytestmark = pytest.mark.asyncio


def notice_parameters(**changes):
    return {
        "kind": "announcement",
        "title": "隔离系统公告",
        "body": "由系统发送的合成验收正文",
        "audience": "all",
        "userIds": [],
        "groupId": "",
        "publishAt": None,
    } | changes


def publish_once(rt):
    job = rt.jobs.claim(kinds=("announcements.publish",))
    if job:
        result = rt.admin.publish_announcement(job)
        rt.jobs.complete(job["id"], result)
        return result


def start_enrollment(rt, actor):
    token = rt.auth.reauth(actor, ReauthInput(action="administrator.enroll", password=PASSWORD))[
        "reauthToken"
    ]
    return rt.admin.enrollment_start(actor, EnrollmentStart(reauthToken=token))


async def test_announcement_durable_batches_logout_idempotence_and_withdrawal(admin_app):
    app, actors, tokens, _, _ = admin_app
    rt = app.runtime
    with rt.db.write() as conn:
        for i in range(101):
            rt.auth.create_user(
                conn, f"notice_fixture_{i}", f"公告合成{i}", actors[2].user["password_hash"]
            )
    receipt, data, request = execute(
        admin_app, "announcement.create", ["instance"], notice_parameters()
    )
    assert receipt["status"] == "completed"
    listed = rt.admin.announcement(actors[0], data.operationId)
    assert (
        listed["status"] == "scheduled"
        and listed["recipientCount"] == 107
        and listed["deliveredCount"] == 0
    )
    assert rt.admin.execute(actors[0], request)["operationId"] == data.operationId
    first = publish_once(rt)
    assert first == {"finished": False, "sentThisBatch": 100}
    rt.auth.logout(actors[0])
    with rt.db.write() as conn:
        conn.execute(
            "UPDATE jobs SET run_after=0 WHERE kind='announcements.publish' AND status='pending'"
        )
    assert publish_once(rt)["sentThisBatch"] == 7
    assert publish_once(rt) is None
    listed = rt.admin.announcement(actors[1], data.operationId)
    assert listed["status"] == "published" and listed["deliveredCount"] == 107
    with rt.db.read() as conn:
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM notifications WHERE kind='system.notice' AND entity_ref=?",
                (data.operationId,),
            ).fetchone()[0]
            == 107
        )
        assert conn.execute("SELECT COUNT(*) FROM messages WHERE kind='user'").fetchone()[0] == 0
        stored = conn.execute(
            "SELECT details FROM audit_events WHERE action='admin.announcement.create'"
        ).fetchone()[0]
        assert "合成验收正文" not in stored
    assert (
        rt.admin.system_notice(actors[2], data.operationId)["body"] == notice_parameters()["body"]
    )
    execute(admin_app, "announcement.withdraw", [data.operationId], index=1)
    assert rt.admin.system_notice(actors[2], data.operationId)["body"] == ""
    assert rt.events.notifications(actors[2])["items"][0]["text"] == "系统公告已撤回"
    fails("AUTH_REQUIRED", lambda: rt.auth.load(tokens[0]))


async def test_announcement_fixed_scope_future_revocation_and_failed_runner(admin_app):
    rt, actors = admin_app[0].runtime, admin_app[1]
    parameters = notice_parameters(
        audience="users", userIds=[actors[2].id], publishAt=now_ms() + 60000
    )
    data = preview(rt, actors[0], "announcement.create", ["instance"], parameters)
    with rt.db.write() as conn:
        conn.execute("UPDATE users SET status='banned' WHERE id=?", (actors[2].id,))
    fails(
        "VERSION_CONFLICT",
        lambda: rt.admin.execute(
            actors[0], reauth(rt, actors[0], data.operationId, admin_app[3][0].pop())
        ),
    )
    with rt.db.write() as conn:
        conn.execute("UPDATE users SET status='active' WHERE id=?", (actors[2].id,))
    _, data, _ = execute(admin_app, "announcement.create", ["instance"], parameters)
    assert publish_once(rt) is None
    execute(admin_app, "administrator.revoke", [actors[0].id], index=1)
    with rt.db.write() as conn:
        conn.execute("UPDATE announcements SET publish_at=0 WHERE id=?", (data.operationId,))
        conn.execute("UPDATE jobs SET run_after=0 WHERE kind='announcements.publish'")
    assert publish_once(rt)["code"] == "ADMIN_AUTH_CHANGED"
    assert rt.admin.announcement(actors[1], data.operationId)["status"] == "failed"
    fails("RESOURCE_UNAVAILABLE", lambda: rt.admin.system_notice(actors[2], data.operationId))
    _, second, _ = execute(
        admin_app, "announcement.create", ["instance"], notice_parameters(), index=1
    )
    job = rt.jobs.claim(kinds=("announcements.publish",))
    rt.jobs.fail(job["id"], "CONTROLLED_FAILURE", 5, retry=False)
    assert rt.admin.announcement(actors[1], second.operationId)["status"] == "failed"
    rt.logs.persist()
    assert (
        rt.admin.runtime_log_events(actors[1], LogFilters(jobId=job["id"]))["items"][0]["code"]
        == "CONTROLLED_FAILURE"
    )


async def test_enrollment_requires_own_reauth_session_factor_and_is_single_use(admin_app):
    rt, actors = admin_app[0].runtime, admin_app[1]
    target = actors[2]
    execute(admin_app, "administrator.invite", [target.id])
    assert rt.admin.enrollment_status(target)["invitation"]["purpose"] == "grant"
    fails("RESOURCE_UNAVAILABLE", lambda: start_enrollment(rt, actors[3]))
    enrollment = start_enrollment(rt, target)
    assert "secret" not in json.dumps(rt.admin.administrators(actors[0]))
    with rt.db.write() as conn:
        other_token, _ = rt.auth.issue_session(conn, target.user, False, "second device")
    other = rt.auth.load(other_token)
    code = pyotp.TOTP(enrollment["secret"]).now()
    finish = EnrollmentFinish(enrollmentId=enrollment["enrollmentId"], code=code)
    fails("ENROLLMENT_EXPIRED", lambda: rt.admin.enrollment_finish(other, finish))
    wrong = EnrollmentFinish(
        enrollmentId=enrollment["enrollmentId"], code="000000" if code != "000000" else "111111"
    )
    fails("SECOND_FACTOR_INVALID", lambda: rt.admin.enrollment_finish(target, wrong))
    result = rt.admin.enrollment_finish(target, finish)
    assert result["user"]["siteRole"] == "super_admin" and len(result["recoveryCodes"]) == 8
    current = rt.auth.load(admin_app[2][2])
    assert rt.auth.require_admin(current).id == target.id
    fails("AUTH_REQUIRED", lambda: rt.auth.load(other_token))
    fails("ENROLLMENT_EXPIRED", lambda: rt.admin.enrollment_finish(current, finish))
    with rt.db.read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM administrator_enrollments").fetchone()[0] == 0
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM recovery_codes WHERE user_id=? AND kind='second_factor'",
                (target.id,),
            ).fetchone()[0]
            == 8
        )
        assert enrollment["secret"] not in "\n".join(
            row[0] for row in conn.execute("SELECT details FROM audit_events")
        )


async def test_inviter_revocation_invalidates_challenge_and_last_admin_guard(admin_app):
    rt, actors = admin_app[0].runtime, admin_app[1]
    execute(admin_app, "administrator.invite", [actors[2].id])
    challenge = start_enrollment(rt, actors[2])
    execute(admin_app, "administrator.revoke", [actors[0].id], index=1)
    assert rt.admin.enrollment_status(actors[2])["invitation"] is None
    fails(
        "ENROLLMENT_EXPIRED",
        lambda: rt.admin.enrollment_finish(
            actors[2],
            EnrollmentFinish(
                enrollmentId=challenge["enrollmentId"], code=pyotp.TOTP(challenge["secret"]).now()
            ),
        ),
    )
    fails("LAST_ADMIN", lambda: preview(rt, actors[1], "administrator.revoke", [actors[1].id]))
    fails(
        "LAST_ADMIN", lambda: preview(rt, actors[1], "administrator.factor_reset", [actors[1].id])
    )
    with rt.db.read() as conn:
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


async def test_enrollment_cancel_race_and_factor_reset(admin_app):
    rt, actors = admin_app[0].runtime, admin_app[1]
    execute(admin_app, "administrator.factor_reset", [actors[1].id])
    fails("AUTH_REQUIRED", lambda: rt.auth.load(admin_app[2][1]))
    with rt.db.write() as conn:
        user = conn.execute("SELECT * FROM users WHERE id=?", (actors[1].id,)).fetchone()
        assert user["site_role"] == "user" and user["totp_secret"] is None
        token, _ = rt.auth.issue_session(conn, user, False, "recovered ordinary login")
    target = rt.auth.load(token)
    enrollment = start_enrollment(rt, target)
    data = EnrollmentFinish(
        enrollmentId=enrollment["enrollmentId"], code=pyotp.TOTP(enrollment["secret"]).now()
    )

    def finish():
        try:
            return rt.admin.enrollment_finish(target, data)
        except APIError as error:
            return error.code

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(lambda _: finish(), range(2)))
    assert sum(isinstance(item, dict) for item in outcomes) == 1
    assert "ENROLLMENT_EXPIRED" in outcomes


async def test_audit_and_failed_http_logs_are_filtered_bounded_and_redacted(admin_app):
    app, actors, tokens, _, _ = admin_app
    rt = app.runtime
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=ORIGIN) as client:
        client.cookies.set(rt.auth.cookie_name, tokens[2])
        denied = await client.get("/api/v1/admin/audit?query=private-chat-marker")
        assert denied.status_code == 403
        request_id = denied.headers["X-Request-ID"]
        client.cookies.set(rt.auth.cookie_name, tokens[0])
        logs = (await client.get("/api/v1/admin/logs", params={"requestId": request_id})).json()[
            "data"
        ]
        assert logs["total"] == 1
        assert (
            logs["items"][0]["code"] == "FORBIDDEN"
            and logs["items"][0]["route"] == "GET /api/v1/admin/audit"
        )
        assert "private-chat-marker" not in json.dumps(logs)
        assert (
            await client.get("/api/v1/admin/audit", params={"fromAt": "999", "until": "1"})
        ).status_code == 422
        assert (
            await client.get("/api/v1/admin/audit", params={"after": "bad-cursor"})
        ).status_code == 422
    logging.getLogger("tongpin").error("do not persist plaintext-body-or-exception")
    rt.logs.persist()
    with rt.db.write() as conn:
        audit(
            conn,
            actors[0].id,
            "admin.controlled.audit",
            "target",
            reason="受控核验",
            details={
                "requestId": "request-safe",
                "jobId": "job-safe",
                "body": "private-body",
                "nested": {"password": "not-a-real-credential"},
                "version": 2,
            },
        )
    filtered = rt.admin.audit_events(
        actors[0],
        AuditFilters(action="admin.controlled.audit", requestId="request-safe", jobId="job-safe"),
    )
    assert filtered["total"] == 1 and filtered["items"][0]["details"]["version"] == 2
    assert "private-body" not in json.dumps(filtered) and "not-a-real-credential" not in json.dumps(
        filtered
    )
    with rt.db.write() as conn:
        conn.executemany(
            "INSERT INTO runtime_logs(level,code,created_at) VALUES('warning','BOUNDED_TEST',?)",
            [(now_ms(),)] * 10005,
        )
    rt.logs.persist()
    with rt.db.read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM runtime_logs").fetchone()[0] == 10000
        assert "plaintext-body" not in "\n".join(
            row[0] for row in conn.execute("SELECT code FROM runtime_logs")
        )


async def test_host_recovery_only_offline_resets_credentials_and_audits(settings):
    rt = Runtime(settings)
    rt.initialize()
    try:
        original = pyotp.random_base32()
        with rt.db.write() as conn:
            user = rt.auth.create_user(
                conn,
                "host_recovery_admin",
                "本机合成管理员",
                rt.auth.security.passwords.hash(PASSWORD),
                site_role="super_admin",
                totp_secret=rt.auth.security.fernet.encrypt(original.encode()).decode(),
            )
            token, _ = rt.auth.issue_session(conn, user, False, "before host recovery", factor=True)
            old_codes = rt.auth.security.recovery_codes(conn, user["id"])
        secret = pyotp.random_base32()
        result = rt.admin.recover_local_administrator(
            user["username"],
            "New isolated host recovery 87!",
            secret,
            pyotp.TOTP(secret).now(),
            "隔离本机身份核验后恢复",
        )
        assert len(result["recoveryCodes"]) == len(result["secondFactorRecoveryCodes"]) == 8
        assert not set(old_codes) & set(result["recoveryCodes"])
        fails("AUTH_REQUIRED", lambda: rt.auth.load(token))
        with rt.db.read() as conn:
            changed = conn.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
            assert rt.auth.security.verify_password(
                changed["password_hash"], "New isolated host recovery 87!"
            )
            assert not rt.auth.security.verify_password(changed["password_hash"], PASSWORD)
            assert (
                conn.execute(
                    "SELECT COUNT(*) FROM audit_events WHERE action='admin.user.host_recovery' AND actor_id IS NULL"
                ).fetchone()[0]
                == 1
            )
            assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        rt.loop = object()
        with pytest.raises(RuntimeError, match="offline"):
            rt.admin.recover_local_administrator(
                user["username"], PASSWORD, secret, pyotp.TOTP(secret).now(), "不允许在线恢复"
            )
    finally:
        rt.cache.clear()
        rt.executor.close()
        rt.lock.release()
