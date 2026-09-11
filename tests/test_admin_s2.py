from __future__ import annotations

import json
import uuid
from dataclasses import replace

import httpx
import pytest
from test_admin import ORIGIN, PASSWORD, execute, fails, preview, reauth
from test_admin import admin_app as admin_app  # noqa: PLC0414 -- shared isolated fixture
from test_auth import captcha
from test_files import direct, image_bytes, upload, upload_command
from test_groups import create, join

from tongpin.admin.sensitive import query_budget
from tongpin.asgi import create_application
from tongpin.contracts.admin_s2 import ContentSearch, FileRead, FileSearch, SensitiveRead
from tongpin.contracts.base import APIError
from tongpin.contracts.chat import FriendPreferencesInput, MessageInput
from tongpin.contracts.groups import GroupCommand
from tongpin.contracts.interactions import ReportInput
from tongpin.domain.auth import public_user
from tongpin.infra.db import now_ms

pytestmark = pytest.mark.asyncio
REASON = "隔离内容治理核验理由"


def message(rt, actor, conversation, text="治理原始正文 needle_中文", **extra):
    data = MessageInput(
        clientMessageId=str(uuid.uuid4()),
        actorContext=actor.id,
        accessKey=conversation["accessKey"],
        text=text,
        **extra,
    )
    return rt.chat.send(actor, conversation["id"], data)["message"]


def settings_update(fixture, **changes):
    rt, actor = fixture[0].runtime, fixture[1][0]
    current = rt.admin.settings_view(actor)
    return execute(
        fixture,
        "settings.update",
        ["instance"],
        {"expectedVersion": current["version"], "values": current["values"] | changes},
    )


async def test_sensitive_http_reads_current_admin_reason_and_private_context(admin_app):
    app, actors, tokens, _, _ = admin_app
    rt, owner, member = app.runtime, actors[2], actors[3]
    conversation = direct(rt, owner, member)
    sent = message(rt, owner, conversation)
    group = create(rt, owner)["conversation"]
    old = message(rt, owner, group, "加入前的保留上下文")
    join(rt, owner, member, group["id"])
    fails("RESOURCE_UNAVAILABLE", lambda: rt.interactions.get(member, old["id"]))
    read = rt.admin.content_read(
        actors[0], old["id"], SensitiveRead(reason=REASON), "request-context"
    )
    assert read["message"]["text"] == old["text"] and len(read["items"]) >= 1
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=ORIGIN, headers={"Origin": ORIGIN}
    ) as client:
        client.cookies.set(rt.auth.cookie_name, tokens[3])
        client.headers["X-CSRF-Token"] = rt.auth.security.csrf(tokens[3])
        assert (
            await client.post("/api/v1/admin/content/search", json={"reason": REASON})
        ).status_code == 403
        client.cookies.set(rt.auth.cookie_name, tokens[0])
        client.headers["X-CSRF-Token"] = rt.auth.security.csrf(tokens[0])
        assert (
            await client.post("/api/v1/admin/content/search", json={"reason": "  "})
        ).status_code == 422
        response = await client.post(
            "/api/v1/admin/content/search",
            json={
                "reason": REASON,
                "query": "needle_",
                "kind": "direct",
                "senderId": owner.id,
                "limit": 1,
            },
        )
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["total"] == 1 and data["items"][0]["id"] == sent["id"]
        assert "token_hash" not in response.text and "payload_hash" not in response.text
        assert (
            await client.post(
                "/api/v1/admin/content/search", json={"reason": REASON, "fromAt": 9, "until": 1}
            )
        ).status_code == 422
    with rt.db.read() as conn:
        audit_rows = conn.execute(
            "SELECT * FROM audit_events WHERE action LIKE 'admin.read.%'"
        ).fetchall()
        assert len(audit_rows) == 2
        assert sent["text"] not in json.dumps([dict(row) for row in audit_rows], ensure_ascii=False)
        assert old["text"] not in json.dumps([dict(row) for row in audit_rows], ensure_ascii=False)
        assert all(row["reason"] == REASON for row in audit_rows)
    execute(admin_app, "session.revoke", [actors[0].session["id"]], index=1)
    fails(
        "AUTH_REQUIRED",
        lambda: rt.admin.content_read(actors[0], sent["id"], SensitiveRead(reason=REASON)),
    )


async def test_content_lifecycle_projects_quotes_search_bookmarks_and_retained_files(admin_app):
    app, actors, _, _, _ = admin_app
    rt, owner, other = app.runtime, actors[2], actors[3]
    conversation = direct(rt, owner, other)
    image = upload(rt, owner, conversation, image_bytes(), "治理.png")
    sent = message(rt, owner, conversation, attachmentIds=[image["id"]])
    quote = message(
        rt,
        other,
        rt.chat.get(other, conversation["id"]),
        "引用的后续消息",
        replyToMessageId=sent["id"],
    )
    rt.interactions.bookmark(other, sent["id"], True)
    execute(admin_app, "message.review", [sent["id"]])
    execute(admin_app, "message.hide", [sent["id"]])
    hidden = rt.interactions.get(other, sent["id"])["message"]
    assert hidden["status"] == "moderated" and hidden["text"] == "" and hidden["attachments"] == []
    assert rt.interactions.get(other, quote["id"])["message"]["reply"]["status"] == "unavailable"
    assert rt.interactions.search(other, "needle_")["items"] == []
    assert rt.interactions.bookmarks(other)["items"][0]["available"] is False
    fails("RESOURCE_UNAVAILABLE", lambda: rt.files.content(other, image["id"], "content"))
    retained = rt.admin.content_read(actors[0], sent["id"], SensitiveRead(reason=REASON))["message"]
    assert (
        retained["retained"]
        and retained["canRestore"]
        and retained["reviewedBy"]["id"] == actors[0].id
    )
    assert retained["attachments"][0]["contentAvailable"]
    execute(admin_app, "message.restore", [sent["id"]])
    assert rt.interactions.get(other, sent["id"])["message"]["text"] == sent["text"]
    assert rt.files.content(other, image["id"], "content")[0].is_file()
    execute(admin_app, "message.delete", [sent["id"]])
    with rt.db.write() as conn:
        conn.execute(
            "UPDATE messages SET removed_at=? WHERE id=?", (now_ms() - 31 * 86400000, sent["id"])
        )
    expired = rt.admin.content_read(actors[0], sent["id"], SensitiveRead(reason=REASON))["message"]
    assert (
        expired["text"] is None
        and not expired["retained"]
        and not expired["canRestore"]
        and expired["attachments"] == []
    )
    fails("VERSION_CONFLICT", lambda: preview(rt, actors[0], "message.restore", [sent["id"]]))
    assert rt.lifecycle.cleanup()["messagesPurged"] == 1
    with rt.db.read() as conn:
        row = conn.execute("SELECT status,text FROM messages WHERE id=?", (sent["id"],)).fetchone()
        assert row[:] == ("purged", "")
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM user_events WHERE kind='message.updated' AND entity_ref=?",
                (sent["id"],),
            ).fetchone()[0]
            >= 6
        )
    fresh = message(rt, owner, conversation, "主动撤回不能管理复原")
    rt.interactions.remove(owner, fresh["id"])
    fails("VERSION_CONFLICT", lambda: preview(rt, actors[0], "message.restore", [fresh["id"]]))


async def test_sensitive_pages_and_sql_budget_are_bounded(admin_app):
    app, actors, _, _, _ = admin_app
    rt = app.runtime
    conversation = direct(rt, actors[2], actors[3])
    ids = [message(rt, actors[2], conversation, "分页" + str(i))["id"] for i in range(4)]
    first = rt.admin.content_search(
        actors[0], ContentSearch(reason=REASON, limit=2, conversationId=conversation["id"])
    )
    second = rt.admin.content_search(
        actors[0],
        ContentSearch(
            reason=REASON, limit=2, conversationId=conversation["id"], after=first["nextCursor"]
        ),
    )
    assert first["total"] == 4 and {row["id"] for row in first["items"] + second["items"]} == set(
        ids
    )
    assert second["nextCursor"] is None
    with rt.db.read() as conn:
        with pytest.raises(APIError) as caught, query_budget(conn):
            conn.execute(
                "WITH RECURSIVE numbers(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM numbers WHERE n<10000000) SELECT SUM(n) FROM numbers"
            ).fetchone()
        assert caught.value.code == "QUERY_TOO_BROAD"
        assert conn.execute("SELECT 1").fetchone()[0] == 1


async def test_file_overlay_private_download_and_scan_state_stay_independent(admin_app):
    app, actors, tokens, _, _ = admin_app
    rt, owner, other = app.runtime, actors[2], actors[3]
    conversation = direct(rt, owner, other)
    data = image_bytes()
    image = upload(rt, owner, conversation, data, "审阅图.png")
    sent = message(rt, owner, conversation, attachmentIds=[image["id"]])
    execute(admin_app, "file.quarantine", [image["id"]])
    assert rt.files.get(other, image["id"])["errorCode"] == "FILE_RESTRICTED"
    assert rt.interactions.get(other, sent["id"])["message"]["attachments"][0]["contentUrl"] == ""
    fails("FILE_RESTRICTED", lambda: rt.files.content(other, image["id"], "preview"))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=ORIGIN, headers={"Origin": ORIGIN}
    ) as client:
        client.cookies.set(rt.auth.cookie_name, tokens[0])
        client.headers["X-CSRF-Token"] = rt.auth.security.csrf(tokens[0])
        response = await client.post(
            f"/api/v1/admin/files/{image['id']}/content",
            json={"reason": REASON, "variant": "content"},
        )
        assert response.status_code == 200 and response.content == data
        assert "no-store" in response.headers["Cache-Control"]
        assert response.headers["X-Content-Type-Options"] == "nosniff"
        assert (await client.get(f"/api/v1/admin/files/{image['id']}/content")).status_code in (
            404,
            405,
        )
    execute(admin_app, "file.release", [image["id"]])
    assert rt.files.content(other, image["id"], "content")[0].read_bytes() == data
    execute(admin_app, "file.revoke", [image["id"]])
    assert (
        rt.admin.files_search(actors[0], FileSearch(reason=REASON, governance="revoked"))["items"][
            0
        ]["id"]
        == image["id"]
    )
    document = upload(rt, owner, conversation, b"unscanned text document", "待扫描.txt")
    assert document["state"] == "quarantined"
    execute(admin_app, "file.quarantine", [document["id"]])
    execute(admin_app, "file.release", [document["id"]])
    current = rt.admin.file_read(actors[0], document["id"], SensitiveRead(reason=REASON))["file"]
    assert current["state"] == "quarantined" and not current["contentAvailable"]
    fails(
        "RESOURCE_UNAVAILABLE",
        lambda: rt.admin.file_content(actors[0], document["id"], FileRead(reason=REASON)),
    )


async def test_quota_reduction_preserves_bytes_and_blocks_only_new_uploads(admin_app):
    app, actors, _, _, _ = admin_app
    rt, owner = app.runtime, actors[2]
    conversation = direct(rt, owner, actors[3])
    image = upload(rt, owner, conversation, image_bytes(), "配额已有图.png")
    message(rt, owner, conversation, attachmentIds=[image["id"]])
    path = rt.files.content(owner, image["id"], "content")[0]
    before = path.read_bytes()
    result, _, _ = execute(admin_app, "user.quota", [owner.id], {"quotaBytes": 1024})
    assert result["succeeded"] == 1 and rt.files.policy(owner)["userQuota"] == 1024
    fails(
        "USER_QUOTA_EXCEEDED",
        lambda: rt.files.reserve(owner, upload_command(owner, conversation, b"a" * 1500)),
    )
    assert path.read_bytes() == before
    execute(admin_app, "user.quota", [owner.id], {"quotaBytes": None})
    assert rt.files.policy(owner)["userQuota"] == rt.policy.get()["user_quota_bytes"]


def report_message(rt, reporter, mid):
    return rt.interactions.report(
        reporter,
        ReportInput(
            clientReportId=str(uuid.uuid4()),
            targetKind="message",
            targetId=mid,
            category="harassment",
            description="举报说明仅在带理由的详情中读取",
        ),
    )["report"]


async def test_report_workflow_linked_disposition_feedback_and_idempotency(admin_app):
    app, actors, tokens, _, _ = admin_app
    rt, sender, reporter = app.runtime, actors[2], actors[3]
    conversation = direct(rt, sender, reporter)
    sent = message(rt, sender, conversation)
    report = report_message(rt, reporter, sent["id"])
    summary = rt.admin.reports_list(actors[0])["items"][0]
    assert "description" not in summary and "feedback" not in summary
    detail = rt.admin.report_read(actors[0], report["id"], SensitiveRead(reason=REASON))
    assert (
        detail["target"]["id"] == sent["id"]
        and detail["report"]["description"] == report["description"]
    )
    bad = {
        "feedback": "核查后采取关联处置",
        "disposition": {"action": "user.ban", "targetId": actors[4].id},
    }
    fails("VERSION_CONFLICT", lambda: preview(rt, actors[0], "report.resolve", [report["id"]], bad))
    execute(admin_app, "report.claim", [report["id"]])
    result, _, credential = execute(
        admin_app,
        "report.resolve",
        [report["id"]],
        {
            "feedback": "核查完成，已对消息发送者采取限制。",
            "disposition": {"action": "user.ban", "targetId": sender.id},
        },
    )
    assert result["status"] == "completed"
    assert rt.admin.execute(actors[0], credential) == result
    fails("AUTH_REQUIRED", lambda: rt.auth.load(tokens[2]))
    ordinary = rt.interactions.reports(reporter)["items"][0]
    assert (
        ordinary["status"] == "resolved"
        and ordinary["feedback"] == "核查完成，已对消息发送者采取限制。"
    )
    assert any(
        item.get("reportId") == report["id"] for item in rt.events.notifications(reporter)["items"]
    )
    with rt.db.read() as conn:
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM audit_events WHERE action='admin.report.disposition' AND subject_id=?",
                (sender.id,),
            ).fetchone()[0]
            == 1
        )
    execute(admin_app, "report.reopen", [report["id"]])
    assert (
        rt.admin.report_read(actors[0], report["id"], SensitiveRead(reason=REASON))["report"][
            "status"
        ]
        == "open"
    )
    execute(admin_app, "report.reject", [report["id"]], {"feedback": "补充核查后关闭本次工单。"})
    assert rt.interactions.reports(reporter)["items"][0]["status"] == "rejected"


async def test_linked_report_failure_rolls_back_disposition_and_receipt_state(
    admin_app, monkeypatch
):
    app, actors, _, _, _ = admin_app
    rt = app.runtime
    conversation = direct(rt, actors[2], actors[3])
    report = report_message(rt, actors[3], message(rt, actors[2], conversation)["id"])
    original = rt.admin.apply_user

    def interrupted(*args):
        original(*args)
        raise APIError("CONTROLLED_FAILURE", "隔离故障", 409)

    monkeypatch.setattr(rt.admin, "apply_user", interrupted)
    result, _, _ = execute(
        admin_app,
        "report.resolve",
        [report["id"]],
        {
            "feedback": "关联处置应当一同保存",
            "disposition": {"action": "user.ban", "targetId": actors[2].id},
        },
    )
    assert result["status"] == "failed" and result["items"][0]["code"] == "CONTROLLED_FAILURE"
    with rt.db.read() as conn:
        assert (
            conn.execute("SELECT status FROM users WHERE id=?", (actors[2].id,)).fetchone()[0]
            == "active"
        )
        assert conn.execute(
            "SELECT status,feedback FROM reports WHERE id=?", (report["id"],)
        ).fetchone()[:] == ("open", None)
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM report_events WHERE report_id=?", (report["id"],)
            ).fetchone()[0]
            == 1
        )


async def test_settings_apply_conflict_rollback_restart_and_current_limits(admin_app):
    app, actors, tokens, factors, _ = admin_app
    rt = app.runtime
    conversation = direct(rt, actors[2], actors[3])
    baseline = rt.admin.settings_view(actors[0])
    result, _, _ = settings_update(
        admin_app,
        message_codepoints=3,
        user_quota_bytes=2048,
        online_notifications=False,
        deleted_content_days=20,
    )
    assert result["succeeded"] == 1
    initial_versions = rt.admin.settings_versions(actors[0])["items"]
    assert [row["version"] for row in initial_versions] == [1, 0]
    assert initial_versions[-1]["values"] == baseline["values"]
    fails("PAYLOAD_TOO_LARGE", lambda: message(rt, actors[2], conversation, "四个汉字"))
    assert rt.files.policy(actors[2])["userQuota"] == 2048
    assert "20天" in rt.policy.terms()["text"]
    pending = preview(
        rt,
        actors[0],
        "settings.rollback",
        ["instance"],
        {"expectedVersion": 1, "version": baseline["version"]},
    )
    credential = reauth(rt, actors[0], pending.operationId, factors[0].pop())
    # A genuine concurrent policy update must not consume the older confirmation.
    execute(
        admin_app,
        "monitoring.thresholds",
        ["instance"],
        {"values": rt.admin.monitoring(actors[0])["thresholds"] | {"cpuPercent": 80}},
    )
    fails("VERSION_CONFLICT", lambda: rt.admin.execute(actors[0], credential))
    with rt.db.read() as conn:
        assert (
            conn.execute(
                "SELECT consumed_at FROM reauth_tokens WHERE digest=?",
                (rt.auth.security.digest(credential.reauthToken, "reauth"),),
            ).fetchone()[0]
            is None
        )
    execute(admin_app, "settings.rollback", ["instance"], {"expectedVersion": 2, "version": 0})
    assert rt.admin.settings_view(actors[0])["values"] == baseline["values"]
    assert rt.policy.get()["monitoring_thresholds"]["cpuPercent"] == 80
    assert rt.admin.settings_versions(actors[0], limit=2)["nextCursor"]
    await rt.stop()
    restarted = create_application(rt.settings)
    await restarted.runtime.start()
    try:
        current = restarted.runtime.auth.load(tokens[0])
        assert restarted.runtime.admin.settings_view(current)["version"] == 3
        assert restarted.runtime.policy.get()["message_codepoints"] == 4000
        with restarted.runtime.db.read() as conn:
            assert not conn.execute("PRAGMA foreign_key_check").fetchall()
    finally:
        await restarted.runtime.stop()


async def test_site_invite_one_time_reveal_real_registration_and_revoke(admin_app):
    app, actors, _, _, _ = admin_app
    rt = app.runtime
    settings_update(admin_app, registration_mode="invite-only")
    result, data, _ = execute(
        admin_app, "site_invite.create", ["instance"], {"maxUses": 1, "expiresInHours": 1}
    )
    assert result["secretAvailable"] and "credential" not in json.dumps(result)
    secret = rt.admin.reveal_secret(actors[0], data.operationId)
    assert secret["kind"] == "site_invite"
    fails("SECRET_UNAVAILABLE", lambda: rt.admin.reveal_secret(actors[0], data.operationId))
    for index, expected in ((0, 201), (1, 403)):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url=ORIGIN, headers={"Origin": ORIGIN}
        ) as client:
            bootstrap = (await client.get("/api/v1/auth/bootstrap")).json()["data"]
            client.headers["X-CSRF-Token"] = bootstrap["csrfToken"]
            response = await client.post(
                "/api/v1/auth/register",
                json={
                    "username": "s2_invited_" + str(index),
                    "nickname": "站点邀请验收",
                    "password": PASSWORD + "New",
                    "acceptTerms": True,
                    "termsVersion": bootstrap["terms"]["version"],
                    "siteInvite": secret["credential"],
                    **await captcha(client),
                },
            )
            assert response.status_code == expected, response.text
    invitation = rt.admin.site_invites(actors[0])["items"][0]
    assert invitation["used"] == 1 and invitation["status"] == "exhausted"
    execute(admin_app, "site_invite.revoke", [invitation["id"]])
    assert rt.admin.site_invites(actors[0])["items"][0]["status"] == "revoked"
    with rt.db.read() as conn:
        serialized = json.dumps(
            [dict(row) for row in conn.execute("SELECT * FROM site_invites")]
            + [dict(row) for row in conn.execute("SELECT * FROM audit_events")]
        )
        assert secret["credential"] not in serialized


async def test_settings_validation_runtime_rate_and_maintenance(admin_app):
    app, actors, _, _, _ = admin_app
    rt = app.runtime
    current = rt.admin.settings_view(actors[0])
    fails(
        "VALIDATION_ERROR",
        lambda: preview(
            rt,
            actors[0],
            "settings.update",
            ["instance"],
            {
                "expectedVersion": current["version"],
                "values": current["values"] | {"message_codepoints": True},
            },
        ),
    )
    production = rt.settings
    rt.settings = replace(production, environment="production")
    try:
        fails(
            "PRODUCTION_PRECHECK_FAILED",
            lambda: preview(
                rt,
                actors[0],
                "settings.update",
                ["instance"],
                {
                    "expectedVersion": current["version"],
                    "values": current["values"] | {"registration_mode": "open"},
                },
            ),
        )
    finally:
        rt.settings = production
    settings_update(admin_app, message_per_minute=1)
    conversation = direct(rt, actors[2], actors[3])
    message(rt, actors[2], conversation, "第一条")
    fails("RATE_LIMITED", lambda: message(rt, actors[2], conversation, "第二条"))
    settings_update(admin_app, maintenance=True)
    fails("MAINTENANCE", lambda: create(rt, actors[3]))
    assert rt.admin.settings_view(actors[0])["values"]["maintenance"]
    settings_update(admin_app, maintenance=False)
    assert create(rt, actors[3])["conversation"]["id"]


async def test_avatar_governance_removes_display_urls_and_blocks_rebinding(admin_app):
    app, actors, tokens, _, _ = admin_app
    rt, owner, peer = app.runtime, actors[2], actors[3]
    conversation = direct(rt, owner, peer)
    avatar = upload(rt, owner, None, image_bytes(), "头像.png", purpose="user_avatar")
    rt.files.set_avatar(owner, avatar["id"])
    assert rt.chat.get(peer, conversation["id"])["peer"]["avatarUrl"]
    execute(admin_app, "file.quarantine", [avatar["id"]])
    assert rt.chat.get(peer, conversation["id"])["peer"]["avatarUrl"] is None
    assert public_user(rt.auth.load(tokens[2]).user)["avatarUrl"] is None
    fails("FILE_RESTRICTED", lambda: rt.files.avatar(peer, uid=owner.id))
    execute(admin_app, "file.release", [avatar["id"]])
    assert rt.chat.get(peer, conversation["id"])["peer"]["avatarUrl"]
    group = create(rt, owner)["conversation"]
    group_avatar = upload(rt, owner, group, image_bytes(), "群头像.png", purpose="group_avatar")
    rt.files.set_avatar(
        owner, group_avatar["id"], group["id"], rt.groups.get(owner, group["id"])["version"]
    )
    execute(admin_app, "file.revoke", [group_avatar["id"]])
    assert rt.chat.get(owner, group["id"])["avatarUrl"] is None
    candidate = upload(rt, owner, None, image_bytes(), "未绑定头像.png", purpose="user_avatar")
    execute(admin_app, "file.quarantine", [candidate["id"]])
    fails("FILE_NOT_READY", lambda: rt.files.set_avatar(owner, candidate["id"]))
    fails("RESOURCE_UNAVAILABLE", lambda: rt.files.guard_upload(peer, candidate["id"]))


async def test_group_limit_and_online_notice_policy_apply_to_real_domain_paths(admin_app):
    from test_groups import link

    app, actors, tokens, _, _ = admin_app
    rt, owner, peer, third = app.runtime, actors[2], actors[3], actors[4]
    direct(rt, owner, peer)
    rt.contacts.preferences(peer, owner.id, FriendPreferencesInput(notifyOnline=True))
    await rt.connected("s2-online-policy", rt.auth.load(tokens[2]))
    rt._presence_cooldown.clear()
    assert next(item[1] for item in rt._presence_audience(owner.id) if item[0] == peer.id)["notify"]
    group = create(rt, owner)["conversation"]
    join(rt, owner, peer, group["id"])
    join(rt, owner, third, group["id"])
    settings_update(admin_app, group_limit=2, online_notifications=False)
    rt._presence_cooldown.clear()
    assert not next(item[1] for item in rt._presence_audience(owner.id) if item[0] == peer.id)[
        "notify"
    ]
    assert rt.groups.get(owner, group["id"])["conversation"]["memberCount"] == 3
    invitation = link(rt, owner, group["id"])
    with pytest.raises(APIError) as caught:
        rt.groups.invites.apply(
            actors[5],
            invitation["invite"]["id"],
            GroupCommand(clientRequestId=str(uuid.uuid4())),
            invitation["token"],
        )
    assert caught.value.code == "GROUP_FULL"
