from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

import httpx
import pytest
import pytest_asyncio
from PIL import Image

from tongpin.asgi import create_application
from tongpin.contracts.base import APIError
from tongpin.contracts.chat import FriendRequestInput, MessageInput
from tongpin.contracts.files import UploadInput
from tongpin.contracts.groups import GroupCommand, GroupCreate, GroupInviteInput
from tongpin.infra.db import now_ms
from tongpin.infra.scanner import ScanResult

pytestmark = pytest.mark.asyncio
ORIGIN = "http://127.0.0.1:8765"


@pytest_asyncio.fixture
async def files_app(settings):
    app = create_application(settings)
    await app.runtime.start()
    # Deterministic domain checks explicitly invoke processing and cleanup.
    # Separate live-server tests prove the actual durable worker path.
    await app.runtime.runner.stop()
    await app.runtime.file_runner.stop()
    tokens = []
    with app.runtime.db.write() as conn:
        for index in range(3):
            user = app.runtime.auth.create_user(conn, f"file_actor_{index}", f"附件账号{index}", "isolated-unused-hash")
            token, _ = app.runtime.auth.issue_session(conn, user, False, "isolated file test")
            tokens.append(token)
    try:
        yield app, [app.runtime.auth.load(token) for token in tokens], tokens
    finally:
        await app.runtime.stop()


def error(code, operation):
    with pytest.raises(APIError) as caught:
        operation()
    assert caught.value.code == code


def direct(rt, one, two):
    pending = rt.contacts.request(one, FriendRequestInput(targetUserId=two.id))
    rt.contacts.decide(two, pending["request"]["id"], "accept")
    return rt.chat.direct(one, two.id)


def image_bytes(size=(80, 40), image_format="PNG"):
    output = io.BytesIO()
    Image.new("RGB", size, (54, 110, 160)).save(output, image_format)
    return output.getvalue()


def upload_command(actor, conversation, data, name="真实文件.txt", **changes):
    values = {"clientUploadId": str(uuid.uuid4()), "actorContext": actor.id, "name": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest(), "mime": "", "purpose": "message", "conversationId": conversation["id"] if conversation else None, "accessKey": conversation["accessKey"] if conversation else None}
    values.update(changes)
    return UploadInput(**values)


def upload(rt, actor, conversation, data, name="真实文件.txt", **changes):
    record = rt.files.reserve(actor, upload_command(actor, conversation, data, name, **changes))
    assert rt.files.receive(actor, record["id"], io.BytesIO(data))["state"] == "processing"
    rt.files.process({"payload": {"attachmentId": record["id"]}})
    return rt.files.get(actor, record["id"])


def send(rt, actor, conversation, ids):
    command = MessageInput(clientMessageId=str(uuid.uuid4()), actorContext=actor.id, accessKey=conversation["accessKey"], text="", attachmentIds=ids)
    return rt.chat.send(actor, conversation["id"], command), command


def policy(rt, **changes):
    with rt.db.write() as conn:
        values = rt.policy.get(conn) | changes
        conn.execute("INSERT INTO policy_versions VALUES(?,?,?,?,?)", (values.pop("version") + 1, json.dumps(values), None, "isolated test policy", now_ms()))


def join(rt, owner, participant, cid):
    invitation = rt.groups.invites.create(owner, cid, GroupInviteInput(clientRequestId=str(uuid.uuid4())))
    pending = rt.groups.invites.apply(participant, invitation["invite"]["id"], GroupCommand(clientRequestId=str(uuid.uuid4())), invitation["token"])
    rt.groups.invites.decide(owner, pending["id"], "approve")
    return rt.chat.get(participant, cid)


async def test_reserve_idempotence_quota_race_actor_and_prebody_permission(files_app, monkeypatch):
    app, (one, two, third), _ = files_app
    rt = app.runtime
    conversation = direct(rt, one, two)
    data = b"quota and replay"
    command = upload_command(one, conversation, data)
    policy(rt, user_quota_bytes=len(data))
    first = rt.files.reserve(one, command)
    assert rt.files.reserve(one, command)["id"] == first["id"]
    assert rt.files.policy(one)["reservedBytes"] == len(data)
    error("IDEMPOTENCY_CONFLICT", lambda: rt.files.reserve(one, command.model_copy(update={"name": "changed.txt"})))
    error("USER_QUOTA_EXCEEDED", lambda: rt.files.reserve(one, upload_command(one, conversation, data)))
    error("AUTH_REQUIRED", lambda: rt.files.reserve(one, command.model_copy(update={"actorContext": two.id})))
    error("RESOURCE_UNAVAILABLE", lambda: rt.files.guard_upload(third, first["id"]))
    rt.contacts.set_block(two, one.id, True)
    error("CONTACT_UNAVAILABLE", lambda: rt.files.guard_upload(one, first["id"]))
    rt.contacts.set_block(two, one.id, False)
    error("STALE_ACCESS", lambda: rt.files.guard_upload(one, first["id"]))
    rt.files.cancel(one, first["id"])
    assert rt.files.cleanup()["removed"] == 1
    conversation = rt.chat.get(one, conversation["id"])
    with ThreadPoolExecutor(max_workers=2) as pool:
        attempts = [pool.submit(rt.files.reserve, one, upload_command(one, conversation, data)) for _ in range(2)]
        values = []
        for attempt in attempts:
            try:
                values.append(attempt.result()["state"])
            except APIError as caught:
                values.append(caught.code)
    assert sorted(values) == ["USER_QUOTA_EXCEEDED", "reserved"]
    policy(rt, user_quota_bytes=1024)
    monkeypatch.setattr(rt.paths, "disk_state", lambda: {"totalBytes": 10**9, "freeBytes": 5 * 10**7})
    error("DISK_HIGH_WATERMARK", lambda: rt.files.reserve(one, upload_command(one, conversation, data)))


async def test_actual_bytes_digest_and_decoder_failures_are_not_ready(files_app):
    app, (one, two, _), _ = files_app
    rt = app.runtime
    conversation = direct(rt, one, two)
    for received, expected_code in [(b"short", "FILE_SIZE_MISMATCH"), (b"longer bytes!!", "FILE_SIZE_MISMATCH"), (b"wrong bytes", "FILE_HASH_MISMATCH")]:
        command = upload_command(one, conversation, b"right bytes")
        record = rt.files.reserve(one, command)
        error(expected_code, lambda record=record, received=received: rt.files.receive(one, record["id"], io.BytesIO(received)))
        assert rt.files.get(one, record["id"])["state"] == "rejected"
        rt.files.cleanup()
    corrupt = upload(rt, one, conversation, b"not a png", "fake.png")
    assert corrupt["state"] == "rejected" and corrupt["errorCode"] == "IMAGE_INVALID"
    assert not list(rt.paths.temporary.glob("upload-*.part"))
    record = rt.files.reserve(one, upload_command(one, conversation, b"correct stored bytes"))
    rt.files.receive(one, record["id"], io.BytesIO(b"correct stored bytes"))
    with rt.db.read() as conn:
        row = rt.files.row(conn, record["id"])
    rt.files.path(row["storage_key"]).write_bytes(b"altered stored bytes")
    assert rt.files.process({"payload": {"attachmentId": record["id"]}})["code"] == "FILE_HASH_MISMATCH"


async def test_quarantine_explicit_retry_infected_and_closed_test_policy(files_app, monkeypatch):
    app, (one, two, _), _ = files_app
    rt = app.runtime
    conversation = direct(rt, one, two)
    record = upload(rt, one, conversation, "真实UTF8文件\n".encode())
    assert (record["state"], record["scanStatus"], record["errorCode"]) == ("quarantined", "unknown", "SCANNER_DISABLED")
    error("FILE_NOT_READY", lambda: send(rt, one, conversation, [record["id"]]))
    error("RESOURCE_UNAVAILABLE", lambda: rt.files.content(one, record["id"], "content"))
    monkeypatch.setattr(rt.files.scanner, "scan", lambda *_: ScanResult("clean"))
    assert rt.files.retry(one, record["id"])["state"] == "processing"
    rt.files.process({"payload": {"attachmentId": record["id"]}})
    assert rt.files.get(one, record["id"])["scanStatus"] == "clean"
    monkeypatch.setattr(rt.files.scanner, "scan", lambda *_: ScanResult("infected", "FILE_INFECTED"))
    infected = upload(rt, one, conversation, b"controlled infection verdict")
    assert (infected["state"], infected["scanStatus"]) == ("rejected", "infected")
    monkeypatch.setattr(rt.files.scanner, "scan", lambda *_: ScanResult("unknown", "SCANNER_DISABLED"))
    rt.settings = replace(rt.settings, allow_unscanned_files=True)
    local = upload(rt, one, conversation, b"explicit closed local test")
    assert (local["state"], local["scanStatus"]) == ("ready", "not_scanned")
    assert rt.files.policy(one)["scanPolicy"] == "closed-test-unscanned"
    with pytest.raises(ValueError):
        replace(rt.settings, environment="production").validate()


async def test_message_binding_download_acl_tombstone_and_rollback(files_app, monkeypatch):
    app, (one, two, third), _ = files_app
    rt = app.runtime
    conversation = direct(rt, one, two)
    data = image_bytes()
    record = upload(rt, one, conversation, data, "真实图片.png")
    assert record["state"] == "ready" and record["scanStatus"] == "not_scanned"
    error("RESOURCE_UNAVAILABLE", lambda: rt.files.get(two, record["id"]))
    original_enqueue = rt.jobs.enqueue_in_transaction
    monkeypatch.setattr(rt.jobs, "enqueue_in_transaction", lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("isolated commit failure")))
    with pytest.raises(OSError):
        send(rt, one, conversation, [record["id"]])
    assert not rt.files.get(one, record["id"])["bound"]
    with rt.db.read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 0
    monkeypatch.setattr(rt.jobs, "enqueue_in_transaction", original_enqueue)
    accepted, command = send(rt, one, conversation, [record["id"]])
    assert accepted["message"]["attachments"][0]["id"] == record["id"]
    assert rt.chat.send(one, conversation["id"], command)["duplicate"]
    assert rt.files.content(two, record["id"], "content")[0].read_bytes() == data
    error("RESOURCE_UNAVAILABLE", lambda: rt.files.get(third, record["id"]))
    error("FILE_IN_USE", lambda: rt.files.cancel(one, record["id"]))
    assert len(rt.files.list(two)["items"]) == 1
    with rt.db.write() as conn:
        conn.execute("UPDATE messages SET status='recalled' WHERE id=?", (accepted["message"]["id"],))
    error("RESOURCE_UNAVAILABLE", lambda: rt.files.content(two, record["id"], "content"))
    error("RESOURCE_UNAVAILABLE", lambda: rt.files.content(one, record["id"], "preview"))
    assert rt.files.list(two)["items"] == []


async def test_attachment_wrong_conversation_owner_total_and_not_ready_are_atomic(files_app):
    app, (one, two, third), _ = files_app
    rt = app.runtime
    conversation = direct(rt, one, two)
    other = direct(rt, one, third)
    record = upload(rt, one, conversation, image_bytes(), "one.png")
    error("RESOURCE_UNAVAILABLE", lambda: send(rt, one, other, [record["id"]]))
    error("RESOURCE_UNAVAILABLE", lambda: send(rt, two, rt.chat.get(two, conversation["id"]), [record["id"]]))
    waiting = rt.files.reserve(one, upload_command(one, conversation, image_bytes(), "waiting.png"))
    error("FILE_NOT_READY", lambda: send(rt, one, conversation, [record["id"], waiting["id"]]))
    policy(rt, message_attachment_bytes=1)
    error("PAYLOAD_TOO_LARGE", lambda: send(rt, one, conversation, [record["id"]]))
    assert not rt.files.get(one, record["id"])["bound"]
    with rt.db.read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 0


async def test_attachment_order_is_preserved_and_is_part_of_idempotent_payload(files_app):
    app, (one, two, _), _ = files_app
    rt = app.runtime
    conversation = direct(rt, one, two)
    files = [upload(rt, one, conversation, image_bytes(), name) for name in ("one.png", "two.png")]
    ids = sorted((row["id"] for row in files), reverse=True)
    accepted, command = send(rt, one, conversation, ids)
    assert [row["id"] for row in accepted["message"]["attachments"]] == ids
    assert rt.chat.send(one, conversation["id"], command)["duplicate"]
    error("IDEMPOTENCY_CONFLICT", lambda: rt.chat.send(one, conversation["id"], command.model_copy(update={"attachmentIds": ids[::-1]})))
    assert [row["id"] for row in rt.chat.history(two, conversation["id"])["items"][0]["attachments"]] == ids


async def test_raw_replace_followed_by_failed_job_commit_can_retry_same_record(files_app, monkeypatch):
    app, (one, two, _), _ = files_app
    rt = app.runtime
    conversation = direct(rt, one, two)
    data = image_bytes()
    record = rt.files.reserve(one, upload_command(one, conversation, data, "retry.png"))
    original = rt.jobs.enqueue_in_transaction
    monkeypatch.setattr(rt.jobs, "enqueue_in_transaction", lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("controlled job commit failure")))
    error("STORAGE_UNAVAILABLE", lambda: rt.files.receive(one, record["id"], io.BytesIO(data)))
    assert rt.files.get(one, record["id"])["state"] == "reserved"
    monkeypatch.setattr(rt.jobs, "enqueue_in_transaction", original)
    assert rt.files.receive(one, record["id"], io.BytesIO(data))["state"] == "processing"
    rt.files.process({"payload": {"attachmentId": record["id"]}})
    assert rt.files.get(one, record["id"])["state"] == "ready"
    assert rt.files.policy(one)["usedBytes"] == len(data)
    with rt.db.read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM jobs WHERE kind='files.process'").fetchone()[0] == 1


async def test_interrupted_upload_and_derived_write_cleanup_after_reinitialization(files_app, monkeypatch):
    app, (one, two, _), _ = files_app
    rt = app.runtime
    conversation = direct(rt, one, two)
    data = image_bytes()
    record = rt.files.reserve(one, upload_command(one, conversation, data, "interrupted.png"))
    with rt.db.write() as conn:
        conn.execute("UPDATE attachments SET state='uploading',lease_token='interrupted',lease_until=? WHERE id=?", (now_ms() + 150000, record["id"]))
    rt.files.initialize()  # Explicit crash-state fixture; actual process restart is a separate live test.
    assert rt.files.get(one, record["id"])["state"] == "reserved"
    rt.files.receive(one, record["id"], io.BytesIO(data))
    original = rt.files._write_derived
    writes = 0

    def interrupted(data, key):
        nonlocal writes
        writes += 1
        if writes == 2:
            raise OSError("controlled partial derived-file failure")
        return original(data, key)

    monkeypatch.setattr(rt.files, "_write_derived", interrupted)
    assert rt.files.process({"payload": {"attachmentId": record["id"]}})["state"] == "rejected"
    rt.files.cleanup()
    assert not list(rt.paths.uploads.iterdir())
    assert rt.files.policy(one)["usedBytes"] == 0


async def test_group_since_join_file_list_and_stale_upload_after_rejoin(files_app):
    app, (owner, two, third), _ = files_app
    rt = app.runtime
    created = rt.groups.create(owner, GroupCreate(clientRequestId=str(uuid.uuid4()), name="附件成员期"))
    cid = created["conversation"]["id"]
    join(rt, owner, two, cid)
    conversation = rt.chat.get(owner, cid)
    old = upload(rt, owner, conversation, image_bytes(), "before.png")
    send(rt, owner, conversation, [old["id"]])
    assert len(rt.files.list(two)["items"]) == 1
    pending = rt.files.reserve(two, upload_command(two, rt.chat.get(two, cid), image_bytes(), "pending.png"))
    rt.groups.leave(two, cid)
    error("RESOURCE_UNAVAILABLE", lambda: rt.files.content(two, old["id"], "content"))
    join(rt, owner, two, cid)
    assert rt.files.list(two)["items"] == []
    error("RESOURCE_UNAVAILABLE", lambda: rt.files.get(two, old["id"]))
    error("STALE_ACCESS", lambda: rt.files.guard_upload(two, pending["id"]))
    join(rt, owner, third, cid)
    assert rt.files.list(third)["items"] == []
    fresh = upload(rt, owner, rt.chat.get(owner, cid), image_bytes(), "after.png")
    send(rt, owner, rt.chat.get(owner, cid), [fresh["id"]])
    assert [row["id"] for row in rt.files.list(third)["items"]] == [fresh["id"]]


async def test_avatar_normalization_replace_privacy_and_group_management(files_app):
    app, (one, two, third), _ = files_app
    rt = app.runtime
    original = image_bytes((200, 100), "JPEG")
    record = upload(rt, one, None, original, "头像.jpg", purpose="user_avatar")
    with rt.db.read() as conn:
        raw = rt.files.path(rt.files.row(conn, record["id"])["storage_key"])
    assert not raw.exists()
    error("RESOURCE_UNAVAILABLE", lambda: rt.files.content(one, record["id"], "content"))
    changed = rt.files.set_avatar(one, record["id"])
    assert changed["user"]["avatarUrl"].startswith("/api/v1/users/")
    preview, mime, _ = rt.files.avatar(two, uid=one.id)
    with Image.open(preview) as decoded:
        assert decoded.size == (512, 512) and decoded.format == "WEBP"
        assert not decoded.getexif()
    assert mime == "image/webp"
    error("FILE_IN_USE", lambda: rt.files.cancel(one, record["id"]))
    rt.files.set_avatar(one, None)
    error("RESOURCE_UNAVAILABLE", lambda: rt.files.content(two, record["id"], "preview"))
    rt.files.cleanup()
    assert not preview.exists()
    created = rt.groups.create(one, GroupCreate(clientRequestId=str(uuid.uuid4()), name="群头像"))
    cid = created["conversation"]["id"]
    join(rt, one, two, cid)
    group_record = upload(rt, one, rt.chat.get(one, cid), original, "群头像.jpg", purpose="group_avatar")
    version = rt.groups.get(one, cid)["version"]
    error("FORBIDDEN", lambda: rt.files.set_avatar(two, group_record["id"], cid, version))
    rt.files.set_avatar(one, group_record["id"], cid, version)
    assert rt.files.avatar(two, cid=cid)[0].exists()
    error("RESOURCE_UNAVAILABLE", lambda: rt.files.avatar(third, cid=cid))
    rt.groups.leave(two, cid)
    error("RESOURCE_UNAVAILABLE", lambda: rt.files.avatar(two, cid=cid))


async def test_receive_cancellation_processing_cancellation_and_quota_gc(files_app, monkeypatch):
    app, (one, two, _), _ = files_app
    rt = app.runtime
    conversation = direct(rt, one, two)
    body = image_bytes()
    record = rt.files.reserve(one, upload_command(one, conversation, body, "cancel.png"))

    class CancellingStream(io.BytesIO):
        def read(self, size=-1):
            chunk = super().read(size)
            if chunk:
                rt.files.cancel(one, record["id"])
            return chunk

    error("FILE_CANCELLED", lambda: rt.files.receive(one, record["id"], CancellingStream(body)))
    assert rt.files.get(one, record["id"])["state"] == "cancelled"
    assert rt.files.cleanup()["removed"] == 1
    processing = rt.files.reserve(one, upload_command(one, conversation, body, "processing.png"))
    rt.files.receive(one, processing["id"], io.BytesIO(body))

    def cancel_during_scan(*_):
        rt.files.cancel(one, processing["id"])
        rt.files.cleanup()
        return ScanResult("clean")

    monkeypatch.setattr(rt.files.scanner, "scan", cancel_during_scan)
    assert rt.files.process({"payload": {"attachmentId": processing["id"]}})["state"] == "cancelled"
    assert rt.files.policy(one)["usedBytes"] == 0
    assert not list(rt.paths.uploads.iterdir())
    assert not list(rt.paths.temporary.glob("upload-*.part"))


async def test_cleanup_holds_backup_retries_disk_failure_and_leaves_bound_file(files_app, monkeypatch):
    app, (one, two, _), _ = files_app
    rt = app.runtime
    conversation = direct(rt, one, two)
    body = image_bytes()
    bound = upload(rt, one, conversation, body, "bound.png")
    send(rt, one, conversation, [bound["id"]])
    orphan = upload(rt, one, conversation, body, "orphan.png")
    rt.files.cancel(one, orphan["id"])
    with rt.db.write() as conn:
        conn.execute("INSERT INTO instance_metadata(key,value) VALUES('backup_active','1')")
        orphan_row = rt.files.row(conn, orphan["id"])
    assert rt.files.cleanup()["heldByBackup"]
    with rt.db.write() as conn:
        conn.execute("UPDATE instance_metadata SET value='0' WHERE key='backup_active'")
    original_unlink = type(rt.paths.uploads).unlink
    blocked_path = rt.files.path(orphan_row["storage_key"])

    def locked(path, *args, **kwargs):
        if path == blocked_path:
            raise PermissionError("isolated held file")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(type(blocked_path), "unlink", locked)
    assert rt.files.cleanup()["removed"] == 0
    assert rt.files.policy(one)["usedBytes"] == len(body) * 2
    monkeypatch.setattr(type(blocked_path), "unlink", original_unlink)
    assert rt.files.cleanup()["removed"] == 1
    assert rt.files.policy(one)["usedBytes"] == len(body)
    assert rt.files.content(two, bound["id"], "content")[0].read_bytes() == body
    temporary = rt.files.path("upload-expired.part", temporary=True)
    temporary.write_bytes(b"abandoned")
    os.utime(temporary, (0, 0))
    rt.files.cleanup()
    assert not temporary.exists()
    with rt.db.read() as conn:
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert not conn.execute("PRAGMA foreign_key_check").fetchall()


async def test_http_raw_chunked_download_and_guard_before_read(files_app):
    app, (one, two, _), tokens = files_app
    rt = app.runtime
    conversation = direct(rt, one, two)
    body = image_bytes()
    auth_headers = {"Origin": ORIGIN, "X-CSRF-Token": rt.auth.security.csrf(tokens[0])}
    cookies = {rt.auth.cookie_name: tokens[0]}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=ORIGIN, cookies=cookies, headers=auth_headers) as client:
        reserved = await client.post("/api/v1/attachment-uploads", json=upload_command(one, conversation, body, "真实下载.png").model_dump())
        assert reserved.status_code == 201
        fid = reserved.json()["data"]["id"]

        async def oversized_chunks():
            yield body
            yield b"over the reserved limit"

        oversized = await client.post("/api/v1/attachments", content=oversized_chunks(), headers={"Content-Type": "application/octet-stream", "X-Upload-Id": fid})
        assert oversized.status_code == 413
        assert rt.files.get(one, fid)["state"] == "reserved"

        async def chunks():
            yield body[:13]
            yield body[13:]

        received = await client.post("/api/v1/attachments", content=chunks(), headers={"Content-Type": "application/octet-stream", "X-Upload-Id": fid})
        assert received.status_code == 202 and received.json()["data"]["state"] == "processing"
        rt.files.process({"payload": {"attachmentId": fid}})
        send(rt, one, conversation, [fid])
        client.cookies.set(rt.auth.cookie_name, tokens[1])
        downloaded = await client.get(f"/api/v1/attachments/{fid}/content")
        assert downloaded.status_code == 200 and downloaded.content == body
        assert downloaded.headers["Content-Disposition"].startswith("attachment;")
        assert "no-store" in downloaded.headers["Cache-Control"] and downloaded.headers["X-Content-Type-Options"] == "nosniff"
        client.cookies.set(rt.auth.cookie_name, tokens[2])
        assert (await client.get(f"/api/v1/attachments/{fid}/preview")).status_code == 404
        client.cookies.clear()
        assert (await client.get(f"/api/v1/attachments/{fid}/content")).status_code == 401

    reads = 0

    async def untouched_receive():
        nonlocal reads
        reads += 1
        raise AssertionError("Unauthorized or declared-oversized upload read its body")

    async def invoke(extra, token):
        outputs = []
        headers = [(b"cookie", f"{rt.auth.cookie_name}={token}".encode()), (b"origin", ORIGIN.encode()), (b"x-csrf-token", rt.auth.security.csrf(token).encode()), (b"content-type", b"application/octet-stream"), (b"x-upload-id", fid.encode()), *extra]
        scope = {"type": "http", "http_version": "1.1", "method": "POST", "path": "/api/v1/attachments", "root_path": "", "scheme": "http", "headers": headers, "server": ("127.0.0.1", 8765), "client": ("127.0.0.1", 1234), "query_string": b""}

        async def emit(value):
            outputs.append(value)

        await app(scope, untouched_receive, emit)
        return outputs[0]["status"]

    assert await invoke([], tokens[2]) == 404
    assert await invoke([(b"content-length", str(len(body) + 1).encode())], tokens[0]) == 413
    assert reads == 0


async def test_slow_file_job_does_not_block_general_job_lane(files_app):
    app, _, _ = files_app
    rt = app.runtime
    from tongpin.jobs.runner import JobRunner

    entered, release, dispatched = threading.Event(), threading.Event(), threading.Event()
    file_runner = JobRunner(rt.jobs, rt.executor, kinds=("files.process",))
    general_runner = JobRunner(rt.jobs, rt.executor, excluded_kinds=("files.process",))

    def slow(_):
        entered.set()
        assert release.wait(4)
        return {"controlled": True}

    file_runner.handlers["files.process"] = slow
    general_runner.handlers["isolated.dispatch"] = lambda _: dispatched.set()
    rt.jobs.enqueue("files.process", {})
    rt.jobs.enqueue("isolated.dispatch", {})
    file_runner.start()
    general_runner.start()
    try:
        for _ in range(100):
            if entered.is_set() and dispatched.is_set():
                break
            await asyncio.sleep(0.01)
        assert entered.is_set() and dispatched.is_set() and not release.is_set()
    finally:
        release.set()
        await file_runner.stop()
        await general_runner.stop()
