from __future__ import annotations

import hashlib
import json
import uuid
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
import pytest_asyncio
from pydantic import ValidationError
from test_files import image_bytes, upload
from test_groups import befriend, create, join

from tongpin.asgi import create_application
from tongpin.contracts.auth import PreferencesInput
from tongpin.contracts.base import APIError
from tongpin.contracts.chat import (
    ConversationPreferencesInput,
    FriendPreferencesInput,
    MessageInput,
)
from tongpin.contracts.interactions import ReportInput
from tongpin.domain.emoji import emoji_keys
from tongpin.infra.db import now_ms

pytestmark = pytest.mark.asyncio
ORIGIN = "http://127.0.0.1:8765"


@pytest_asyncio.fixture
async def rich(settings):
    app = create_application(settings)
    await app.runtime.start()
    await app.runtime.runner.stop()
    await app.runtime.file_runner.stop()
    rt, tokens = app.runtime, []
    with rt.db.write() as conn:
        for number in range(4):
            user = rt.auth.create_user(
                conn, f"rich_actor_{number}", f"交互账号{number}", "isolated-unused-hash"
            )
            token, _ = rt.auth.issue_session(conn, user, False, "isolated interaction test")
            tokens.append(token)
    actors = [rt.auth.load(token) for token in tokens]
    try:
        yield app, actors, tokens
    finally:
        await rt.stop()


def key():
    return str(uuid.uuid4())


def error(code, call):
    with pytest.raises(APIError) as caught:
        call()
    assert caught.value.code == code


def direct(rt, one, two):
    befriend(rt, one, two)
    return rt.chat.direct(one, two.id)


def send(rt, actor, conversation, value="新消息中文", **changes):
    data = MessageInput(
        clientMessageId=key(),
        accessKey=rt.chat.get(actor, conversation["id"])["accessKey"],
        text=value,
        **changes,
    )
    return rt.chat.send(actor, conversation["id"], data)["message"], data


async def test_reaction_idempotence_count_and_current_authorization(rich):
    app, (one, two, other, _), _ = rich
    rt = app.runtime
    conversation = direct(rt, one, two)
    message, _ = send(rt, one, conversation)
    mid, emoji = message["id"], "1F44D-1F3FD"
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _: rt.interactions.reaction(two, mid, emoji, True), range(2)))
    assert rt.interactions.reaction(one, mid, emoji, True)["message"]["reactions"] == [
        {"key": "👍🏽", "count": 2, "mine": True}
    ]
    rt.interactions.reaction(one, mid, emoji, False)
    rt.interactions.reaction(one, mid, emoji, False)
    assert rt.interactions.get(one, mid)["message"]["reactions"][0] == {
        "key": "👍🏽",
        "count": 1,
        "mine": False,
    }
    error("RESOURCE_UNAVAILABLE", lambda: rt.interactions.reaction(other, mid, emoji, True))
    error("VALIDATION_ERROR", lambda: rt.interactions.reaction(one, mid, "1F3FD", True))
    rt.contacts.set_block(two, one.id, True)
    error("CONTACT_UNAVAILABLE", lambda: rt.interactions.reaction(one, mid, emoji, True))
    assert not rt.interactions.get(one, mid)["message"]["capabilities"]["canInteract"]


async def test_reaction_budget_mute_and_rollback(rich, monkeypatch):
    app, (one, two, _, _), _ = rich
    rt = app.runtime
    conversation = direct(rt, one, two)
    message, _ = send(rt, one, conversation)
    mid = message["id"]
    keys = list(emoji_keys())[:9]
    for emoji in keys[:8]:
        rt.interactions.reaction(one, mid, emoji, True)
    error("REACTION_LIMIT", lambda: rt.interactions.reaction(one, mid, keys[8], True))
    with rt.db.write() as conn:
        conn.execute("UPDATE users SET muted_until=? WHERE id=?", (now_ms() + 100000, two.id))
    error("MUTED", lambda: rt.interactions.reaction(two, mid, keys[0], True))
    original = rt.events.publish
    monkeypatch.setattr(
        rt.events,
        "publish",
        lambda *args: (_ for _ in ()).throw(RuntimeError("controlled publication failure")),
    )
    with pytest.raises(RuntimeError):
        rt.interactions.reaction(one, mid, keys[0], False)
    monkeypatch.setattr(rt.events, "publish", original)
    assert len(rt.interactions.get(one, mid)["message"]["reactions"]) == 8


async def test_mention_all_role_membership_notification_and_old_payload_hash(rich):
    app, (owner, participant, outsider, _), _ = rich
    rt = app.runtime
    group = create(rt, owner)["conversation"]
    join(rt, owner, participant, group["id"])
    # The same strict body reaches HTTP and Socket.IO through MessageInput.
    error("FORBIDDEN", lambda: send(rt, participant, group, "@全体", mentionAll=True))
    error(
        "VALIDATION_ERROR",
        lambda: send(rt, owner, group, "未知成员", mentionedUserIds=[outsider.id]),
    )
    message, command = send(rt, owner, group, "全体通知", mentionAll=True)
    assert message["mentionAll"] is True
    assert rt.chat.send(owner, group["id"], command)["duplicate"] is True
    notes = rt.events.notifications(participant)["items"]
    mentions = [row for row in notes if row["type"] == "message.mentioned"]
    assert len(mentions) == 1 and mentions[0]["messageId"] == message["id"]
    assert rt.events.notifications(owner)["unreadCount"] == 1  # join application only
    normal, old = send(rt, owner, group, "普通幂等消息")
    payload = {
        "conversationId": group["id"],
        "text": old.text,
        "attachmentIds": [],
        "replyToMessageId": None,
        "mentionedUserIds": [],
        "accessKey": old.accessKey,
    }
    expected = hashlib.sha256(
        json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()
    with rt.db.read() as conn:
        assert (
            conn.execute(
                "SELECT payload_hash FROM messages WHERE id=?", (normal["id"],)
            ).fetchone()[0]
            == expected
        )
    rt.groups.leave(participant, group["id"])
    stale = next(
        item
        for item in rt.events.notifications(participant)["items"]
        if item["type"] == "message.mentioned"
    )
    assert (
        stale["available"] is False and "messageId" not in stale and "conversationId" not in stale
    )


async def test_recall_tombstone_hides_quotes_files_search_bookmarks_and_sync(rich):
    app, (one, two, _, _), _ = rich
    rt = app.runtime
    conversation = direct(rt, one, two)
    file = upload(rt, one, conversation, image_bytes(), "source.png")
    message, _ = send(
        rt,
        one,
        conversation,
        "被撤回的中文原文",
        attachmentIds=[file["id"]],
        mentionedUserIds=[two.id],
    )
    reply, _ = send(rt, two, conversation, "我的回复仍在", replyToMessageId=message["id"])
    rt.interactions.bookmark(two, message["id"], True)
    rt.interactions.reaction(two, message["id"], "1F44D", True)
    cursor = rt.events.snapshot(two)["cursor"]
    withdrawn = rt.interactions.remove(one, message["id"])["message"]
    assert (
        withdrawn["status"] == "recalled"
        and withdrawn["text"] == ""
        and withdrawn["attachments"] == []
        and withdrawn["reactions"] == []
    )
    assert rt.interactions.remove(one, message["id"])["message"]["id"] == message["id"]
    error("RESOURCE_UNAVAILABLE", lambda: rt.files.content(two, file["id"], "content"))
    quote = rt.interactions.get(two, reply["id"])["message"]["reply"]
    assert quote["status"] == "unavailable" and quote["text"] == ""
    assert rt.interactions.search(two, "被撤回")["items"] == []
    saved = rt.interactions.bookmarks(two)["items"][0]
    assert (
        saved["available"] is False and saved["message"] is None and saved["conversation"] is None
    )
    assert rt.events.sync(two, cursor)["items"][0]["message"]["text"] == ""
    error(
        "RESOURCE_UNAVAILABLE", lambda: rt.interactions.reaction(two, message["id"], "1F44D", True)
    )
    with rt.db.read() as conn:
        assert (
            conn.execute("SELECT text FROM messages WHERE id=?", (message["id"],)).fetchone()[0]
            == "被撤回的中文原文"
        )


async def test_recall_deadline_and_group_moderation_do_not_elevate_role(rich, monkeypatch):
    app, (owner, admin, participant, outsider), _ = rich
    rt = app.runtime
    group = create(rt, owner)["conversation"]
    join(rt, owner, admin, group["id"])
    join(rt, owner, participant, group["id"])
    with rt.db.write() as conn:
        conn.execute(
            "UPDATE memberships SET role='admin' WHERE conversation_id=? AND user_id=? AND left_at IS NULL",
            (group["id"], admin.id),
        )
    msg, _ = send(rt, participant, group)
    privileged, _ = send(rt, admin, group)
    error(
        "FORBIDDEN",
        lambda: rt.interactions.remove(
            participant, privileged["id"], moderation=True, reason="不能提权"
        ),
    )
    error(
        "FORBIDDEN",
        lambda: rt.interactions.remove(
            admin, privileged["id"], moderation=True, reason="管理员不能删除管理员消息"
        ),
    )
    error(
        "RESOURCE_UNAVAILABLE",
        lambda: rt.interactions.remove(outsider, msg["id"], moderation=True, reason="外人"),
    )
    error(
        "VALIDATION_ERROR",
        lambda: rt.interactions.remove(admin, msg["id"], moderation=True, reason="  "),
    )
    moderated = rt.interactions.remove(admin, msg["id"], moderation=True, reason="受控规则测试")[
        "message"
    ]
    assert moderated["status"] == "moderated"
    assert (
        rt.interactions.remove(owner, privileged["id"], moderation=True, reason="群主处置")[
            "message"
        ]["status"]
        == "moderated"
    )
    own, _ = send(rt, owner, group)
    monkeypatch.setattr("tongpin.domain.interactions.now_ms", lambda: own["createdAt"] + 120001)
    error("RECALL_EXPIRED", lambda: rt.interactions.remove(owner, own["id"]))
    with rt.db.read() as conn:
        records = conn.execute(
            "SELECT reason,details FROM audit_events WHERE action='group.message.moderate'"
        ).fetchall()
        assert len(records) == 2 and all("新消息中文" not in row["details"] for row in records)


async def test_search_chinese_literals_paging_context_and_group_period(rich):
    app, (owner, participant, other, _), _ = rich
    rt = app.runtime
    group = create(rt, owner)["conversation"]
    early, _ = send(rt, owner, group, "旧期中文记录")
    join(rt, owner, participant, group["id"])
    first, _ = send(rt, owner, group, "现在中文100%_!准确")
    second, _ = send(rt, owner, group, "现在中文普通")
    third, _ = send(rt, owner, group, "现在中文分页")
    assert [row["id"] for row in rt.interactions.search(participant, "%_!")["items"]] == [
        first["id"]
    ]
    assert rt.interactions.search(participant, "旧期")["items"] == []
    p1 = rt.interactions.search(participant, "现在中文", limit=2)
    p2 = rt.interactions.search(participant, "现在中文", after=p1["nextCursor"], limit=2)
    assert {row["id"] for row in p1["items"] + p2["items"]} == {
        first["id"],
        second["id"],
        third["id"],
    }
    assert rt.interactions.search(other, "中文")["items"] == []
    error("RESOURCE_UNAVAILABLE", lambda: rt.interactions.context(participant, early["id"]))
    context = rt.interactions.context(participant, second["id"])
    assert context["targetId"] == second["id"] and early["id"] not in {
        m["id"] for m in context["items"]
    }
    rt.interactions.bookmark(participant, first["id"], True)
    rt.groups.leave(participant, group["id"])
    join(rt, owner, participant, group["id"])
    assert rt.interactions.bookmarks(participant)["items"][0]["available"] is False
    error("RESOURCE_UNAVAILABLE", lambda: rt.interactions.context(participant, first["id"]))
    assert rt.interactions.bookmark(participant, first["id"], False)["bookmarked"] is False
    assert rt.interactions.bookmarks(owner)["items"] == []


async def test_search_timeout_clears_sql_progress_handler(rich, monkeypatch):
    app, (one, two, _, _), _ = rich
    rt = app.runtime
    conversation = direct(rt, one, two)
    with rt.db.write() as conn:
        stamp = now_ms()
        for seq in range(1, 151):
            conn.execute(
                "INSERT INTO messages(id,conversation_id,seq,sender_id,payload_hash,text,created_at) VALUES(?,?,?,?,'test',?,?)",
                (f"test-{seq}", conversation["id"], seq, one.id, "中文" * 100, stamp),
            )
        conn.execute("UPDATE conversations SET last_seq=150 WHERE id=?", (conversation["id"],))
    clock = iter([0] + [1] * 100)
    monkeypatch.setattr("tongpin.domain.interactions.time.monotonic", lambda: next(clock))
    error("SEARCH_TOO_BROAD", lambda: rt.interactions.search(one, "绝无匹配"))
    with rt.db.read() as conn:
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


async def test_friend_remark_and_mentions_only_are_private_and_persistent(rich):
    app, (one, two, third, _), _ = rich
    rt = app.runtime
    conversation = direct(rt, one, two)
    result = rt.contacts.preferences(one, two.id, FriendPreferencesInput(remark="仅自己知道的备注"))
    assert result == {"notifyOnline": False, "remark": "仅自己知道的备注"}
    assert rt.chat.get(one, conversation["id"])["title"] == result["remark"]
    assert rt.chat.get(two, conversation["id"])["title"] == one.user["nickname"]
    assert rt.contacts.search(third, "rich_actor_1")["items"][0]["remark"] == ""
    rt.contacts.preferences(one, two.id, FriendPreferencesInput(notifyOnline=True))
    assert rt.contacts.list(one)["items"][0]["remark"] == result["remark"]
    view = rt.chat.preferences(
        one, conversation["id"], ConversationPreferencesInput(onlyMentions=True)
    )
    assert view["preferences"]["onlyMentions"] is True
    assert rt.chat.get(two, conversation["id"])["preferences"]["onlyMentions"] is False
    error(
        "VALIDATION_ERROR", lambda: rt.contacts.preferences(one, two.id, FriendPreferencesInput())
    )


async def test_typing_is_ephemeral_throttled_and_revoked_by_current_policy(rich, monkeypatch):
    app, (one, two, other, _), _ = rich
    rt = app.runtime
    conversation = direct(rt, one, two)
    with rt.db.read() as conn:
        before = conn.execute("SELECT COUNT(*) FROM user_events").fetchone()[0]
    active = rt.interactions.typing(one, conversation["id"], True)
    assert rt.interactions.typing(one, conversation["id"], True) == active
    assert rt.interactions.typing(two, conversation["id"])["items"][0]["id"] == one.id
    error("RESOURCE_UNAVAILABLE", lambda: rt.interactions.typing(other, conversation["id"]))
    monkeypatch.setattr("tongpin.domain.interactions.now_ms", lambda: active["expiresAt"] + 1)
    assert rt.interactions.typing(two, conversation["id"])["items"] == []
    monkeypatch.undo()
    rt.auth.preferences(one, PreferencesInput(invisible=True))
    assert rt.interactions.typing(two, conversation["id"])["items"] == []
    rt.auth.preferences(one, PreferencesInput(invisible=False))
    rt.contacts.set_block(two, one.id, True)
    assert rt.interactions.typing(two, conversation["id"])["items"] == []
    error("CONTACT_UNAVAILABLE", lambda: rt.interactions.typing(one, conversation["id"], True))
    with rt.db.read() as conn:
        assert (
            conn.execute("SELECT COUNT(*) FROM user_events WHERE kind LIKE 'typing.%'").fetchone()[
                0
            ]
            == 0
        )
        assert conn.execute("SELECT COUNT(*) FROM user_events").fetchone()[0] >= before


async def test_report_deduplicates_preserves_reason_and_owner_only_list(rich):
    app, (one, two, other, _), _ = rich
    rt = app.runtime
    conversation = direct(rt, one, two)
    message, _ = send(rt, one, conversation)
    data = ReportInput(
        clientReportId=key(),
        targetKind="message",
        targetId=message["id"],
        category="spam",
        description="受控举报说明，不是处罚决定",
    )
    first = rt.interactions.report(two, data)
    assert not first["duplicate"] and first["report"]["status"] == "open"
    assert rt.interactions.report(two, data)["duplicate"] is True
    assert len(rt.interactions.reports(two)["items"]) == 1
    assert rt.interactions.reports(one)["items"] == []
    error(
        "IDEMPOTENCY_CONFLICT",
        lambda: rt.interactions.report(two, data.model_copy(update={"description": "不同说明"})),
    )
    error(
        "RESOURCE_UNAVAILABLE",
        lambda: rt.interactions.report(other, data.model_copy(update={"clientReportId": key()})),
    )
    with pytest.raises(ValidationError):
        ReportInput(
            clientReportId="x" * 36,
            targetKind="user",
            targetId=one.id,
            category="other",
            description="无效标识",
        )


async def test_http_adapter_real_authorization_validation_and_ids(rich):
    app, (one, two, _, _), tokens = rich
    rt = app.runtime
    conversation = direct(rt, one, two)
    msg, _ = send(rt, one, conversation, "HTTP中文接口")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=ORIGIN, headers={"Origin": ORIGIN}
    ) as client:
        client.cookies.set("tp_session", tokens[1])
        client.headers["X-CSRF-Token"] = rt.auth.security.csrf(tokens[1])
        reaction = await client.put(f"/api/v1/messages/{msg['id']}/reactions/1F44D", json={})
        assert (
            reaction.status_code == 200
            and reaction.json()["data"]["message"]["reactions"][0]["count"] == 1
        )
        result = await client.get("/api/v1/messages/search", params={"q": "中文"})
        assert result.status_code == 200 and result.json()["data"]["items"][0]["id"] == msg["id"]
        assert (
            await client.put(f"/api/v1/messages/{msg['id']}/bookmark", json={})
        ).status_code == 200
        assert (await client.get(f"/api/v1/messages/{msg['id']}/context")).json()["data"][
            "targetId"
        ] == msg["id"]
        invalid = await client.post(
            "/api/v1/reports",
            json={
                "clientReportId": "x" * 36,
                "targetKind": "message",
                "targetId": msg["id"],
                "category": "spam",
                "description": "example",
            },
        )
        assert invalid.status_code == 422
        client.cookies.set("tp_session", tokens[2])
        assert (await client.get(f"/api/v1/messages/{msg['id']}")).status_code == 404
    with rt.db.read() as conn:
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
