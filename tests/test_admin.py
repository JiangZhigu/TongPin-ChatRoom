from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from concurrent.futures import ThreadPoolExecutor

import httpx
import pyotp
import pytest
import pytest_asyncio
from test_auth import captcha
from test_files import image_bytes
from test_groups import befriend, create, link

from tongpin.admin.monitoring import DEFAULT_THRESHOLDS
from tongpin.asgi import create_application
from tongpin.contracts.admin import AdminExecuteInput, AdminPreviewInput
from tongpin.contracts.auth import ReauthInput
from tongpin.contracts.base import APIError
from tongpin.contracts.chat import MessageInput
from tongpin.contracts.files import UploadInput
from tongpin.contracts.groups import GroupCommand, GroupCreate
from tongpin.infra.db import now_ms
from tongpin.jobs.runner import JobRunner

pytestmark = pytest.mark.asyncio
ORIGIN = "http://127.0.0.1:8765"
PASSWORD = "Isolated admin orchard 53!"


@pytest_asyncio.fixture
async def admin_app(settings):
    app = create_application(settings)
    rt = app.runtime
    await rt.start()
    await rt.runner.stop()
    await rt.file_runner.stop()
    await rt.admin_runner.stop()
    rt._stopping.set()
    await rt._metric_task
    tokens, factors, totp_secrets = [], [], []
    password_hash = rt.auth.security.passwords.hash(PASSWORD)
    with rt.db.write() as conn:
        for i in range(6):
            secret = pyotp.random_base32() if i < 2 else None
            encrypted = (
                rt.auth.security.fernet.encrypt(secret.encode()).decode() if secret else None
            )
            user = rt.auth.create_user(
                conn,
                f"admin_fixture_{i}",
                f"治理账号{i}",
                password_hash,
                site_role="super_admin" if i < 2 else "user",
                totp_secret=encrypted,
            )
            token, _ = rt.auth.issue_session(
                conn, user, False, "isolated admin test device", factor=i < 2
            )
            tokens.append(token)
            totp_secrets.append(secret)
            factors.append(
                rt.auth.security.recovery_codes(conn, user["id"], "second_factor") if i < 2 else []
            )
    actors = [rt.auth.load(token) for token in tokens]
    try:
        yield app, actors, tokens, factors, totp_secrets
    finally:
        await rt.stop()


def preview(rt, actor, action, targets, parameters=None):
    data = AdminPreviewInput(
        operationId=str(uuid.uuid4()),
        action=action,
        targetIds=targets,
        parameters=parameters or {},
        reason="隔离测试：核对明确范围与实际处置",
    )
    result = rt.admin.preview(actor, data)
    assert result["targetCount"] == len(targets)
    return data


def reauth(rt, actor, operation, code):
    result = rt.auth.reauth(
        actor,
        ReauthInput(action="admin.execute:" + operation, password=PASSWORD, secondFactor=code),
    )
    return AdminExecuteInput(operationId=operation, reauthToken=result["reauthToken"])


def execute(fixture, action, targets, parameters=None, index=0):
    app, actors, _, factors, _ = fixture
    rt, actor = app.runtime, actors[index]
    data = preview(rt, actor, action, targets, parameters)
    request = reauth(rt, actor, data.operationId, factors[index].pop())
    return rt.admin.execute(actor, request, "isolated-request"), data, request


def fails(code, action):
    with pytest.raises(APIError) as caught:
        action()
    assert caught.value.code == code


def claim_admin(rt):
    job = rt.jobs.claim(kinds=("admin.execute",))
    assert job
    return job


async def test_admin_pages_metadata_paging_and_ordinary_denial(admin_app):
    app, actors, tokens, _, _ = admin_app
    rt = app.runtime
    befriend(rt, actors[2], actors[3])
    create(rt, actors[2], [actors[3]])
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=ORIGIN, headers={"Origin": ORIGIN}
    ) as client:
        client.cookies.set(rt.auth.cookie_name, tokens[2])
        for path in ("/overview", "/users", "/sessions", "/relations", "/groups", "/monitoring"):
            assert (await client.get("/api/v1/admin" + path)).status_code == 403
        client.cookies.set(rt.auth.cookie_name, tokens[0])
        for path in (
            "/overview",
            "/sessions",
            "/relations",
            "/groups",
            "/monitoring",
            "/connections",
            "/alerts",
        ):
            response = await client.get("/api/v1/admin" + path)
            assert response.status_code == 200, response.text
            assert (
                "password_hash" not in response.text
                and "tokenHash" not in response.text
                and "totp_secret" not in response.text
            )
        first = (await client.get("/api/v1/admin/users?limit=2&sort=username")).json()["data"]
        second = (
            await client.get(
                "/api/v1/admin/users",
                params={"limit": 2, "sort": "username", "after": first["nextCursor"]},
            )
        ).json()["data"]
        assert (
            first["total"] == 6
            and len({row["id"] for row in first["items"] + second["items"]}) == 4
        )
        assert (await client.get("/api/v1/admin/users?sort=password_hash")).status_code == 422
        assert (await client.get("/api/v1/admin/users?limit=101")).status_code == 422
        assert (await client.get("/api/v1/admin/unknown")).status_code == 404


async def test_preview_purpose_totp_and_concurrent_idempotent_execute(admin_app):
    app, actors, _, _, secrets = admin_app
    rt, actor, target = app.runtime, actors[0], actors[2]
    data = preview(rt, actor, "user.mute", [target.id], {"until": now_ms() + 60000})
    request = reauth(rt, actor, data.operationId, pyotp.TOTP(secrets[0]).now())
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(lambda _: rt.admin.execute(actor, request, "concurrent-request"), range(2))
        )
    assert results[0] == results[1] and results[0]["succeeded"] == 1
    with rt.db.read() as conn:
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM audit_events WHERE action='admin.user.mute'"
            ).fetchone()[0]
            == 1
        )
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM reauth_tokens WHERE consumed_at IS NOT NULL"
            ).fetchone()[0]
            == 1
        )
    changed = data.model_copy(update={"reason": "改变原操作的核验说明"})
    fails("COMMAND_EXISTS", lambda: rt.admin.preview(actor, changed))
    other = preview(rt, actor, "user.unmute", [target.id])
    fails(
        "REAUTH_REQUIRED",
        lambda: rt.admin.execute(
            actor, AdminExecuteInput(operationId=other.operationId, reauthToken=request.reauthToken)
        ),
    )


async def test_preview_conflict_does_not_consume_fresh_reauth(admin_app):
    app, actors, _, factors, _ = admin_app
    rt, actor, target = app.runtime, actors[0], actors[2]
    data = preview(rt, actor, "user.ban", [target.id])
    request = reauth(rt, actor, data.operationId, factors[0].pop())
    with rt.db.write() as conn:
        conn.execute("UPDATE users SET admin_version=admin_version+1 WHERE id=?", (target.id,))
    fails("VERSION_CONFLICT", lambda: rt.admin.execute(actor, request))
    with rt.db.read() as conn:
        assert (
            conn.execute(
                "SELECT consumed_at FROM reauth_tokens WHERE digest=?",
                (rt.auth.security.digest(request.reauthToken, "reauth"),),
            ).fetchone()[0]
            is None
        )
        assert conn.execute("SELECT COUNT(*) FROM admin_commands").fetchone()[0] == 0


async def test_last_usable_admin_and_ban_revoke_all_old_sessions(admin_app):
    app, actors, tokens, _, _ = admin_app
    rt = app.runtime
    with rt.db.write() as conn:
        conn.execute("UPDATE users SET must_change_password=1 WHERE id=?", (actors[1].id,))
    fails("LAST_ADMIN", lambda: preview(rt, actors[0], "user.ban", [actors[0].id]))
    assert rt.lifecycle.deletion_preview(actors[0])["lastAdministrator"]
    result, _, _ = execute(admin_app, "user.ban", [actors[2].id])
    assert result["status"] == "completed"
    fails("AUTH_REQUIRED", lambda: rt.auth.load(tokens[2]))
    with rt.db.read() as conn:
        target = conn.execute(
            "SELECT status,status_reason FROM users WHERE id=?", (actors[2].id,)
        ).fetchone()
        assert target["status"] == "banned" and "隔离测试" in target["status_reason"]


async def test_restrictions_reach_original_chat_group_and_upload_guards(admin_app):
    app, actors, tokens, _, _ = admin_app
    rt, target, peer = app.runtime, actors[2], actors[3]
    befriend(rt, target, peer)
    conversation = rt.chat.direct(target, peer.id)
    execute(
        admin_app,
        "user.restrict",
        [target.id],
        {"uploadDisabled": True, "groupCreationDisabled": True},
    )
    fails(
        "GROUP_CREATION_DISABLED",
        lambda: rt.groups.create(
            target, GroupCreate(clientRequestId=str(uuid.uuid4()), name="受限账号不能创建")
        ),
    )
    body = image_bytes()
    upload_request = UploadInput(
        actorContext=target.id,
        clientUploadId=str(uuid.uuid4()),
        purpose="message",
        conversationId=conversation["id"],
        accessKey=conversation["accessKey"],
        name="image.png",
        size=len(body),
        sha256=hashlib.sha256(body).hexdigest(),
        mime="image/png",
    )
    fails("UPLOAD_DISABLED", lambda: rt.files.reserve(target, upload_request))
    assert not rt.files.policy(target)["uploadAllowed"]
    execute(admin_app, "user.mute", [target.id], {"until": now_ms() + 60000})
    message = MessageInput(
        clientMessageId=str(uuid.uuid4()),
        text="需要拒绝的新消息",
        accessKey=conversation["accessKey"],
    )
    fails("MUTED", lambda: rt.chat.send(target, conversation["id"], message))
    payload = {
        "v": 1,
        "requestId": str(uuid.uuid4()),
        "conversationId": conversation["id"],
        **message.model_dump(),
    }
    await rt.connected("isolated-target-socket", rt.auth.load(tokens[2]))
    answer = await app.sio.handlers["/"]["message.send"]("isolated-target-socket", payload)
    assert answer["ok"] is False and answer["error"]["code"] == "MUTED"
    assert rt.metrics.sample()["wsErrors"] >= 1
    execute(admin_app, "user.unmute", [target.id])
    assert rt.chat.send(target, conversation["id"], message)["message"]["text"] == message.text


async def test_manual_reset_single_disclosure_and_real_recovery_form(admin_app):
    app, actors, tokens, _, _ = admin_app
    rt, target = app.runtime, actors[2]
    result, data, _ = execute(admin_app, "user.password_reset", [target.id])
    assert result["secretAvailable"] and "credential" not in json.dumps(result)
    secret = rt.admin.reveal_secret(actors[0], data.operationId)
    fails("SECRET_UNAVAILABLE", lambda: rt.admin.reveal_secret(actors[0], data.operationId))
    fails("AUTH_REQUIRED", lambda: rt.auth.load(tokens[2]))
    with rt.db.read() as conn:
        dump = json.dumps(
            [dict(row) for row in conn.execute("SELECT * FROM admin_commands")]
        ) + json.dumps([dict(row) for row in conn.execute("SELECT * FROM audit_events")])
        assert secret["credential"] not in dump
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=ORIGIN, headers={"Origin": ORIGIN}
    ) as client:
        bootstrap = (await client.get("/api/v1/auth/bootstrap")).json()["data"]
        client.headers["X-CSRF-Token"] = bootstrap["csrfToken"]
        response = await client.post(
            "/api/v1/auth/recover",
            json={
                "username": target.user["username"],
                "recoveryCode": secret["credential"],
                "password": "Changed password after review 97!",
                **await captcha(client),
            },
        )
        assert response.status_code == 200, response.text
        second = await client.post(
            "/api/v1/auth/recover",
            json={
                "username": target.user["username"],
                "recoveryCode": secret["credential"],
                "password": "Another changed password 64!",
                **await captcha(client),
            },
        )
        assert second.status_code == 401
    with rt.db.read() as conn:
        assert not conn.execute(
            "SELECT must_change_password FROM users WHERE id=?", (target.id,)
        ).fetchone()[0]


async def test_group_governance_cross_membership_and_invitation_reservations(admin_app):
    app, actors, _, _, _ = admin_app
    rt, owner, member, applicant = app.runtime, actors[2], actors[3], actors[4]
    befriend(rt, owner, member)
    created = create(rt, owner, [member])
    cid = created["conversation"]["id"]
    # Creation sends a real direct invitation; approve through the regular join path.
    invitation = rt.groups.invites.mine(member)["items"][0]
    rt.groups.invites.apply(
        member, invitation["id"], GroupCommand(clientRequestId=str(uuid.uuid4()))
    )
    pending = rt.groups.invites.applications(owner, cid)["items"][0]
    rt.groups.invites.decide(owner, pending["id"], "approve")
    fails("RESOURCE_UNAVAILABLE", lambda: rt.groups.get(actors[0], cid))
    detail = rt.admin.group_detail(actors[0], cid)
    period = next(row["id"] for row in detail["members"]["items"] if row["user"]["id"] == member.id)
    result, _, _ = execute(admin_app, "group.member.role", [period], {"role": "admin"})
    assert result["succeeded"] == 1
    invitation = link(rt, owner, cid)
    rt.groups.invites.apply(
        applicant,
        invitation["invite"]["id"],
        GroupCommand(clientRequestId=str(uuid.uuid4())),
        invitation["token"],
    )
    with rt.db.read() as conn:
        assert rt.groups.invites.reserved(conn, cid, invitation["invite"]["id"]) == 1
    execute(admin_app, "group.invite.revoke", [invitation["invite"]["id"]])
    with rt.db.read() as conn:
        assert rt.groups.invites.reserved(conn, cid, invitation["invite"]["id"]) == 0
    execute(admin_app, "group.owner.change", [cid], {"userId": member.id})
    assert rt.groups.get(member, cid)["conversation"]["role"] == "owner"
    execute(admin_app, "group.dissolve", [cid])
    fails("RESOURCE_UNAVAILABLE", lambda: rt.chat.get(member, cid))
    with rt.db.read() as conn:
        assert not conn.execute(
            "SELECT 1 FROM memberships WHERE conversation_id=? AND left_at IS NULL", (cid,)
        ).fetchone()


async def test_async_batch_is_bounded_and_reports_partial_failures(admin_app):
    app, actors, _, _, _ = admin_app
    rt = app.runtime
    target_ids = []
    with rt.db.write() as conn:
        for i in range(12):
            user = rt.auth.create_user(
                conn, f"batch_fixture_{i}", f"批次账号{i}", actors[2].user["password_hash"]
            )
            target_ids.append(user["id"])
    result, data, _ = execute(
        admin_app,
        "user.restrict",
        target_ids,
        {"uploadDisabled": True, "groupCreationDisabled": False},
    )
    assert result["status"] == "queued" and result["pending"] == 12
    job = claim_admin(rt)
    rt.admin.process_command(job)
    rt.jobs.complete(job["id"])
    progress = rt.admin.command(actors[0], data.operationId)
    assert progress["succeeded"] == 10 and progress["pending"] == 2
    with rt.db.write() as conn:
        conn.execute("UPDATE users SET admin_version=admin_version+1 WHERE id=?", (target_ids[-1],))
        conn.execute("UPDATE jobs SET run_after=0 WHERE id=?", (job["id"],))
    job = claim_admin(rt)
    rt.admin.process_command(job)
    rt.jobs.complete(job["id"])
    final = rt.admin.command(actors[0], data.operationId)
    assert (
        final["status"] == "partial"
        and final["succeeded"] == 11
        and final["failed"] == 1
        and final["pending"] == 0
    )
    assert final["items"][-1]["code"] == "VERSION_CONFLICT"


async def test_downgraded_operator_stops_unexecuted_batch(admin_app):
    app, actors, _, _, _ = admin_app
    rt = app.runtime
    result, data, _ = execute(admin_app, "user.ban", [actors[2].id, actors[3].id])
    with rt.db.write() as conn:
        conn.execute("UPDATE users SET site_role='user' WHERE id=?", (actors[0].id,))
    job = claim_admin(rt)
    rt.admin.process_command(job)
    with rt.db.read() as conn:
        assert (
            conn.execute(
                "SELECT status FROM admin_commands WHERE id=?", (data.operationId,)
            ).fetchone()[0]
            == "cancelled"
        )
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM users WHERE id IN(?,?) AND status='active'",
                (actors[2].id, actors[3].id),
            ).fetchone()[0]
            == 2
        )
    fails("FORBIDDEN", lambda: rt.admin.command(actors[0], result["operationId"]))


async def test_real_metric_samples_alert_and_recovery(admin_app):
    app, actors, _, _, _ = admin_app
    rt = app.runtime
    with rt.db.write() as conn:
        conn.execute(
            "INSERT INTO jobs(id,kind,entity_id,payload_json,status,run_after,created_at) VALUES('fault-job','isolated.fault','','{}','failed',0,?)",
            (now_ms(),),
        )
    sample = rt.metrics.sample()
    rt.admin.sample_alerts(sample)
    monitoring = rt.admin.monitoring(actors[0])
    alert = next(row for row in monitoring["alerts"]["items"] if row["rule"] == "failedJobs")
    assert alert["status"] == "active" and monitoring["queues"]["failed"] == 1
    assert monitoring["storage"]["databaseBytes"] > 0 and monitoring["latest"]["dbWrites"] > 0
    with rt.db.write() as conn:
        conn.execute("UPDATE jobs SET status='completed' WHERE id='fault-job'")
    rt.admin.sample_alerts(rt.metrics.sample())
    assert (
        next(row for row in rt.admin.alerts(actors[0])["items"] if row["id"] == alert["id"])[
            "status"
        ]
        == "resolved"
    )
    assert any("已恢复" in row["text"] for row in rt.events.notifications(actors[0])["items"])
    thresholds = DEFAULT_THRESHOLDS | {"failedJobs": 2}
    execute(admin_app, "monitoring.thresholds", ["instance"], {"values": thresholds})
    assert rt.admin.monitoring(actors[0])["thresholds"]["failedJobs"] == 2


async def test_worker_exhaustion_closes_only_unfinished_command_items(admin_app, monkeypatch):
    app, actors, _, _, _ = admin_app
    rt = app.runtime
    _, data, _ = execute(admin_app, "user.ban", [actors[2].id, actors[3].id])
    apply = rt.admin.apply_item

    def fail_second(conn, actor, command, item):
        if item["ordinal"] == 1:
            raise RuntimeError("isolated worker failure with no user content")
        return apply(conn, actor, command, item)

    monkeypatch.setattr(rt.admin, "apply_item", fail_second)
    runner = JobRunner(rt.jobs, rt.executor, kinds=("admin.execute",))
    runner.handlers["admin.execute"] = rt.admin.process_command

    async def wait_for_job(status):
        async with asyncio.timeout(5):
            while True:
                with rt.db.read() as conn:
                    row = conn.execute(
                        "SELECT * FROM jobs WHERE entity_id=? AND kind='admin.execute'",
                        (data.operationId,),
                    ).fetchone()
                if row["status"] == status and row["attempts"]:
                    return dict(row)
                await asyncio.sleep(0.02)

    runner.start()
    try:
        first = await wait_for_job("pending")
        retry = rt.admin.command(actors[0], data.operationId)
        assert retry["status"] == "running" and retry["succeeded"] == 1 and retry["pending"] == 1
        with rt.db.write() as conn:
            conn.execute("UPDATE jobs SET attempts=4,run_after=0 WHERE id=?", (first["id"],))
        failed = await wait_for_job("failed")
    finally:
        await runner.stop()
    final = rt.admin.command(actors[0], data.operationId)
    assert final["status"] == "partial" and final["succeeded"] == 1
    assert final["failed"] == 1 and final["pending"] == 0
    assert final["items"][1]["code"] == "JOB_EXECUTION_FAILED"
    rt.jobs.fail(failed["id"], "JOB_EXECUTION_FAILED", 5)
    with rt.db.read() as conn:
        assert (
            conn.execute("SELECT status FROM users WHERE id=?", (actors[3].id,)).fetchone()[0]
            == "active"
        )
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM audit_events WHERE action='admin.command.fail' AND subject_id=?",
                (data.operationId,),
            ).fetchone()[0]
            == 1
        )


@pytest.mark.parametrize("broken", ["sample", "alerts"])
async def test_monitor_fault_keeps_session_revalidation_alive(admin_app, monkeypatch, broken):
    rt = admin_app[0].runtime
    checked = []

    def fault(*_):
        raise RuntimeError("isolated metric collection fault")

    async def validate():
        checked.append(True)
        rt._stopping.set()

    if broken == "sample":
        monkeypatch.setattr(rt.metrics, "sample", fault)
    else:
        monkeypatch.setattr(rt.admin, "sample_alerts", fault)
    monkeypatch.setattr(rt, "validate_connections", validate)
    rt._stopping.clear()
    try:
        await rt._sample_metrics()
    finally:
        rt._stopping.set()
    assert checked == [True]
