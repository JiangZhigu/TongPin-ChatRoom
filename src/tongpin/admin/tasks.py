from __future__ import annotations

import json

from tongpin.admin.authz import conflict, identity, page, unavailable
from tongpin.admin.sensitive import like_query, paged_sql, query_budget, sensitive_read
from tongpin.contracts.base import APIError
from tongpin.infra.db import now_ms

DAY = 86400000
TASK_ACTIONS = {
    "task.delete",
    "task.restore",
    "task.comment.delete",
    "task.group.policy",
    "task_report.close",
    "task_report.reopen",
}


def validate_task_parameters(action, targets, values):
    if action not in TASK_ACTIONS:
        return False
    fields = (
        {"feedback", "disposition"}
        if action == "task_report.close"
        else {"createPolicy"}
        if action == "task.group.policy"
        else set()
    )
    if set(values) != fields:
        raise APIError("VALIDATION_ERROR", "待办治理参数与动作不匹配。", 422)
    if action == "task_report.close" and (
        not isinstance(values["feedback"], str)
        or not 3 <= len(values["feedback"].strip()) <= 1000
        or values["disposition"] not in ("none", "delete_task", "delete_comment", "restore_task")
    ):
        raise APIError("VALIDATION_ERROR", "请填写3–1000字反馈并选择本举报的处置。", 422)
    if action == "task.group.policy" and values["createPolicy"] not in ("members", "managers"):
        raise APIError("VALIDATION_ERROR", "请选择成员或群管理员创建。", 422)
    return True


class TasksAdmin:
    @staticmethod
    def task_summary(row):
        return {
            "id": row["id"],
            "groupId": row["group_id"],
            "title": row["title"],
            "status": row["status"],
            "priority": row["priority"],
            "dueOn": row["due_on"],
            "deletedAt": row["deleted_at"],
            "moderatedDeleted": bool(row["moderated_deleted"]),
            "canRestore": bool(
                row["moderated_deleted"]
                and not row["report_only"]
                and (row["deleted_at"] or 0) > now_ms() - 30 * DAY
            ),
            "version": row["version"],
            "createdAt": row["created_at"],
        }

    def task_group_search(self, actor, data, request_id=""):
        with sensitive_read(self, actor, "group_tasks", data.groupId, data.reason, request_id) as (
            conn,
            details,
        ):
            group = conn.execute(
                "SELECT * FROM conversations WHERE id=? AND kind='group'", (data.groupId,)
            ).fetchone()
            if not group:
                raise unavailable()
            where, args = "t.scope='group' AND t.group_id=?", [data.groupId]
            if data.query:
                where += " AND t.title LIKE ? ESCAPE '!'"
                args.append(like_query(data.query))
            if data.status:
                where += " AND t.status=?"
                args.append(data.status)
            if data.deleted != "all":
                where += " AND t.deleted_at IS " + (
                    "NOT NULL" if data.deleted == "only" else "NULL"
                )
            paged, values = paged_sql(where, args, data.after, "t")
            with query_budget(conn):
                total = conn.execute(
                    "SELECT COUNT(*) FROM todo_tasks t WHERE " + where, args
                ).fetchone()[0]
                rows = conn.execute(
                    "SELECT * FROM todo_tasks t WHERE "
                    + paged
                    + " ORDER BY created_at DESC,id DESC LIMIT ?",
                    [*values, data.limit + 1],
                ).fetchall()
                result = page(
                    rows,
                    total,
                    data.limit,
                    self.task_summary,
                    key=lambda r: [r["created_at"], r["id"]],
                )
            setting = conn.execute(
                "SELECT * FROM todo_group_settings WHERE group_id=?", (data.groupId,)
            ).fetchone()
            details["count"] = len(result["items"])
            return result | {
                "group": {
                    "id": group["id"],
                    "name": group["name"],
                    "status": group["status"],
                    "createPolicy": setting["create_policy"] if setting else "members",
                    "quota": self.runtime.tasks.quota(conn, "group"),
                }
            }

    def task_group_read(self, actor, tid, data, request_id=""):
        with sensitive_read(self, actor, "group_task", tid, data.reason, request_id) as (conn, _):
            row = conn.execute(
                "SELECT * FROM todo_tasks WHERE id=? AND scope='group'", (tid,)
            ).fetchone()
            if (
                not row
                or row["deleted_at"] is not None
                and row["deleted_at"] <= now_ms() - 30 * DAY
            ):
                raise unavailable()
            where, values = paged_sql("r.task_id=?", [tid], data.after, "r")
            with query_budget(conn):
                total = conn.execute(
                    "SELECT COUNT(*) FROM todo_comments WHERE task_id=?", (tid,)
                ).fetchone()[0]
                comments = conn.execute(
                    "SELECT * FROM todo_comments r WHERE "
                    + where
                    + " ORDER BY created_at DESC,id DESC LIMIT ?",
                    [*values, data.limit + 1],
                ).fetchall()
            return {
                "task": self.task_summary(row)
                | {
                    "description": row["description"],
                    "creator": identity(conn, row["creator_id"]),
                    "assignee": identity(conn, row["assignee_id"]) if row["assignee_id"] else None,
                    "checks": [
                        dict(r)
                        for r in conn.execute(
                            "SELECT id,text,done FROM todo_check_items WHERE task_id=? ORDER BY position,id LIMIT 50",
                            (tid,),
                        )
                    ],
                },
                "comments": page(
                    comments,
                    total,
                    data.limit,
                    lambda r: {
                        "id": r["id"],
                        "text": r["text"] if r["removed_at"] is None else "",
                        "removed": r["removed_at"] is not None,
                        "author": identity(conn, r["author_id"]),
                        "createdAt": r["created_at"],
                    },
                    key=lambda r: [r["created_at"], r["id"]],
                ),
            }

    @staticmethod
    def task_report_summary(row):
        # No private title, task ID, description or other tasks in this metadata list.
        return {
            "id": row["id"],
            "category": row["category"],
            "status": row["status"],
            "createdAt": row["created_at"],
            "closedAt": row["closed_at"],
            "version": row["version"],
        }

    def task_reports_list(self, actor, status="", after="", limit=50):
        if status not in ("", "open", "closed"):
            raise APIError("VALIDATION_ERROR", "举报状态无效。", 422)
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            where, args = "(r.status='open' OR r.closed_at>?)", [now_ms() - 30 * DAY]
            if status:
                where += " AND r.status=?"
                args.append(status)
            paged, values = paged_sql(where, args, after, "r")
            with query_budget(conn):
                total = conn.execute(
                    "SELECT COUNT(*) FROM todo_reports r WHERE " + where, args
                ).fetchone()[0]
                rows = conn.execute(
                    "SELECT * FROM todo_reports r WHERE "
                    + paged
                    + " ORDER BY created_at DESC,id DESC LIMIT ?",
                    [*values, limit + 1],
                ).fetchall()
            return page(
                rows,
                total,
                limit,
                self.task_report_summary,
                key=lambda r: [r["created_at"], r["id"]],
            )

    @staticmethod
    def task_report_in(conn, rid):
        row = conn.execute("SELECT * FROM todo_reports WHERE id=?", (rid,)).fetchone()
        if not row or row["status"] == "closed" and (row["closed_at"] or 0) <= now_ms() - 30 * DAY:
            raise unavailable()
        return row

    def task_report_read(self, actor, rid, data, request_id=""):
        with sensitive_read(self, actor, "task_report", rid, data.reason, request_id) as (conn, _):
            row = self.task_report_in(conn, rid)
            task = conn.execute(
                "SELECT deleted_at,moderated_deleted,report_only,version FROM todo_tasks WHERE id=?",
                (row["task_id"],),
            ).fetchone()
            comment = (
                conn.execute(
                    "SELECT removed_at FROM todo_comments WHERE id=? AND task_id=?",
                    (row["comment_id"], row["task_id"]),
                ).fetchone()
                if row["comment_id"]
                else None
            )
            return {
                "report": self.task_report_summary(row)
                | {
                    "description": row["description"],
                    "feedback": row["resolution"],
                    "reporter": identity(conn, row["reporter_id"]),
                },
                "submitted": json.loads(row["snapshot_json"]),
                "targetState": {
                    "available": bool(task and not task["report_only"]),
                    "deleted": bool(task and task["deleted_at"] is not None),
                    "moderatedDeleted": bool(task and task["moderated_deleted"]),
                    "hasComment": bool(row["comment_id"]),
                    "commentRemoved": not comment or comment[0] is not None,
                },
            }

    def inspect_task_admin(self, conn, action, target, values):
        if action == "task.group.policy":
            row = conn.execute(
                "SELECT status,admin_governance_version FROM conversations WHERE id=? AND kind='group'",
                (target,),
            ).fetchone()
            if not row or row["status"] == "dissolved":
                raise unavailable()
            setting = conn.execute(
                "SELECT * FROM todo_group_settings WHERE group_id=?", (target,)
            ).fetchone()
            return (
                {"group": dict(row), "setting": dict(setting) if setting else None},
                "群待办创建策略",
                values["createPolicy"],
            )
        if action.startswith("task_report."):
            report = self.task_report_in(conn, target)
            if report["status"] != ("open" if action == "task_report.close" else "closed"):
                raise conflict("待办举报状态已经改变。")
            row = conn.execute(
                "SELECT * FROM todo_tasks WHERE id=?", (report["task_id"],)
            ).fetchone()
            snap = {
                "reportId": target,
                "reportVersion": report["version"],
                "taskVersion": row["version"] if row else None,
            }
            disposition = values.get("disposition", "none")
            if disposition != "none" and not row:
                raise unavailable()
            if disposition != "none" and row["report_only"]:
                raise conflict("恢复的快照只保留此举报材料，没有可恢复的原任务。")
            if (
                disposition == "delete_task"
                and row["deleted_at"] is not None
                or disposition == "restore_task"
                and (
                    not row["moderated_deleted"] or (row["deleted_at"] or 0) <= now_ms() - 30 * DAY
                )
            ):
                raise conflict("待办的管理删除状态已改变。")
            if disposition == "delete_comment":
                comment = conn.execute(
                    "SELECT removed_at FROM todo_comments WHERE id=? AND task_id=?",
                    (report["comment_id"], report["task_id"]),
                ).fetchone()
                if not comment or comment[0] is not None:
                    raise conflict("该举报没有可删除的原评论。")
                snap["commentRemoved"] = comment[0]
            return (
                snap,
                "待办举报 " + target,
                "重新打开" if action.endswith("reopen") else "结案并反馈；处置：" + disposition,
            )
        if action == "task.comment.delete":
            comment = conn.execute("SELECT * FROM todo_comments WHERE id=?", (target,)).fetchone()
            row = (
                conn.execute(
                    "SELECT * FROM todo_tasks WHERE id=? AND scope='group'", (comment["task_id"],)
                ).fetchone()
                if comment
                else None
            )
            if not row or comment["removed_at"] is not None:
                raise unavailable()
            return (
                {"taskId": row["id"], "version": row["version"], "commentId": target},
                "群待办评论",
                "删除指定评论",
            )
        row = conn.execute(
            "SELECT * FROM todo_tasks WHERE id=? AND scope='group'", (target,)
        ).fetchone()
        if not row or row["report_only"]:
            raise unavailable()
        if (
            action == "task.delete"
            and row["deleted_at"] is not None
            or action == "task.restore"
            and (not row["moderated_deleted"] or (row["deleted_at"] or 0) <= now_ms() - 30 * DAY)
        ):
            raise conflict("管理删除状态或30天恢复期限已改变。")
        return (
            {
                "id": target,
                "version": row["version"],
                "deletedAt": row["deleted_at"],
                "moderated": row["moderated_deleted"],
            },
            "群待办 " + target,
            "管理删除" if action.endswith("delete") else "撤销管理删除",
        )

    def task_disposition(self, conn, tid, actor_id, disposition, comment_id=None):
        if disposition == "none":
            return
        if disposition == "delete_comment":
            conn.execute(
                "UPDATE todo_comments SET removed_at=?,text='' WHERE id=? AND task_id=?",
                (now_ms(), comment_id, tid),
            )
        else:
            deleting = disposition == "delete_task"
            conn.execute(
                "UPDATE todo_tasks SET moderated_deleted=?,deleted_at=? WHERE id=?",
                (int(deleting), now_ms() if deleting else None, tid),
            )
        self.runtime.tasks.changed(conn, tid, actor_id, "moderated", schedule=True)

    def apply_task_admin(self, conn, command, target, values):
        action = command["action"]
        self.inspect_task_admin(conn, action, target, values)
        if action == "task.group.policy":
            conn.execute(
                "INSERT INTO todo_group_settings(group_id,create_policy,version) VALUES(?,?,2) ON CONFLICT(group_id) DO UPDATE SET create_policy=excluded.create_policy,version=version+1",
                (target, values["createPolicy"]),
            )
            self.runtime.events.publish(
                conn,
                self.runtime.access.recipients(conn, target),
                "task.group.settings.changed",
                target,
                target,
            )
        elif action.startswith("task_report."):
            row = self.task_report_in(conn, target)
            closed = action.endswith("close")
            self.task_disposition(
                conn,
                row["task_id"],
                command["actor_id"],
                values.get("disposition", "none"),
                row["comment_id"],
            )
            conn.execute(
                "UPDATE todo_reports SET status=?,resolution=?,closed_at=?,version=version+1 WHERE id=?",
                (
                    "closed" if closed else "open",
                    values.get("feedback"),
                    now_ms() if closed else None,
                    target,
                ),
            )
            self.runtime.events.notify(conn, row["reporter_id"], "task.report.updated", target)
        elif action == "task.comment.delete":
            row = conn.execute("SELECT task_id FROM todo_comments WHERE id=?", (target,)).fetchone()
            self.task_disposition(conn, row[0], command["actor_id"], "delete_comment", target)
        else:
            self.task_disposition(
                conn,
                target,
                command["actor_id"],
                "delete_task" if action.endswith("delete") else "restore_task",
            )
        return "待办治理已保存，当前访问与审计已更新。"
