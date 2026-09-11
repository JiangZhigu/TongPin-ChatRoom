from __future__ import annotations

from tongpin.contracts.base import APIError
from tongpin.contracts.tasks import TaskFields, title_text
from tongpin.domain.security import identifier
from tongpin.infra.db import now_ms
from tongpin.tasks.policy import unavailable
from tongpin.tasks.timezones import due_bounds


class TaskCommands:
    def audience(self, conn, row):
        if row["scope"] == "personal":
            return [row["owner_id"]]
        return [
            item[0]
            for item in conn.execute(
                "SELECT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id JOIN conversations c ON c.id=m.conversation_id WHERE m.conversation_id=? AND m.left_at IS NULL AND u.status='active' AND c.status<>'dissolved'",
                (row["group_id"],),
            )
        ]

    def notify_task(self, conn, row, user_id, kind, actor_id=None):
        if not user_id or user_id == actor_id:
            return
        preference = {
            "task.assigned": "assignments",
            "task.comment": "comments",
            "task.completed": "completed",
            "task.due": "due",
        }.get(kind)
        if preference and not self.preferences_in(conn, user_id)[preference]:
            return
        try:
            self.task_access(conn, user_id, row["id"])
        except APIError as error:
            if error.status in (403, 404):
                return
            raise
        self.runtime.events.notify(conn, user_id, kind, row["id"], actor_id)

    def changed(self, conn, task_id, actor_id, kind, *, schedule=False):
        stamp = now_ms()
        conn.execute(
            "UPDATE todo_tasks SET version=version+1,updated_at=?,schedule_revision=schedule_revision+? WHERE id=?",
            (stamp, int(schedule), task_id),
        )
        conn.execute(
            "INSERT INTO todo_activities(task_id,actor_id,kind,created_at) VALUES(?,?,?,?)",
            (task_id, actor_id, kind, stamp),
        )
        row = conn.execute("SELECT * FROM todo_tasks WHERE id=?", (task_id,)).fetchone()
        event = {
            "deleted": "task.deleted",
            "restored": "task.restored",
            "comment": "task.comment.created",
            "assigned": "task.assignment.changed",
        }.get(kind, "task.updated")
        self.runtime.events.publish(conn, self.audience(conn, row), event, task_id, row["group_id"])
        if schedule:
            self.schedule_reminders(conn, row)
        return row

    def assignment_changed(self, conn, row, old_assignee, actor_id):
        if old_assignee and old_assignee != row["assignee_id"]:
            conn.execute(
                "UPDATE todo_reminders SET rule='none',version=version+1 WHERE task_id=? AND user_id=?",
                (row["id"], old_assignee),
            )
        if row["assignee_id"] and row["assignee_id"] != old_assignee:
            conn.execute(
                "INSERT INTO todo_reminders(task_id,user_id,rule) VALUES(?,?,'day_before') ON CONFLICT(task_id,user_id) DO NOTHING",
                (row["id"], row["assignee_id"]),
            )
            self.notify_task(conn, row, row["assignee_id"], "task.assigned", actor_id)

    def create_in(self, conn, actor, data):
        self.require_creation(conn, actor, data)
        self.labels_valid(conn, actor.id, data.scope, data.listId, data.tagIds)
        self.validate_source(conn, actor.id, data)
        if data.listId or data.tagIds:
            self.enabled(True)
        field, ref, limit = (
            ("owner_id", actor.id, self.quota(conn, "personal"))
            if data.scope == "personal"
            else ("group_id", data.groupId, self.quota(conn, "group"))
        )
        count = conn.execute(
            "SELECT COUNT(*) FROM todo_tasks WHERE " + field + "=?", (ref,)
        ).fetchone()[0]
        if count >= limit:
            raise APIError(
                "TASK_QUOTA_EXCEEDED",
                f"该空间最多保留{limit}条待办（含回收期内待办），请先整理。",
                409,
            )
        tid, stamp = identifier("task_"), now_ms()
        start, end = due_bounds(data.dueOn, data.dueTimezone)
        assignee = actor.id if data.scope == "personal" else data.assigneeId
        conn.execute(
            "INSERT INTO todo_tasks(id,scope,owner_id,group_id,creator_id,assignee_id,title,description,priority,due_on,due_timezone,due_start,due_end,source_message_id,list_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                tid,
                data.scope,
                actor.id if data.scope == "personal" else None,
                data.groupId if data.scope == "group" else None,
                actor.id,
                assignee,
                data.title,
                data.description,
                data.priority,
                data.dueOn,
                data.dueTimezone,
                start,
                end,
                data.sourceMessageId,
                data.listId,
                stamp,
                stamp,
            ),
        )
        conn.executemany(
            "INSERT INTO todo_task_tags(task_id,label_id) VALUES(?,?)",
            [(tid, label) for label in data.tagIds],
        )
        conn.execute(
            "INSERT INTO todo_activities(task_id,actor_id,kind,created_at) VALUES(?,?,'created',?)",
            (tid, actor.id, stamp),
        )
        row = conn.execute("SELECT * FROM todo_tasks WHERE id=?", (tid,)).fetchone()
        self.assignment_changed(conn, row, None, actor.id)
        self.schedule_reminders(conn, row)
        self.runtime.events.publish(
            conn, self.audience(conn, row), "task.created", tid, row["group_id"]
        )
        return tid

    def create(self, actor, data, key):
        self.runtime.auth.security.rate("task-write", actor.id, 120, 60)
        with self.runtime.db.write() as conn:
            actor = self.current(conn, actor)
            self.require_creation(conn, actor, data)
            self.validate_source(conn, actor.id, data)
            old, digest = self.key_lookup(conn, actor.id, key, "create", data.model_dump())
            if old:
                return self.replay_task(conn, actor.id, old)
            tid = self.create_in(conn, actor, data)
            self.key_store(conn, actor.id, key, digest, "task", tid)
            result = {"task": self.view_in(conn, actor.id, tid), "duplicate": False}
        return result

    def patch_in(self, conn, actor, row, meta, editor, manager, data):
        values = data.model_dump(exclude_unset=True)
        fields = set(values) - {"confirmIncomplete"}
        if not fields:
            raise APIError("VALIDATION_ERROR", "请选择需要修改的字段。", 422)
        if fields & {
            "title",
            "description",
            "priority",
            "dueOn",
            "dueTimezone",
            "listId",
            "tagIds",
        }:
            self.require(editor)
        if "status" in fields:
            self.require(editor or row["assignee_id"] == actor.id)
            if data.status is None:
                raise APIError("VALIDATION_ERROR", "任务状态不能为空。", 422)
            if (
                data.status == "done"
                and not data.confirmIncomplete
                and conn.execute(
                    "SELECT 1 FROM todo_check_items WHERE task_id=? AND done=0 LIMIT 1",
                    (row["id"],),
                ).fetchone()
            ):
                raise APIError(
                    "INCOMPLETE_CHECKS", "仍有未完成检查项，请确认后再标记任务完成。", 409
                )
        if "assigneeId" in fields:
            if row["scope"] == "personal":
                self.require(data.assigneeId == actor.id)
            else:
                self.require(editor or row["assignee_id"] == actor.id)
                self.validate_assignee(
                    conn, actor.id, row["group_id"], data.assigneeId, manager, row["assignee_id"]
                )
        merged = {
            "title": row["title"],
            "description": row["description"],
            "priority": row["priority"],
            "dueOn": row["due_on"],
            "dueTimezone": row["due_timezone"],
            "assigneeId": row["assignee_id"],
            "listId": row["list_id"],
            "tagIds": [
                item[0]
                for item in conn.execute(
                    "SELECT label_id FROM todo_task_tags WHERE task_id=?", (row["id"],)
                )
            ],
        } | {
            key: value
            for key, value in values.items()
            if key not in ("status", "confirmIncomplete")
        }
        checked = TaskFields.model_validate(merged)
        self.labels_valid(conn, actor.id, row["scope"], checked.listId, checked.tagIds)
        if fields & {"listId", "tagIds"}:
            self.enabled(True)
        start, end = due_bounds(checked.dueOn, checked.dueTimezone)
        status = values.get("status", row["status"])
        completed = (
            now_ms()
            if status == "done" and row["status"] != "done"
            else row["completed_at"]
            if status == "done"
            else None
        )
        completed_by = (
            actor.id
            if status == "done" and row["status"] != "done"
            else row["completed_by"]
            if status == "done"
            else None
        )
        conn.execute(
            "UPDATE todo_tasks SET title=?,description=?,priority=?,due_on=?,due_timezone=?,due_start=?,due_end=?,assignee_id=?,list_id=?,status=?,completed_at=?,completed_by=? WHERE id=?",
            (
                checked.title,
                checked.description,
                checked.priority,
                checked.dueOn,
                checked.dueTimezone,
                start,
                end,
                checked.assigneeId,
                checked.listId,
                status,
                completed,
                completed_by,
                row["id"],
            ),
        )
        if "tagIds" in fields:
            conn.execute("DELETE FROM todo_task_tags WHERE task_id=?", (row["id"],))
            conn.executemany(
                "INSERT INTO todo_task_tags(task_id,label_id) VALUES(?,?)",
                [(row["id"], label) for label in checked.tagIds],
            )
        assigned = checked.assigneeId != row["assignee_id"]
        next_row = conn.execute("SELECT * FROM todo_tasks WHERE id=?", (row["id"],)).fetchone()
        if assigned:
            self.assignment_changed(conn, next_row, row["assignee_id"], actor.id)
        if status == "done" and row["status"] != "done":
            recipients = {next_row["creator_id"], next_row["assignee_id"]} | {
                item[0]
                for item in conn.execute(
                    "SELECT user_id FROM todo_marks WHERE task_id=? AND followed=1", (row["id"],)
                )
            }
            for uid in recipients:
                self.notify_task(conn, next_row, uid, "task.completed", actor.id)
        return "assigned" if assigned else "status" if "status" in fields else "updated", bool(
            fields & {"dueOn", "dueTimezone", "status", "assigneeId"}
        )

    def authorize_command(self, conn, actor, row, editor, manager, action, data):
        self.write_allowed(conn, actor.id, row["group_id"])
        if action in {"remove", "restore", "check.create", "check.remove"}:
            self.require(editor)
        elif action == "patch":
            fields = data.model_fields_set - {"confirmIncomplete"}
            if fields & {
                "title",
                "description",
                "priority",
                "dueOn",
                "dueTimezone",
                "listId",
                "tagIds",
            }:
                self.require(editor)
            if "status" in fields:
                self.require(editor or row["assignee_id"] == actor.id)
            if "assigneeId" in fields:
                self.require(editor or row["assignee_id"] == actor.id)
                if row["scope"] == "group" and data.assigneeId not in (None, actor.id):
                    self.require(manager)
        elif action == "check.patch":
            if "text" in data.model_fields_set:
                self.require(editor)
            if "done" in data.model_fields_set:
                self.require(editor or row["assignee_id"] == actor.id)
        elif action in {"claim", "release"}:
            self.require(row["scope"] == "group")

    def mutate(self, actor, task_id, action, data, key, etag, item_id=None):
        self.runtime.auth.security.rate("task-write", actor.id, 120, 60)
        enhanced = action in {"comment.create", "comment.remove", "reminder", "marks"}
        with self.runtime.db.write() as conn:
            actor = self.current(conn, actor, enhanced=enhanced)
            row, meta, editor, manager = self.task_access(conn, actor.id, task_id)
            self.authorize_command(conn, actor, row, editor, manager, action, data)
            if action == "comment.remove":
                comment = self.comment_access(conn, actor.id, row, meta, item_id)
                self.require(manager or comment["author_id"] == actor.id)
            old, digest = self.key_lookup(
                conn,
                actor.id,
                key,
                action + ":" + task_id + ":" + (item_id or ""),
                data.model_dump(exclude_unset=True),
            )
            if old:
                return self.replay_task(conn, actor.id, old)
            self.check_version(self.view_in(conn, actor.id, task_id), etag)
            if row["deleted_at"] is not None and action != "restore":
                raise unavailable()
            schedule = False
            if action == "patch":
                kind, schedule = self.patch_in(conn, actor, row, meta, editor, manager, data)
            elif action == "remove":
                conn.execute("UPDATE todo_tasks SET deleted_at=? WHERE id=?", (now_ms(), task_id))
                kind, schedule = "deleted", True
            elif action == "restore":
                if row["deleted_at"] is None:
                    raise APIError("TASK_NOT_DELETED", "该待办当前未被删除。", 409)
                if row["deleted_at"] + 30 * 86400000 <= now_ms():
                    raise unavailable()
                assignee = row["assignee_id"]
                if (
                    row["group_id"]
                    and assignee
                    and not conn.execute(
                        "SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.conversation_id=? AND m.user_id=? AND m.left_at IS NULL AND u.status='active'",
                        (row["group_id"], assignee),
                    ).fetchone()
                ):
                    assignee = None
                conn.execute(
                    "UPDATE todo_tasks SET deleted_at=NULL,assignee_id=? WHERE id=?",
                    (assignee, task_id),
                )
                kind, schedule = "restored", True
            elif action in {"claim", "release"}:
                if action == "claim" and row["assignee_id"] is not None:
                    raise APIError("CLAIM_CONFLICT", "这项待办已经有负责人，请刷新后查看。", 409)
                if action == "release":
                    self.require(manager or row["assignee_id"] == actor.id)
                assignee = actor.id if action == "claim" else None
                conn.execute("UPDATE todo_tasks SET assignee_id=? WHERE id=?", (assignee, task_id))
                next_row = conn.execute(
                    "SELECT * FROM todo_tasks WHERE id=?", (task_id,)
                ).fetchone()
                self.assignment_changed(conn, next_row, row["assignee_id"], actor.id)
                kind, schedule = ("claimed" if action == "claim" else "released"), True
            elif action.startswith("check."):
                self.check_command(conn, row, action, data, item_id)
                kind = "check"
            else:
                kind, schedule = self.enhanced_command(
                    conn, actor, row, meta, manager, action, data, item_id
                )
            if action in {"marks", "reminder"}:
                # Personal organization and reminder settings are not public activity.
                self.runtime.events.publish(conn, [actor.id], "task.updated", task_id)
            else:
                self.changed(conn, task_id, actor.id, kind, schedule=schedule)
            self.key_store(conn, actor.id, key, digest, "task", task_id)
            result = {"task": self.view_in(conn, actor.id, task_id), "duplicate": False}
        return result

    def check_command(self, conn, row, action, data, item_id):
        if action == "check.create":
            count = conn.execute(
                "SELECT COUNT(*) FROM todo_check_items WHERE task_id=?", (row["id"],)
            ).fetchone()[0]
            if count >= 50:
                raise APIError("CHECK_ITEM_LIMIT", "每项待办最多50个检查项。", 409)
            position = conn.execute(
                "SELECT COALESCE(MAX(position),0)+1 FROM todo_check_items WHERE task_id=?",
                (row["id"],),
            ).fetchone()[0]
            conn.execute(
                "INSERT INTO todo_check_items(id,task_id,text,position) VALUES(?,?,?,?)",
                (identifier("check_"), row["id"], data.text, position),
            )
        else:
            item = conn.execute(
                "SELECT * FROM todo_check_items WHERE id=? AND task_id=?", (item_id, row["id"])
            ).fetchone()
            if not item:
                raise unavailable()
            if action == "check.remove":
                conn.execute("DELETE FROM todo_check_items WHERE id=?", (item_id,))
            else:
                if not data.model_fields_set or any(
                    getattr(data, key) is None for key in data.model_fields_set
                ):
                    raise APIError("VALIDATION_ERROR", "检查项更改不能为空。", 422)
                try:
                    text = (
                        title_text(data.text) if "text" in data.model_fields_set else item["text"]
                    )
                except ValueError as error:
                    raise APIError("VALIDATION_ERROR", str(error), 422) from error
                conn.execute(
                    "UPDATE todo_check_items SET text=?,done=? WHERE id=?",
                    (
                        text,
                        int(data.done) if "done" in data.model_fields_set else item["done"],
                        item_id,
                    ),
                )
