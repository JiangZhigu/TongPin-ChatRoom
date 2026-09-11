from __future__ import annotations

import asyncio
import uuid
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
import pytest_asyncio
from pydantic import ValidationError

from tongpin.asgi import create_application
from tongpin.contracts.auth import PreferencesInput
from tongpin.contracts.base import APIError
from tongpin.contracts.chat import FriendPreferencesInput, FriendRequestInput, MessageInput
from tongpin.infra.db import now_ms

ORIGIN = "http://127.0.0.1:8765"
pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture
async def chat_app(settings):
    app = create_application(settings)
    await app.runtime.start()
    runtime = app.runtime
    tokens = []
    with runtime.db.write() as conn:
        for index in range(3):
            user = runtime.auth.create_user(conn, f"actor_{index}", f"昵称 {index}", "isolated-unused-password-hash")
            token, _ = runtime.auth.issue_session(conn, user, False, "isolated test")
            tokens.append(token)
    actors = [runtime.auth.load(token) for token in tokens]
    try:
        yield app, actors, tokens
    finally:
        await runtime.stop()


def befriend(runtime, one, two):
    pending = runtime.contacts.request(one, FriendRequestInput(targetUserId=two.id))
    runtime.contacts.decide(two, pending["request"]["id"], "accept")


def direct(runtime, one, two):
    befriend(runtime, one, two)
    return runtime.chat.direct(one, two.id)


def command(conversation, text="hello", **changes):
    return MessageInput(clientMessageId=str(uuid.uuid4()), accessKey=conversation["accessKey"], text=text, **changes)


def expect_error(code, operation):
    with pytest.raises(APIError) as caught:
        operation()
    assert caught.value.code == code


async def test_friend_requests_cross_race_and_completed_retry_does_not_recreate_friend(chat_app):
    app, (one, two, _), _ = chat_app
    runtime = app.runtime
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(lambda args: runtime.contacts.request(args[0], FriendRequestInput(targetUserId=args[1].id)), [(one, two), (two, one)]))
    assert {item["status"] for item in outcomes} == {"pending", "accepted"}
    with runtime.db.read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM friendships").fetchone()[0] == 1
        request = conn.execute("SELECT * FROM friend_requests").fetchone()
        assert conn.execute("SELECT COUNT(*) FROM friend_requests").fetchone()[0] == 1
    recipient = one if request["target_id"] == one.id else two
    runtime.contacts.remove(one, two.id)
    assert runtime.contacts.decide(recipient, request["id"], "accept")["status"] == "accepted"
    assert runtime.contacts.list(one)["items"] == []
    with runtime.db.read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM friend_preferences").fetchone()[0] == 0


async def test_request_search_cancel_reject_block_and_boundaries(chat_app):
    app, (one, two, third), _ = chat_app
    runtime = app.runtime
    page = runtime.contacts.search(one, "actor_", limit=2)
    assert len(page["items"]) == 2 and page["nextCursor"]
    assert all(not item["online"] for item in page["items"])
    assert len(runtime.contacts.search(one, "actor_", page["nextCursor"], 2)["items"]) == 1
    pending = runtime.contacts.request(one, FriendRequestInput(targetUserId=two.id, note="你好"))["request"]
    expect_error("FORBIDDEN", lambda: runtime.contacts.decide(one, pending["id"], "accept"))
    expect_error("RESOURCE_UNAVAILABLE", lambda: runtime.contacts.decide(third, pending["id"], "accept"))
    assert runtime.contacts.decide(one, pending["id"], "cancel")["status"] == "cancelled"
    assert runtime.contacts.decide(one, pending["id"], "cancel")["status"] == "cancelled"
    pending = runtime.contacts.request(one, FriendRequestInput(targetUserId=two.id))["request"]
    assert runtime.contacts.decide(two, pending["id"], "reject")["status"] == "rejected"
    runtime.contacts.set_block(two, one.id, True)
    expect_error("CONTACT_UNAVAILABLE", lambda: runtime.contacts.request(one, FriendRequestInput(targetUserId=two.id)))
    assert runtime.contacts.blocks(two)["items"][0]["blocked"] is True


async def test_canonical_dm_and_committed_idempotent_concurrent_messages(chat_app):
    app, (one, two, third), _ = chat_app
    runtime = app.runtime
    befriend(runtime, one, two)
    with ThreadPoolExecutor(max_workers=2) as pool:
        created = list(pool.map(lambda args: runtime.chat.direct(*args), [(one, two.id), (two, one.id)]))
    assert created[0]["id"] == created[1]["id"]
    conversation = created[0]
    data = command(conversation, "<b>纯文本</b> 👨‍👩‍👧‍👦\nnext")
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: runtime.chat.send(one, conversation["id"], data), range(12)))
    assert sum(not item["duplicate"] for item in results) == 1
    assert len({item["message"]["id"] for item in results}) == 1
    with runtime.db.read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 1
        assert conn.execute("SELECT text FROM messages").fetchone()[0] == data.text
        assert conn.execute("SELECT COUNT(*) FROM user_events WHERE kind='message.created'").fetchone()[0] == 2
    expect_error("IDEMPOTENCY_CONFLICT", lambda: runtime.chat.send(one, conversation["id"], data.model_copy(update={"text": "changed"})))
    expect_error("RESOURCE_UNAVAILABLE", lambda: runtime.chat.history(third, conversation["id"]))
    expect_error("RESOURCE_UNAVAILABLE", lambda: runtime.chat.send(third, conversation["id"], data))
    expect_error("AUTH_REQUIRED", lambda: runtime.chat.send(two, conversation["id"], data.model_copy(update={"actorContext": one.id})))


async def test_transaction_rolls_back_message_sequence_and_event_when_job_enqueue_fails(chat_app, monkeypatch):
    app, (one, two, _), _ = chat_app
    runtime = app.runtime
    conversation = direct(runtime, one, two)
    def fail(*args, **kwargs):
        raise OSError("isolated simulated durable queue failure")
    monkeypatch.setattr(runtime.jobs, "enqueue_in_transaction", fail)
    with pytest.raises(OSError):
        runtime.chat.send(one, conversation["id"], command(conversation))
    with runtime.db.read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 0
        assert conn.execute("SELECT last_seq FROM conversations").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM user_events WHERE kind='message.created'").fetchone()[0] == 0


async def test_friend_removal_block_epoch_and_current_session_checked_before_retry(chat_app):
    app, (one, two, _), _ = chat_app
    runtime = app.runtime
    conversation = direct(runtime, one, two)
    data = command(conversation)
    sent = runtime.chat.send(one, conversation["id"], data)
    runtime.contacts.set_block(two, one.id, True)
    expect_error("CONTACT_UNAVAILABLE", lambda: runtime.chat.send(one, conversation["id"], data))
    assert runtime.chat.history(one, conversation["id"])["items"][0]["id"] == sent["message"]["id"]
    runtime.contacts.set_block(two, one.id, False)
    expect_error("STALE_ACCESS", lambda: runtime.chat.send(one, conversation["id"], data))
    runtime.contacts.remove(one, two.id)
    expect_error("FRIENDSHIP_REQUIRED", lambda: runtime.chat.send(one, conversation["id"], data))
    assert len(runtime.chat.history(two, conversation["id"])["items"]) == 1
    with runtime.db.write() as conn:
        conn.execute("UPDATE sessions SET revoked_at=? WHERE id=?", (now_ms(), one.session["id"]))
    expect_error("AUTH_REQUIRED", lambda: runtime.chat.history(one, conversation["id"]))


async def test_snapshot_window_event_pagination_and_expired_or_forged_cursor(chat_app):
    app, (one, two, third), _ = chat_app
    runtime = app.runtime
    conversation = direct(runtime, one, two)
    snapshot = runtime.events.snapshot(two)
    for number in range(5):
        runtime.chat.send(one, conversation["id"], command(conversation, f"persistent {number}"))
    cursor, ids = snapshot["cursor"], []
    while True:
        batch = runtime.events.sync(two, cursor, 2)
        for event in batch["items"]:
            if event["type"] == "message.created":
                ids.append(event["message"]["id"])
        cursor = batch["cursor"]
        if not batch["hasMore"]:
            break
    assert len(ids) == len(set(ids)) == 5
    assert runtime.events.sync(third, "0")["items"] == []
    with runtime.db.write() as conn:
        conn.execute("UPDATE instance_metadata SET value='1' WHERE key='event_floor'")
    expect_error("RESYNC_REQUIRED", lambda: runtime.events.sync(two, "0"))
    expect_error("RESYNC_REQUIRED", lambda: runtime.events.sync(two, "9223372036854775807"))
    with runtime.db.read() as conn:
        assert "text" not in {row[1] for row in conn.execute("PRAGMA table_info(user_events)")}


async def test_sequences_history_read_monotonic_and_privacy_suppresses_peer_events(chat_app):
    app, (one, two, _), _ = chat_app
    runtime = app.runtime
    conversation = direct(runtime, one, two)
    for number in range(5):
        runtime.chat.send(one, conversation["id"], command(conversation, str(number)))
    latest = runtime.chat.history(two, conversation["id"], limit=2)
    assert [m["seq"] for m in latest["items"]] == ["4", "5"]
    older = runtime.chat.history(two, conversation["id"], before=latest["nextCursor"], limit=2)
    assert [m["seq"] for m in older["items"]] == ["2", "3"]
    runtime.chat.read(two, conversation["id"], "4")
    assert runtime.chat.read(two, conversation["id"], "2")["readSeq"] == "4"
    assert runtime.chat.get(one, conversation["id"])["peerReadSeq"] == "4"
    assert runtime.chat.get(two, conversation["id"])["unreadCount"] == 1
    expect_error("VALIDATION_ERROR", lambda: runtime.chat.read(two, conversation["id"], "6"))
    runtime.auth.preferences(two, PreferencesInput(readReceipts=False))
    cursor = runtime.events.snapshot(one)["cursor"]
    runtime.chat.read(two, conversation["id"], "5")
    assert runtime.chat.get(one, conversation["id"])["peerReadSeq"] is None
    assert not any(row["type"] == "read.updated" for row in runtime.events.sync(one, cursor)["items"])
    with runtime.db.write() as conn:
        conn.execute("UPDATE conversations SET last_seq=? WHERE id=?", (9007199254740992, conversation["id"]))
    result = runtime.chat.send(one, conversation["id"], command(conversation))
    assert result["message"]["seq"] == "9007199254740993"


async def test_presence_aggregates_tabs_and_hides_private_nonfriend_and_blocked_state(chat_app):
    app, (one, two, third), _ = chat_app
    runtime = app.runtime
    befriend(runtime, one, two)
    await runtime.connected("one-tab-1", one)
    await runtime.connected("one-tab-2", one)
    assert runtime.contacts.list(two)["items"][0]["online"] is True
    with runtime.db.read() as conn:
        assert runtime.access.presence(conn, third.id, one.id) is False
    await runtime.disconnected("one-tab-1")
    assert runtime.is_connected(one.id) is True
    runtime.contacts.preferences(two, one.id, FriendPreferencesInput(notifyOnline=True))
    assert runtime._presence_audience(one.id)[0][1]["notify"] is True
    assert runtime._presence_audience(one.id)[0][1]["notify"] is False
    runtime.auth.preferences(one, PreferencesInput(invisible=True))
    assert runtime.contacts.list(two)["items"][0]["online"] is False
    runtime.contacts.set_block(two, one.id, True)
    assert runtime._presence_audience(one.id) == []
    await runtime.disconnected("one-tab-2")
    assert runtime.is_connected(one.id) is False


async def test_http_contract_authoritative_fields_utf8_limits_and_shared_socket_handler(chat_app):
    app, (one, two, third), tokens = chat_app
    runtime = app.runtime
    conversation = direct(runtime, one, two)
    cookie = f"{runtime.auth.cookie_name}={tokens[0]}"
    headers = {"Origin": ORIGIN, "Cookie": cookie, "X-CSRF-Token": runtime.auth.security.csrf(tokens[0])}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=ORIGIN, headers=headers) as client:
        payload = command(conversation, "from HTTP").model_dump()
        response = await client.post(f'/api/v1/conversations/{conversation["id"]}/messages', json=payload | {"senderId": third.id})
        assert response.status_code == 422
        response = await client.post(f'/api/v1/conversations/{conversation["id"]}/messages', json=payload)
        assert response.status_code == 201
        http_message = response.json()["data"]["message"]
        await runtime.connected("isolated-socket", one)
        ack = await app.sio.handlers["/"]["message.send"]("isolated-socket", payload | {"v": 1, "conversationId": conversation["id"], "requestId": "same-core"})
        assert ack["ok"] and ack["data"]["duplicate"]
        assert ack["data"]["message"]["id"] == http_message["id"]
        forged = await app.sio.handlers["/"]["message.send"]("isolated-socket", payload | {"conversationId": conversation["id"], "requestId": "forged", "role": "owner"})
        assert not forged["ok"] and forged["status"] == 422
        too_long = payload | {"clientMessageId": str(uuid.uuid4()), "text": "a" * 4001}
        assert (await client.post(f'/api/v1/conversations/{conversation["id"]}/messages', json=too_long)).status_code == 422
        assert (await client.get('/api/v1/conversations?limit=101')).status_code == 422
        assert (await client.get('/api/v1/sync?after=-1')).status_code == 422
        assert (await client.get('/api/v1/friends')).status_code == 200
        assert (await client.get('/api/v1/notifications')).json()["data"]["items"]
    with pytest.raises(ValidationError):
        MessageInput(clientMessageId="not-uuid", text="bad", accessKey="invalid")
    expect_error("VALIDATION_ERROR", lambda: runtime.chat.send(one, conversation["id"], command(conversation, "\u0000")))
    expect_error("VALIDATION_ERROR", lambda: runtime.chat.send(one, conversation["id"], command(conversation, " \n\t ")))


async def test_reply_authorization_and_unavailable_quote_after_removal(chat_app):
    app, (one, two, third), _ = chat_app
    runtime = app.runtime
    conversation = direct(runtime, one, two)
    first = runtime.chat.send(one, conversation["id"], command(conversation))["message"]
    second = runtime.chat.send(two, conversation["id"], command(conversation, "reply", replyToMessageId=first["id"]))["message"]
    assert second["reply"]["text"] == "hello"
    with runtime.db.write() as conn:
        conn.execute("UPDATE messages SET status='recalled',removed_at=? WHERE id=?", (now_ms(), first["id"]))
    assert runtime.chat.history(two, conversation["id"])["items"][1]["reply"]["status"] == "unavailable"
    assert runtime.chat.history(two, conversation["id"])["items"][0]["text"] == ""
    expect_error("VALIDATION_ERROR", lambda: runtime.chat.send(one, conversation["id"], command(conversation, mentionedUserIds=[third.id])))


async def test_recent_request_and_conversation_pagination_remains_bounded(chat_app):
    app, (one, two, third), _ = chat_app
    runtime = app.runtime
    conversation = direct(runtime, one, two)
    other = direct(runtime, one, third)
    runtime.chat.send(one, conversation["id"], command(conversation, "recent"))
    first = runtime.chat.list(one, limit=1)
    assert first["items"][0]["id"] == conversation["id"] and first["nextCursor"]
    assert runtime.chat.list(one, first["nextCursor"], 1)["items"][0]["id"] == other["id"]
    requests = runtime.contacts.requests(one, limit=1)
    assert len(requests["items"]) == 1 and requests["nextCursor"]
    assert len(runtime.contacts.requests(one, requests["nextCursor"], 1)["items"]) == 1
    await asyncio.sleep(0)
    with runtime.db.read() as conn:
        assert not conn.execute("PRAGMA foreign_key_check").fetchall()
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert not any('"text"' in row[0] for row in conn.execute("SELECT payload_json FROM jobs"))
