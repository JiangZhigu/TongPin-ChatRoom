from __future__ import annotations

import json
import sqlite3
from contextlib import closing

import httpx
import pytest
from test_admin import ORIGIN, execute, fails, preview, reauth
from test_admin import admin_app as admin_app  # noqa: PLC0414
from test_admin_operations import ops_app as ops_app  # noqa: PLC0414
from test_admin_operations import run_operation
from test_admin_s2 import settings_update
from test_tasks import change, group, key, personal

from tongpin.contracts.admin_s2 import SensitiveRead
from tongpin.contracts.admin_tasks import GroupTaskRead, GroupTasksRead
from tongpin.contracts.base import InputModel
from tongpin.contracts.tasks import TaskComment, TaskCreate, TaskMarks, TaskPatch, TaskReportInput
from tongpin.infra.db import now_ms

pytestmark = pytest.mark.asyncio
REASON = "隔离待办治理读取理由"


def report(rt, actor, task, comment_id=None):
    return rt.tasks.report(actor, task["id"], TaskReportInput(category="other", description="核对指定对象材料", commentId=comment_id), key(), task["etag"])


async def test_private_governance_is_report_scoped_audited_and_not_routine_search(admin_app):
    app, actors, tokens, _, _ = admin_app
    rt, admin, owner = app.runtime, actors[0], actors[2]
    task = personal(rt, owner, description="仅举报时提交的description")
    secret_other = personal(rt, owner, description="不应进入管理员返回的其他私人事项")
    fails("TASK_UNAVAILABLE", lambda: rt.tasks.get(admin, task["id"]))
    fails("RESOURCE_UNAVAILABLE", lambda: rt.admin.task_group_read(admin, task["id"], GroupTaskRead(reason=REASON)))
    r = report(rt, owner, rt.tasks.get(owner, task["id"]))
    summaries = rt.admin.task_reports_list(admin)
    assert summaries["total"] == 1 and "title" not in json.dumps(summaries)
    detail = rt.admin.task_report_read(admin, r["id"], SensitiveRead(reason=REASON), "task-report-read-id")
    assert detail["submitted"]["description"] == "仅举报时提交的description"
    assert secret_other["id"] not in json.dumps(detail) and task["id"] not in json.dumps(detail)
    # The material is fixed at report submission, not a way to observe later private edits.
    task = change(rt, owner, task, "patch", TaskPatch(description="后续未提交的私人新正文"))
    assert "后续未提交" not in json.dumps(rt.admin.task_report_read(admin, r["id"], SensitiveRead(reason=REASON)), ensure_ascii=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=ORIGIN, headers={"Origin": ORIGIN}) as client:
        client.cookies.set(rt.auth.cookie_name, tokens[0])
        client.headers["X-CSRF-Token"] = rt.auth.security.csrf(tokens[0])
        assert (await client.post("/api/v1/admin/tasks/search", json={"reason": REASON})).status_code == 422
        assert (await client.post("/api/v1/admin/tasks/" + task["id"] + "/read", json={"reason": REASON})).status_code == 404
        response = await client.post("/api/v1/admin/task-reports/" + r["id"] + "/read", json={"reason": REASON})
        assert response.status_code == 200
        client.cookies.set(rt.auth.cookie_name, tokens[2])
        client.headers["X-CSRF-Token"] = rt.auth.security.csrf(tokens[2])
        assert (await client.get("/api/v1/admin/task-reports")).status_code == 403
    # A standalone private ID cannot become a governance command target.
    fails("RESOURCE_UNAVAILABLE", lambda: preview(rt, admin, "task.delete", [task["id"]]))
    receipt, _, _ = execute(admin_app, "task_report.close", [r["id"]], {"feedback": "已核对并删除指定对象", "disposition": "delete_task"})
    assert receipt["succeeded"] == 1
    fails("TASK_UNAVAILABLE", lambda: rt.tasks.get(owner, task["id"]))
    fails("TASK_UNAVAILABLE", lambda: rt.tasks.mutate(owner, task["id"], "restore", InputModel(), key(), task["etag"]))
    assert all(item["id"] != task["id"] for item in rt.tasks.list(owner, {"view": "personal", "deleted": "only", "status": "all"})["items"])
    assert any("已核对并删除指定对象" in n["text"] for n in rt.events.notifications(owner)["items"])
    with rt.db.read() as conn:
        audit = json.dumps([dict(row) for row in conn.execute("SELECT * FROM audit_events WHERE action LIKE 'admin.%'")], ensure_ascii=False)
        assert "仅举报时提交的description" not in audit and "后续未提交" not in audit
    execute(admin_app, "task_report.reopen", [r["id"]])
    execute(admin_app, "task_report.close", [r["id"]], {"feedback": "复核后恢复指定对象", "disposition": "restore_task"})
    assert rt.tasks.get(owner, task["id"])["description"] == "后续未提交的私人新正文"


async def test_group_governance_current_fingerprint_comments_and_quota_form(admin_app):
    rt, actors = admin_app[0].runtime, admin_app[1]
    admin, owner, member = actors[0], actors[2], actors[3]
    gid = group(rt, owner, member)
    task = rt.tasks.create(owner, TaskCreate(scope="group", groupId=gid, title="定向群待办"), key())["task"]
    read = rt.admin.task_group_search(admin, GroupTasksRead(reason=REASON, groupId=gid, limit=1))
    assert read["total"] == 1 and read["items"][0]["id"] == task["id"]
    data = preview(rt, admin, "task.delete", [task["id"]])
    authorization = reauth(rt, admin, data.operationId, admin_app[3][0].pop())
    task = change(rt, owner, task, "patch", TaskPatch(title="预览后修改"))
    fails("VERSION_CONFLICT", lambda: rt.admin.execute(admin, authorization))
    task = change(rt, member, rt.tasks.get(member, task["id"]), "comment.create", TaskComment(text="可审计删除的评论"))
    comment = rt.tasks.comments(owner, task["id"])["items"][0]
    detail = rt.admin.task_group_read(admin, task["id"], GroupTaskRead(reason=REASON))
    assert detail["comments"]["total"] == 1
    execute(admin_app, "task.comment.delete", [comment["id"]])
    assert rt.tasks.comments(owner, task["id"])["items"][0]["text"] == ""
    execute(admin_app, "task.group.policy", [gid], {"createPolicy": "managers"})
    fails("FORBIDDEN", lambda: rt.tasks.create(member, TaskCreate(scope="group", groupId=gid, title="不得创建"), key()))
    settings = rt.admin.settings_view(admin)
    assert {"task_personal_quota", "task_group_quota"} <= {f["key"] for f in settings["fields"]}
    settings_update(admin_app, task_personal_quota=1, task_group_quota=1)
    assert rt.tasks.meta(owner)["limits"]["personal"] == 1
    assert rt.tasks.group_settings(owner, gid)["quota"] == 1
    fails("TASK_QUOTA_EXCEEDED", lambda: rt.tasks.create(owner, TaskCreate(scope="group", groupId=gid, title="超过配额"), key()))
    personal(rt, owner)
    fails("TASK_QUOTA_EXCEEDED", lambda: personal(rt, owner))
    execute(admin_app, "session.revoke", [admin.session["id"]], index=1)
    fails("AUTH_REQUIRED", lambda: rt.admin.task_group_search(admin, GroupTasksRead(reason=REASON, groupId=gid)))


async def test_report_retention_expiry_and_minimal_comment_material(admin_app):
    rt, actors = admin_app[0].runtime, admin_app[1]
    admin, owner, member = actors[0], actors[2], actors[3]
    gid = group(rt, owner, member)
    task = rt.tasks.create(owner, TaskCreate(scope="group", groupId=gid, title="评论举报", description="举报评论不应带入整个description"), key())["task"]
    task = change(rt, member, rt.tasks.get(member, task["id"]), "comment.create", TaskComment(text="选中的举报评论"))
    comment = rt.tasks.comments(member, task["id"])["items"][0]
    rid = report(rt, member, task, comment["id"])["id"]
    detail = rt.admin.task_report_read(admin, rid, SensitiveRead(reason=REASON))
    assert detail["submitted"]["comment"] == "选中的举报评论" and "description" not in detail["submitted"]
    execute(admin_app, "task_report.close", [rid], {"feedback": "已删除举报评论", "disposition": "delete_comment"})
    assert rt.tasks.comments(member, task["id"])["items"][0]["removed"]
    with rt.db.write() as conn:
        conn.execute("UPDATE todo_reports SET closed_at=? WHERE id=?", (now_ms() - 31 * 86400000, rid))
    fails("RESOURCE_UNAVAILABLE", lambda: rt.admin.task_report_read(admin, rid, SensitiveRead(reason=REASON)))
    assert rt.admin.task_reports_list(admin)["total"] == 0
    rt.lifecycle.cleanup()
    with rt.db.read() as conn:
        assert not conn.execute("SELECT 1 FROM todo_reports WHERE id=?", (rid,)).fetchone()


async def test_actual_backup_drill_replays_task_erasure_membership_and_delivery_authority(ops_app):
    rt, actors = ops_app[0].runtime, ops_app[1]
    owner, member = actors[2], actors[3]
    gid = group(rt, owner, member)
    task = rt.tasks.create(owner, TaskCreate(scope="group", groupId=gid, title="旧备份负责人", assigneeId=member.id, dueOn="2030-01-02"), key())["task"]
    task = change(rt, member, rt.tasks.get(member, task["id"]), "comment.create", TaskComment(text="旧加入期评论"))
    comment = rt.tasks.comments(owner, task["id"])["items"][0]
    private = personal(rt, owner)
    task = change(rt, member, rt.tasks.get(member, task["id"]), "marks", TaskMarks(followed=True, bookmarked=True))
    _, backup, _ = execute(ops_app, "backup.create", ["instance"])
    assert run_operation(rt)["status"] == "completed"
    with rt.db.write() as conn:
        rt.groups.remove_in(conn, gid, member.id, "removed")
        rt.groups.add_member(conn, gid, member.id)
        conn.execute("UPDATE todo_comments SET removed_at=?,text='' WHERE id=?", (now_ms(), comment["id"]))
        conn.execute("DELETE FROM todo_tasks WHERE id=?", (private["id"],))
    task = rt.tasks.get(owner, task["id"])
    task = change(rt, owner, task, "patch", TaskPatch(status="done"))
    rid = report(rt, owner, task)["id"]
    receipt_key = key()
    newer = rt.tasks.create(owner, TaskCreate(scope="personal", title="备份后新建不应重复"), receipt_key)["task"]
    _, drill, _ = execute(ops_app, "backup.drill", [backup.operationId])
    result = run_operation(rt)
    assert result["status"] == "completed", result
    restored = rt.paths.exports / ("op-" + drill.operationId) / "restored-instance/data/tongpin.sqlite3"
    with closing(sqlite3.connect(restored)) as conn:
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert not conn.execute("PRAGMA foreign_key_check").fetchall()
        assert not conn.execute("SELECT 1 FROM todo_tasks WHERE id=?", (private["id"],)).fetchone()
        assert conn.execute("SELECT assignee_id,status FROM todo_tasks WHERE id=?", (task["id"],)).fetchone() == (None, "done")
        assert conn.execute("SELECT text,removed_at IS NOT NULL FROM todo_comments WHERE id=?", (comment["id"],)).fetchone() == ("", 1)
        assert not conn.execute("SELECT 1 FROM todo_marks WHERE task_id=? AND user_id=?", (task["id"], member.id)).fetchone()
        watermark = conn.execute("SELECT w.comment_floor FROM todo_membership_watermarks w JOIN memberships m ON m.id=w.period_id WHERE m.conversation_id=? AND m.user_id=? AND left_at IS NULL", (gid, member.id)).fetchone()[0]
        assert watermark >= conn.execute("SELECT seq FROM todo_comments WHERE id=?", (comment["id"],)).fetchone()[0]
        assert conn.execute("SELECT seq FROM sqlite_sequence WHERE name='todo_comments'").fetchone()[0] >= watermark
        assert conn.execute("SELECT status FROM todo_reports WHERE id=?", (rid,)).fetchone()[0] == "open"
        assert conn.execute("SELECT result_ref FROM todo_mutation_keys WHERE user_id=? AND key=?", (owner.id, receipt_key)).fetchone()[0] == newer["id"]
        assert not conn.execute("SELECT 1 FROM jobs WHERE kind='tasks.remind' AND entity_id=? AND status='pending'", (task["id"],)).fetchone()
