from __future__ import annotations

import sqlite3
import uuid

import pytest
from test_admin import PASSWORD, execute, fails
from test_admin import admin_app as admin_app  # noqa: PLC0414
from test_admin_operations import ops_app as ops_app  # noqa: PLC0414
from test_admin_operations import run_operation
from test_admin_s2 import message
from test_files import image_bytes, upload
from test_groups import create, join, member

from tongpin.contracts.auth import ReauthInput
from tongpin.contracts.groups import GroupTransferInput
from tongpin.infra.db import now_ms

pytestmark = pytest.mark.asyncio


async def test_restore_rejoined_member_owner_transfer_receipt_and_due_deletions(ops_app):
    rt, actors = ops_app[0].runtime, ops_app[1]
    admin, owner, peer, new_owner, deleting = actors[0], actors[2], actors[3], actors[4], actors[5]
    conversation = create(rt, owner)["conversation"]
    cid = conversation["id"]
    join(rt, owner, peer, cid)
    join(rt, owner, new_owner, cid)
    image = upload(rt, owner, rt.chat.get(owner, cid), image_bytes(), "恢复后到期清理.png")
    sent = message(rt, owner, rt.chat.get(owner, cid), attachmentIds=[image["id"]])
    old_period = member(rt, owner, cid, peer)["periodId"]
    token = rt.auth.reauth(owner, ReauthInput(action="group_transfer:" + cid, password=PASSWORD))[
        "reauthToken"
    ]
    transfer = rt.groups.start_transfer(
        owner,
        cid,
        GroupTransferInput(
            clientRequestId=str(uuid.uuid4()),
            expectedVersion=rt.groups.get(owner, cid)["version"],
            targetUserId=peer.id,
            targetPeriodId=old_period,
            reauthToken=token,
        ),
    )
    _, backup, _ = execute(ops_app, "backup.create", ["instance"])
    assert run_operation(rt)["status"] == "completed"
    rt.groups.leave(peer, cid)
    join(rt, owner, peer, cid)
    new_period = member(rt, owner, cid, peer)["periodId"]
    assert new_period != old_period
    execute(ops_app, "group.owner.change", [cid], {"userId": new_owner.id})
    execute(ops_app, "message.delete", [sent["id"]])
    with rt.db.write() as conn:
        conn.execute(
            "UPDATE messages SET removed_at=? WHERE id=?", (now_ms() - 31 * 86400000, sent["id"])
        )
        conn.execute(
            "UPDATE users SET status='deleting',deletion_at=? WHERE id=?",
            (now_ms() - 1, deleting.id),
        )
    _, drill, _ = execute(ops_app, "backup.drill", [backup.operationId])
    result = run_operation(rt)
    assert result["status"] == "completed", result
    path = (
        rt.paths.exports
        / ("op-" + drill.operationId)
        / "restored-instance"
        / "data"
        / "tongpin.sqlite3"
    )
    with sqlite3.connect(path) as conn:
        assert not conn.execute("PRAGMA foreign_key_check").fetchall()
        assert (
            conn.execute("SELECT owner_id FROM conversations WHERE id=?", (cid,)).fetchone()[0]
            == new_owner.id
        )
        assert (
            conn.execute(
                "SELECT id FROM memberships WHERE conversation_id=? AND user_id=? AND left_at IS NULL",
                (cid, peer.id),
            ).fetchone()[0]
            == new_period
        )
        assert (
            conn.execute("SELECT left_at FROM memberships WHERE id=?", (old_period,)).fetchone()[0]
            is not None
        )
        assert (
            conn.execute(
                "SELECT status FROM group_transfers WHERE id=?", (transfer["id"],)
            ).fetchone()[0]
            == "cancelled"
        )
        assert tuple(
            conn.execute("SELECT status,text FROM messages WHERE id=?", (sent["id"],)).fetchone()
        ) == ("purged", "")
        assert tuple(
            conn.execute(
                "SELECT quota_bytes,state FROM attachments WHERE id=?", (image["id"],)
            ).fetchone()
        ) == (0, "expired")
        assert (
            conn.execute("SELECT status FROM users WHERE id=?", (deleting.id,)).fetchone()[0]
            == "deleted"
        )
    result = rt.admin.operation(admin, drill.operationId)["result"]["restore"]
    assert result["cleanup"]["messagesPurged"] == 1 and result["cleanup"]["accountsPurged"] == 1
    assert result["cleanup"]["filesRemoved"] >= 1 and result["cleanup"]["bytesReleased"] > 0


async def test_restart_requeues_only_unstarted_operation_and_admin_lane_isolated(ops_app):
    rt = ops_app[0].runtime
    _, command, _ = execute(ops_app, "backup.create", ["instance"])
    job = rt.operation_runner.claim()
    assert job and job["payload"]["operationId"] == command.operationId
    with rt.db.read() as conn:
        lease = conn.execute("SELECT lease_until FROM jobs WHERE id=?", (job["id"],)).fetchone()[0]
        assert lease - now_ms() > 890000
    rt.admin.initialize_operations()
    assert run_operation(rt)["status"] == "completed"
    with rt.db.read() as conn:
        assert conn.execute("SELECT attempts FROM jobs WHERE id=?", (job["id"],)).fetchone()[0] == 2
    assert "admin.operation" in rt.runner.excluded_kinds
    assert rt.operation_runner.kinds == ("admin.operation",)
    with rt.db.read() as conn:
        fails('OPERATION_NOT_RETRYABLE', lambda: rt.admin.inspect_operation(conn, 'operation.retry', command.operationId, {}))


async def test_scheduled_backup_queue_pressure_defers_without_losing_daily_schedule(ops_app):
    rt = ops_app[0].runtime
    with rt.db.write() as conn:
        for _ in range(20):
            rt.admin.create_operation(conn, str(uuid.uuid4()), 'backup.create', None, None, {'parameters':{}, 'reason':'隔离排队压力'}, '', backup_class='daily')
        conn.execute("UPDATE jobs SET run_after=0 WHERE kind='backups.schedule'")
    job = rt.jobs.claim(kinds=('backups.schedule',))
    result = rt.admin.scheduled_backup(job)
    assert result == {'deferred': True, 'retryAfterMs': 300000}
    rt.logs.persist()
    with rt.db.read() as conn:
        assert conn.execute('SELECT status FROM jobs WHERE id=?', (job['id'],)).fetchone()[0] == 'pending'
        assert conn.execute('SELECT COUNT(*) FROM admin_operations').fetchone()[0] == 20
        assert conn.execute("SELECT COUNT(*) FROM runtime_logs WHERE code='BACKUP_SCHEDULE_BUSY'").fetchone()[0] == 1
        assert not conn.execute("SELECT value FROM instance_metadata WHERE key='last_automatic_backup_day'").fetchone()
