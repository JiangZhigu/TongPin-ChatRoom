from __future__ import annotations

import asyncio
import json
import sqlite3
from contextlib import closing

import pytest
from test_admin import admin_app as admin_app  # noqa: PLC0414
from test_admin import execute, fails
from test_admin_operations import ops_app as ops_app  # noqa: PLC0414
from test_admin_operations import run_operation
from test_groups import identities
from test_task_governance import report
from test_tasks import group, key, personal

from tongpin.contracts.tasks import TaskCreate
from tongpin.infra.db import now_ms
from tongpin.runtime import Runtime

pytestmark = pytest.mark.asyncio


async def test_reminder_worker_restart_and_reclaimed_job_keep_one_delivery(settings):
    rt = Runtime(settings)
    await rt.start()
    try:
        await rt.runner.stop()
        actors, _ = identities(rt, 1)
        task = personal(rt, actors[0], dueOn="2030-03-04")
        with rt.db.write() as conn:
            job_id = conn.execute("SELECT id FROM jobs WHERE kind='tasks.remind' AND entity_id=?", (task["id"],)).fetchone()[0]
            # The fixture makes a durable job due; calendar conversion has its own
            # real-zone tests. Delivery here is performed by the actual runner.
            conn.execute("UPDATE jobs SET run_after=? WHERE id=?", (now_ms(), job_id))
    finally:
        await rt.stop()
    for repeat in (False, True):
        restarted = Runtime(settings)
        if repeat:
            with restarted.db.write() as conn:
                conn.execute("UPDATE jobs SET status='pending',lease_until=NULL,completed_at=NULL,run_after=? WHERE id=?", (now_ms(), job_id))
        await restarted.start()
        try:
            for _ in range(100):
                with restarted.db.read() as conn:
                    job = conn.execute("SELECT status,result_json FROM jobs WHERE id=?", (job_id,)).fetchone()
                if job["status"] == "completed":
                    break
                await asyncio.sleep(.1)
            assert job["status"] == "completed"
            assert json.loads(job["result_json"])["delivered"] is (not repeat)
            with restarted.db.read() as conn:
                assert conn.execute("SELECT COUNT(*) FROM notifications WHERE kind='task.due' AND entity_ref=?", (task["id"],)).fetchone()[0] == 1
                assert conn.execute("SELECT COUNT(*) FROM todo_reminder_receipts WHERE task_id=?", (task["id"],)).fetchone()[0] == 1
        finally:
            await restarted.stop()


async def test_new_report_after_backup_preserves_only_submitted_material_not_restorable_shell(ops_app):
    rt, owner = ops_app[0].runtime, ops_app[1][2]
    _, backup, _ = execute(ops_app, "backup.create", ["instance"])
    assert run_operation(rt)["status"] == "completed"
    task = personal(rt, owner, description="只应在具体举报材料中的正文")
    rid = report(rt, owner, task)["id"]
    _, drill, _ = execute(ops_app, "backup.drill", [backup.operationId])
    assert run_operation(rt)["status"] == "completed"
    restored = rt.paths.exports / ("op-" + drill.operationId) / "restored-instance/data/tongpin.sqlite3"
    with closing(sqlite3.connect(restored)) as conn:
        conn.row_factory = sqlite3.Row
        assert not conn.execute("PRAGMA foreign_key_check").fetchall()
        row = conn.execute("SELECT * FROM todo_tasks WHERE id=?", (task["id"],)).fetchone()
        assert (row["report_only"], row["moderated_deleted"], row["description"], row["source_message_id"]) == (1, 1, "", None)
        assert not rt.admin.task_summary(row)["canRestore"]
        material = json.loads(conn.execute("SELECT snapshot_json FROM todo_reports WHERE id=?", (rid,)).fetchone()[0])
        assert material["description"] == "只应在具体举报材料中的正文"
        fails("VERSION_CONFLICT", lambda: rt.admin.inspect_task_admin(conn, "task_report.close", rid, {"feedback": "不能恢复空壳", "disposition": "restore_task"}))
        rt.admin.inspect_task_admin(conn, "task_report.close", rid, {"feedback": "可以结案反馈", "disposition": "none"})


async def test_restore_refuses_to_drop_report_hold_for_group_created_after_backup(ops_app):
    rt, owner = ops_app[0].runtime, ops_app[1][2]
    _, backup, _ = execute(ops_app, "backup.create", ["instance"])
    assert run_operation(rt)["status"] == "completed"
    gid = group(rt, owner)
    task = rt.tasks.create(owner, TaskCreate(scope="group", groupId=gid, title="快照后新群举报"), key())["task"]
    report(rt, owner, task)
    _, drill, _ = execute(ops_app, "backup.drill", [backup.operationId])
    result = run_operation(rt)
    assert result["status"] == "failed"
    view = rt.admin.operation(ops_app[1][0], drill.operationId)
    assert view["errorCode"] == "RESTORE_TASK_HOLD_INCOMPLETE"
    assert not view["canDownload"]
    assert rt.tasks.get(owner, task["id"])["title"] == "快照后新群举报"
