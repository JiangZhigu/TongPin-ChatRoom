from __future__ import annotations

import json

import pytest
from test_admin import admin_app as admin_app  # noqa: PLC0414
from test_admin import fails
from test_tasks import change, group, key, personal

from tongpin.contracts.admin_s2 import SensitiveRead
from tongpin.contracts.admin_tasks import GroupTaskRead
from tongpin.contracts.base import InputModel
from tongpin.contracts.tasks import TaskCreate, TaskReportInput
from tongpin.infra.db import now_ms

pytestmark = pytest.mark.asyncio


async def test_group_write_restrictions_and_idempotent_replay_revalidate_current_actor(admin_app):
    rt, actors = admin_app[0].runtime, admin_app[1]
    owner, member = actors[2], actors[3]
    gid = group(rt, owner, member)
    create_key = key()
    data = TaskCreate(scope="group", groupId=gid, title="权限实时重验", assigneeId=member.id)
    rt.tasks.create(member, data, create_key)
    for table, update, args, reset, code in [
        ("memberships", "muted_until=?", [now_ms() + 60000, member.id], "muted_until=NULL", "MUTED"),
        ("conversations", "everyone_muted=1", [gid], "everyone_muted=0", "MUTED"),
        ("conversations", "status='frozen'", [gid], "status='active'", "CONVERSATION_FROZEN"),
    ]:
        target = "user_id" if table == "memberships" else "id"
        with rt.db.write() as conn:
            conn.execute("UPDATE " + table + " SET " + update + " WHERE " + target + "=?", args)
        fails(code, lambda: rt.tasks.create(member, data, create_key))
        with rt.db.write() as conn:
            conn.execute("UPDATE " + table + " SET " + reset + " WHERE " + target + "=?", (member.id if target == "user_id" else gid,))
    assert rt.tasks.create(member, data, create_key)["duplicate"]
    with rt.db.write() as conn:
        rt.groups.remove_in(conn, gid, member.id, "removed")
    fails("RESOURCE_UNAVAILABLE", lambda: rt.tasks.create(member, data, create_key))
    private = personal(rt, owner)
    with rt.db.write() as conn:
        conn.execute("UPDATE users SET status='deleting',deletion_at=? WHERE id=?", (now_ms() + 60000, owner.id))
    fails("AUTH_REQUIRED", lambda: rt.tasks.get(owner, private["id"]))


async def test_expired_recycle_and_moderation_reads_expire_before_physical_cleanup(admin_app):
    rt, actors = admin_app[0].runtime, admin_app[1]
    admin, owner = actors[0], actors[2]
    gid = group(rt, owner)
    task = rt.tasks.create(owner, TaskCreate(scope="group", groupId=gid, title="已到期"), key())["task"]
    deleted = change(rt, owner, task, "remove")
    with rt.db.write() as conn:
        conn.execute("UPDATE todo_tasks SET deleted_at=? WHERE id=?", (now_ms() - 31 * 86400000, task["id"]))
    fails("TASK_UNAVAILABLE", lambda: rt.tasks.get(owner, task["id"]))
    fails("TASK_UNAVAILABLE", lambda: rt.tasks.mutate(owner, task["id"], "restore", InputModel(), key(), deleted["etag"]))
    assert rt.tasks.list(owner, {"view": "group", "deleted": "only", "status": "all"})["total"] == 0
    fails("RESOURCE_UNAVAILABLE", lambda: rt.admin.task_group_read(admin, task["id"], GroupTaskRead(reason="隔离读取到期材料")))


async def test_retention_batches_continue_and_backup_holds_tasks_keys_and_reports(admin_app):
    rt, owner = admin_app[0].runtime, admin_app[1][2]
    template = personal(rt, owner)
    old = now_ms() - 31 * 86400000
    with rt.db.write() as conn:
        row = dict(conn.execute("SELECT * FROM todo_tasks WHERE id=?", (template["id"],)).fetchone())
        columns = list(row)
        row["deleted_at"] = old
        for i in range(101):
            row["id"] = "batch-expired-" + str(i)
            conn.execute("INSERT INTO todo_tasks(" + ",".join(columns) + ") VALUES(" + ",".join("?" for _ in columns) + ")", [row[c] for c in columns])
        for _ in range(1001):
            conn.execute("INSERT INTO todo_mutation_keys VALUES(?,?,?,?,?,?)", (owner.id, key(), "hash", "task", "expired-reference", old))
        conn.execute("INSERT INTO instance_metadata(key,value) VALUES('backup_active','1') ON CONFLICT(key) DO UPDATE SET value='1'")
    assert rt.lifecycle.cleanup()["heldByBackup"]
    with rt.db.write() as conn:
        assert conn.execute("SELECT COUNT(*) FROM todo_tasks").fetchone()[0] == 102
        conn.execute("UPDATE instance_metadata SET value='0' WHERE key='backup_active'")
    first = rt.lifecycle.cleanup()
    assert first["tasksPurged"] == 100 and first["taskKeysPurged"] == 1000 and first["morePending"]
    second = rt.lifecycle.cleanup()
    assert second["tasksPurged"] == 1 and second["taskKeysPurged"] == 1 and not second["morePending"]
    assert rt.tasks.get(owner, template["id"])["deletedAt"] is None


async def test_account_erasure_keeps_only_held_task_and_feedback_material(admin_app):
    rt, actors = admin_app[0].runtime, admin_app[1]
    admin, owner = actors[0], actors[2]
    held, unheld = personal(rt, owner), personal(rt, owner)
    report = rt.tasks.report(owner, held["id"], TaskReportInput(category="other", description="仅保留此项举报"), key(), held["etag"])
    with rt.db.write() as conn:
        conn.execute("UPDATE users SET status='deleting',deletion_at=? WHERE id=?", (now_ms() - 1, owner.id))
    assert rt.lifecycle.cleanup()["accountsPurged"] == 1
    with rt.db.read() as conn:
        assert not conn.execute("SELECT 1 FROM todo_tasks WHERE id=?", (unheld["id"],)).fetchone()
        assert conn.execute("SELECT 1 FROM todo_tasks WHERE id=?", (held["id"],)).fetchone()
        assert not conn.execute("SELECT 1 FROM todo_reminders WHERE user_id=?", (owner.id,)).fetchone()
    detail = rt.admin.task_report_read(admin, report["id"], SensitiveRead(reason="核验明确保留的举报"))
    assert detail["report"]["reporter"]["nickname"] == "已注销用户"
    assert unheld["id"] not in json.dumps(detail)
    with rt.db.write() as conn:
        conn.execute("UPDATE todo_reports SET status='closed',closed_at=? WHERE id=?", (now_ms() - 31 * 86400000, report["id"]))
    result = rt.lifecycle.cleanup()
    assert result["taskReportsPurged"] == 1 and result["tasksPurged"] == 1
