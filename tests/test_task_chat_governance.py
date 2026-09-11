from __future__ import annotations

import json
import zipfile

import pytest
from test_admin import admin_app as admin_app  # noqa: PLC0414
from test_admin import execute
from test_admin_operations import artifact_path, export_parameters, run_operation
from test_admin_operations import ops_app as ops_app  # noqa: PLC0414
from test_tasks import change, group, key, personal

from tongpin.contracts.admin_s2 import SensitiveRead
from tongpin.contracts.tasks import TaskCreate, TaskPatch, TaskShare
from tongpin.infra.db import now_ms

pytestmark = pytest.mark.asyncio


async def test_shared_snapshot_is_audited_chat_material_without_private_task_reference(ops_app):
    rt, actors = ops_app[0].runtime, ops_app[1]
    admin, owner, peer = actors[0], actors[2], actors[3]
    gid = group(rt, owner, peer)
    dm = rt.chat.direct(owner, peer.id)["id"]
    task = personal(rt, owner, description="主动共享的静态正文")
    shared = rt.tasks.share(owner, task["id"], TaskShare(mode="snapshot", destinationConversationId=dm, includeDescription=True), key(), task["etag"])
    task = change(rt, owner, task, "patch", TaskPatch(description="原任务后续私人编辑"))
    body = rt.admin.content_read(admin, shared["messageId"], SensitiveRead(reason="核对已发送的静态副本"))["message"]
    assert body["taskCard"]["snapshot"]["description"] == "主动共享的静态正文"
    assert task["id"] not in json.dumps(body) and "原任务后续私人编辑" not in json.dumps(body, ensure_ascii=False)
    _, export, _ = execute(ops_app, "export.create", ["instance"], export_parameters(filters={"conversationId": dm}, includeFiles=False))
    assert run_operation(rt)["status"] == "completed"
    with zipfile.ZipFile(artifact_path(rt, export.operationId)) as archive:
        rows = [json.loads(line) for line in archive.read("records.jsonl").splitlines()]
    assert rows[0]["taskCard"] == body["taskCard"]
    assert task["id"] not in json.dumps(rows)
    change(rt, owner, task, "remove")
    with rt.db.write() as conn:
        conn.execute("UPDATE todo_tasks SET deleted_at=? WHERE id=?", (now_ms() - 31 * 86400000, task["id"]))
    rt.lifecycle.cleanup()
    assert rt.admin.content_read(admin, shared["messageId"], SensitiveRead(reason="静态副本独立保留"))["message"]["taskCard"] == body["taskCard"]
    group_task = rt.tasks.create(owner, TaskCreate(scope="group", groupId=gid, title="群动态正文不可随聊天批量导出", description="去待办治理另行读取"), key())["task"]
    live = rt.tasks.share(owner, group_task["id"], TaskShare(mode="live", destinationConversationId=dm), key(), group_task["etag"])
    link = rt.admin.content_read(admin, live["messageId"], SensitiveRead(reason="核对群任务卡片引用"))["message"]["taskCard"]
    assert link == {"kind": "live", "taskId": group_task["id"], "groupId": gid}
    change(rt, owner, group_task, "remove")
    assert rt.admin.content_read(admin, live["messageId"], SensitiveRead(reason="已删除任务卡片"))["message"]["taskCard"] == {"kind": "unavailable"}
    with rt.db.write() as conn:
        conn.execute("UPDATE messages SET status='recalled',removed_at=? WHERE id=?", (now_ms() - 31 * 86400000, shared["messageId"]))
    # Retention applies before a physical cleanup job has run.
    assert rt.admin.content_read(admin, shared["messageId"], SensitiveRead(reason="到期卡片停止读取"))["message"]["taskCard"] is None
    rt.lifecycle.cleanup()
    with rt.db.read() as conn:
        assert not conn.execute("SELECT 1 FROM todo_message_cards WHERE message_id=?", (shared["messageId"],)).fetchone()
