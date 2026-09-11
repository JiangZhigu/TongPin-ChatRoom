from __future__ import annotations

import io
import json
import sqlite3
import zipfile
from contextlib import closing

import pytest
from test_admin import admin_app as admin_app  # noqa: PLC0414
from test_admin import execute
from test_admin_operations import artifact_path, run_operation
from test_admin_operations import ops_app as ops_app  # noqa: PLC0414
from test_admin_s2 import message
from test_files import direct, image_bytes, upload_command
from test_groups import create

from tongpin.infra.db import now_ms

pytestmark = pytest.mark.asyncio


@pytest.mark.parametrize("purpose", ["user_avatar", "group_avatar"])
async def test_backup_retains_processing_avatar_original_until_snapshot_finishes(ops_app, monkeypatch, purpose):
    rt, owner = ops_app[0].runtime, ops_app[1][2]
    conversation = create(rt, owner)["conversation"] if purpose == "group_avatar" else None
    payload = image_bytes()
    record = rt.files.reserve(owner, upload_command(owner, conversation, payload, "原件保护.png", purpose=purpose))
    assert rt.files.receive(owner, record["id"], io.BytesIO(payload))["state"] == "processing"
    with rt.db.read() as conn:
        key = rt.files.row(conn, record["id"])["storage_key"]
    original_backup = rt.db.backup
    observed = {}

    def interleaved_backup(path, **kwargs):
        original_backup(path, **kwargs)
        with closing(sqlite3.connect(path)) as conn:
            observed["snapshot_state"] = conn.execute("SELECT state FROM attachments WHERE id=?", (record["id"],)).fetchone()[0]
        observed["processing_result"] = rt.files.process({"payload": {"attachmentId": record["id"]}})
        observed["original_retained"] = rt.files.path(key).is_file()

    monkeypatch.setattr(rt.db, "backup", interleaved_backup)
    _, command, _ = execute(ops_app, "backup.create", ["instance"])
    result = run_operation(rt)
    assert observed == {"snapshot_state": "processing", "processing_result": {"state": "ready"}, "original_retained": True}
    assert result["status"] == "completed", result
    with zipfile.ZipFile(artifact_path(rt, command.operationId)) as archive:
        assert archive.read("files/" + key) == payload
    rt.files.cleanup()
    assert not rt.files.path(key).exists()
    assert rt.files.get(owner, record["id"])["state"] == "ready"


async def test_old_backup_replays_already_completed_deletions_and_related_erasure(ops_app):
    rt, actors = ops_app[0].runtime, ops_app[1]
    erased, peer = actors[1], actors[2]
    conversation = direct(rt, erased, peer)
    original = message(rt, peer, conversation)
    removed = message(rt, erased, conversation, replyToMessageId=original["id"])
    rt.interactions.bookmark(erased, original["id"], True)
    with rt.db.write() as conn:
        conn.execute("INSERT INTO message_reactions VALUES(?,?,?,?)", (removed["id"], peer.id, "1f44d", now_ms()))
        conn.execute("UPDATE messages SET mentioned_ids=?,mention_all=1 WHERE id=?", (json.dumps([peer.id]), removed["id"]))
        conn.execute("INSERT INTO friend_preferences(user_id,friend_id,remark) VALUES(?,?,?) ON CONFLICT(user_id,friend_id) DO UPDATE SET remark=excluded.remark", (erased.id, peer.id, "应抹除的私人备注"))
        conn.execute("UPDATE friend_requests SET note='应抹除的申请备注' WHERE sender_id=? OR target_id=?", (erased.id, erased.id))
        rt.events.notify(conn, erased.id, "message.mentioned", original["id"], peer.id)
    # A completed governance receipt deliberately retains a session foreign key.
    execute(ops_app, "storage.cleanup", ["instance"], index=1)
    assert run_operation(rt)["status"] == "completed"
    _, backup, _ = execute(ops_app, "backup.create", ["instance"])
    assert run_operation(rt)["status"] == "completed"
    with rt.db.write() as conn:
        conn.execute("UPDATE users SET status='deleting',deletion_at=? WHERE id=?", (now_ms() - 1, erased.id))
        conn.execute("UPDATE messages SET status='moderated',removed_at=? WHERE id=?", (now_ms() - 31 * 86400000, removed["id"]))
    rt.lifecycle.cleanup()
    with rt.db.read() as conn:
        assert conn.execute("SELECT status FROM users WHERE id=?", (erased.id,)).fetchone()[0] == "deleted"
        assert conn.execute("SELECT status FROM messages WHERE id=?", (removed["id"],)).fetchone()[0] == "purged"
    _, drill, _ = execute(ops_app, "backup.drill", [backup.operationId])
    assert run_operation(rt)["status"] == "completed"
    restored = rt.paths.exports / ("op-" + drill.operationId) / "restored-instance/data/tongpin.sqlite3"
    with sqlite3.connect(restored) as conn:
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert not conn.execute("PRAGMA foreign_key_check").fetchall()
        row = conn.execute("SELECT status,reply_id,mentioned_ids,mention_all,removed_reason FROM messages WHERE id=?", (removed["id"],)).fetchone()
        assert row == ("purged", None, "[]", 0, None)
        assert conn.execute("SELECT COUNT(*) FROM message_reactions WHERE message_id=?", (removed["id"],)).fetchone()[0] == 0
        for table in ("bookmarks", "friend_preferences", "notifications", "recovery_codes", "reset_credentials"):
            assert conn.execute("SELECT COUNT(*) FROM " + table + " WHERE user_id=?", (erased.id,)).fetchone()[0] == 0, table
        assert not conn.execute("SELECT 1 FROM friend_requests WHERE (sender_id=? OR target_id=?) AND note<>''", (erased.id, erased.id)).fetchone()
        sessions = conn.execute("SELECT id,token_hash,device,second_factor_at,revoked_at,idle_ms,last_seen_at FROM sessions WHERE user_id=?", (erased.id,)).fetchall()
        assert sessions, "The audited command's foreign key must be retained."
        for sid, token_hash, device, factor, revoked, idle, seen in sessions:
            assert (token_hash, device, factor, idle, seen) == ("erased:" + sid, "", None, 0, 0)
            assert revoked is not None
