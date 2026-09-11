from __future__ import annotations

from tongpin.contracts.base import APIError
from tongpin.contracts.chat import page_limit, sequence
from tongpin.domain.access import user_summary
from tongpin.domain.chat import activity_cursor, next_activity
from tongpin.infra.db import now_ms
from tongpin.tasks.policy import strong_etag, unavailable

ACTIVITIES = {
    "created": "创建了待办",
    "updated": "更新了待办内容",
    "status": "更新了进展",
    "assigned": "更新了负责人",
    "claimed": "认领了待办",
    "released": "放回待认领",
    "member_left": "负责人离开了群，未完成待办已放回待认领",
    "deleted": "删除了待办",
    "restored": "恢复了待办",
    "check": "更新了检查项",
    "comment": "发表了评论",
    "comment_removed": "移除了评论",
    "moderated": "运营处理了待办",
    "reminder": "更新了本人的提醒规则",
}


class TaskQueries:
    def preferences_in(self, conn, actor_id):
        row = conn.execute("SELECT * FROM todo_preferences WHERE user_id=?", (actor_id,)).fetchone()
        return {
            key: bool(row[key]) if row else True
            for key in ("assignments", "comments", "completed", "due")
        } | {"timezone": row["timezone"] if row else "Asia/Shanghai"}

    def meta(self, actor):
        with self.runtime.db.read() as conn:
            actor = self.runtime.auth.current_in_transaction(conn, actor)
            reason = None
            try:
                self.write_allowed(conn, actor.id)
            except APIError as error:
                reason = error.message
            return {
                "actorId": actor.id,
                "enabled": self.runtime.settings.feature_tasks,
                "enhanced": self.runtime.settings.feature_tasks
                and self.runtime.settings.feature_tasks_enhanced,
                "canCreatePersonal": reason is None and self.runtime.settings.feature_tasks,
                "writeReason": reason,
                "preferences": self.preferences_in(conn, actor.id),
                "labels": [
                    dict(row)
                    for row in conn.execute(
                        "SELECT id,name,kind FROM todo_labels WHERE user_id=? ORDER BY kind,name,id",
                        (actor.id,),
                    )
                ],
                "limits": {
                    "personal": self.quota(conn, "personal"),
                    "group": self.quota(conn, "group"),
                    "checkItems": 50,
                    "draftDays": 7,
                    "draftCount": 100,
                },
            }

    def view_in(self, conn, actor_id, task_id):
        row, meta, editor, manager = self.task_access(conn, actor_id, task_id)
        creator = conn.execute("SELECT * FROM users WHERE id=?", (row["creator_id"],)).fetchone()
        assignee = (
            conn.execute("SELECT * FROM users WHERE id=?", (row["assignee_id"],)).fetchone()
            if row["assignee_id"]
            else None
        )
        source = None
        if row["source_message_id"]:
            source = {"available": False}
            try:
                original, _ = self.runtime.access.message(conn, actor_id, row["source_message_id"])
                if original["status"] == "sent":
                    source = {
                        "available": True,
                        "messageId": original["id"],
                        "conversationId": original["conversation_id"],
                        "text": original["text"][:240],
                    }
            except APIError as error:
                if error.status not in (403, 404):
                    raise
        checks = [
            dict(item) | {"done": bool(item["done"])}
            for item in conn.execute(
                "SELECT id,text,done,position FROM todo_check_items WHERE task_id=? ORDER BY position,id",
                (task_id,),
            )
        ]
        marks = conn.execute(
            "SELECT * FROM todo_marks WHERE task_id=? AND user_id=?", (task_id, actor_id)
        ).fetchone()
        reminder = conn.execute(
            "SELECT rule,local_time FROM todo_reminders WHERE task_id=? AND user_id=?",
            (task_id, actor_id),
        ).fetchone()
        result = {
            "id": row["id"],
            "scope": row["scope"],
            "ownerId": row["owner_id"],
            "groupId": row["group_id"],
            "groupName": meta["row"]["name"] if meta else None,
            "creator": user_summary(creator),
            "assignee": user_summary(assignee) if assignee else None,
            "title": row["title"],
            "description": row["description"],
            "priority": row["priority"],
            "status": row["status"],
            "dueOn": row["due_on"],
            "dueTimezone": row["due_timezone"],
            "overdue": row["status"] != "done"
            and row["deleted_at"] is None
            and row["due_end"] is not None
            and now_ms() >= row["due_end"],
            "completedAt": row["completed_at"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "deletedAt": row["deleted_at"],
            "version": row["version"],
            "checkItems": checks,
            "source": source,
            "capabilities": self.capabilities(conn, actor_id, row, meta, editor, manager),
            "followed": bool(marks and marks["followed"]),
            "bookmarked": bool(marks and marks["bookmarked"]),
            "listId": row["list_id"],
            "tagIds": [
                item[0]
                for item in conn.execute(
                    "SELECT label_id FROM todo_task_tags WHERE task_id=? ORDER BY label_id",
                    (task_id,),
                )
            ],
            "reminder": {"rule": reminder["rule"], "time": reminder["local_time"]}
            if reminder
            else {"rule": "none", "time": "09:00"},
            "viewerId": actor_id,
        }
        result["etag"] = strong_etag(
            {
                "view": result,
                "access": meta["accessKey"] if meta else actor_id,
                "policy": self.runtime.policy.get(conn)["version"],
            }
        )
        return result

    def get(self, actor, task_id):
        with self.runtime.db.read() as conn:
            actor = self.current(conn, actor)
            return self.view_in(conn, actor.id, task_id)

    def list(self, actor, query):
        allowed = {
            "view",
            "groupId",
            "status",
            "priority",
            "assignee",
            "due",
            "q",
            "deleted",
            "listId",
            "tagId",
            "after",
            "limit",
        }
        if set(query) - allowed:
            raise APIError("VALIDATION_ERROR", "不支持的待办筛选参数。", 422)
        view, status = query.get("view", "mine"), query.get("status", "open")
        if view not in {
            "mine",
            "personal",
            "group",
            "created",
            "followed",
            "bookmarked",
        } or status not in {"open", "all", "todo", "doing", "done"}:
            raise APIError("VALIDATION_ERROR", "待办视图或状态无效。", 422)
        priority, assignee, due = (
            query.get("priority", ""),
            query.get("assignee", "all"),
            query.get("due", ""),
        )
        if (
            priority not in {"", "low", "normal", "high"}
            or assignee not in {"all", "me", "unassigned"}
            or due not in {"", "today", "overdue"}
            or query.get("deleted", "") not in {"", "only"}
        ):
            raise APIError("VALIDATION_ERROR", "待办筛选条件无效。", 422)
        text = query.get("q", "").strip()
        if len(text) > 120:
            raise APIError("VALIDATION_ERROR", "搜索关键词最多120字。", 422)
        limit = page_limit(query.get("limit", 30))
        boundary, last = activity_cursor(query.get("after", ""))
        with self.runtime.db.read() as conn:
            actor = self.current(conn, actor)
            clauses = [
                "((t.scope='personal' AND t.owner_id=?) OR (t.scope='group' AND EXISTS(SELECT 1 FROM memberships m JOIN conversations c ON c.id=m.conversation_id WHERE m.conversation_id=t.group_id AND m.user_id=? AND m.left_at IS NULL AND c.status<>'dissolved')))"
            ]
            clauses.append("t.moderated_deleted=0")
            clauses.append("t.report_only=0")
            clauses.append("(t.deleted_at IS NULL OR t.deleted_at>?)")
            args = [actor.id, actor.id, now_ms() - 30 * 86400000]
            if query.get("deleted") == "only":
                clauses.extend(
                    [
                        "t.deleted_at IS NOT NULL",
                        "(t.owner_id=? OR t.creator_id=? OR EXISTS(SELECT 1 FROM memberships m WHERE m.conversation_id=t.group_id AND m.user_id=? AND m.left_at IS NULL AND m.role IN('owner','admin')))",
                    ]
                )
                args.extend([actor.id] * 3)
            else:
                clauses.append("t.deleted_at IS NULL")
            if view == "mine":
                clauses.append("(t.owner_id=? OR t.assignee_id=?)")
                args.extend([actor.id] * 2)
            elif view == "personal":
                clauses.append("t.owner_id=?")
                args.append(actor.id)
            elif view == "group":
                clauses.append("t.scope='group'")
            elif view == "created":
                clauses.append("t.creator_id=?")
                args.append(actor.id)
            else:
                self.enabled(True)
                clauses.append(
                    f"EXISTS(SELECT 1 FROM todo_marks mk WHERE mk.task_id=t.id AND mk.user_id=? AND mk.{view}=1)"
                )
                args.append(actor.id)
            if query.get("groupId"):
                self.group_meta(conn, actor.id, query["groupId"])
                clauses.append("t.group_id=?")
                args.append(query["groupId"])
            if status == "open":
                clauses.append("t.status<>'done'")
            elif status != "all":
                clauses.append("t.status=?")
                args.append(status)
            if priority:
                clauses.append("t.priority=?")
                args.append(priority)
            if assignee == "me":
                clauses.append("t.assignee_id=?")
                args.append(actor.id)
            elif assignee == "unassigned":
                clauses.append("t.assignee_id IS NULL")
            stamp = now_ms()
            if due == "today":
                clauses.append("t.due_start<=? AND t.due_end>?")
                args.extend([stamp, stamp])
            elif due == "overdue":
                clauses.append("t.due_end<=? AND t.status<>'done'")
                args.append(stamp)
            if text:
                pattern = "%" + text.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%"
                clauses.append("(t.title LIKE ? ESCAPE '!' OR t.description LIKE ? ESCAPE '!')")
                args.extend([pattern] * 2)
            if query.get("listId"):
                clauses.append("t.list_id=? AND t.owner_id=?")
                args.extend([query["listId"], actor.id])
            if query.get("tagId"):
                clauses.append(
                    "t.owner_id=? AND EXISTS(SELECT 1 FROM todo_task_tags tags WHERE tags.task_id=t.id AND tags.label_id=?)"
                )
                args.extend([actor.id, query["tagId"]])
            where = " AND ".join(clauses)
            count = conn.execute(
                "SELECT COUNT(*) FROM todo_tasks t WHERE " + where, args
            ).fetchone()[0]
            rows = conn.execute(
                "SELECT t.id,t.updated_at FROM todo_tasks t WHERE "
                + where
                + " AND (?=0 OR t.updated_at<? OR(t.updated_at=? AND t.id<?)) ORDER BY t.updated_at DESC,t.id DESC LIMIT ?",
                [*args, boundary, boundary, boundary, last, limit + 1],
            ).fetchall()
            return {
                "items": [self.view_in(conn, actor.id, row["id"]) for row in rows[:limit]],
                "nextCursor": next_activity(rows, limit, "updated_at"),
                "total": count,
                "actorId": actor.id,
            }

    def history_scope(self, conn, actor_id, task_id):
        row, meta, _, _ = self.task_access(conn, actor_id, task_id)
        if row["deleted_at"] is not None:
            raise unavailable()
        floor = (
            conn.execute(
                "SELECT * FROM todo_membership_watermarks WHERE period_id=?", (meta["periodId"],)
            ).fetchone()
            if meta
            else None
        )
        # An unknown member period is conservatively denied historic discussion.
        return row, meta, floor

    def activities(self, actor, task_id, after="", limit=30):
        boundary, last = activity_cursor(after)
        last_number = sequence(last) if last else 0
        limit = page_limit(limit)
        with self.runtime.db.read() as conn:
            actor = self.current(conn, actor)
            _, meta, floor = self.history_scope(conn, actor.id, task_id)
            if meta and not floor:
                return {"items": [], "nextCursor": None}
            rows = conn.execute(
                "SELECT * FROM todo_activities WHERE task_id=? AND id>? AND created_at>=? AND (?=0 OR created_at<? OR(created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?",
                (
                    task_id,
                    floor["activity_floor"] if floor else 0,
                    meta["membership"]["joined_at"] if meta else 0,
                    boundary,
                    boundary,
                    boundary,
                    last_number,
                    limit + 1,
                ),
            ).fetchall()
            items = []
            for row in rows[:limit]:
                user = (
                    conn.execute("SELECT * FROM users WHERE id=?", (row["actor_id"],)).fetchone()
                    if row["actor_id"]
                    else None
                )
                items.append(
                    {
                        "id": str(row["id"]),
                        "kind": row["kind"],
                        "actor": user_summary(user) if user else None,
                        "createdAt": row["created_at"],
                        "text": ACTIVITIES.get(row["kind"], "更新了待办"),
                    }
                )
            return {"items": items, "nextCursor": next_activity(rows, limit)}

    def comments(self, actor, task_id, after="", limit=30):
        boundary, last = activity_cursor(after)
        limit = page_limit(limit)
        with self.runtime.db.read() as conn:
            actor = self.current(conn, actor, enhanced=True)
            _, meta, floor = self.history_scope(conn, actor.id, task_id)
            if meta and not floor:
                return {"items": [], "nextCursor": None}
            rows = conn.execute(
                "SELECT * FROM todo_comments WHERE task_id=? AND seq>? AND created_at>=? AND (?=0 OR created_at<? OR(created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?",
                (
                    task_id,
                    floor["comment_floor"] if floor else 0,
                    meta["membership"]["joined_at"] if meta else 0,
                    boundary,
                    boundary,
                    boundary,
                    last,
                    limit + 1,
                ),
            ).fetchall()
            dto = self.view_in(conn, actor.id, task_id)
            items = []
            for row in rows[:limit]:
                user = conn.execute(
                    "SELECT * FROM users WHERE id=?", (row["author_id"],)
                ).fetchone()
                items.append(
                    {
                        "id": row["id"],
                        "text": row["text"] if row["removed_at"] is None else "",
                        "author": user_summary(user),
                        "createdAt": row["created_at"],
                        "removed": row["removed_at"] is not None,
                        "canDelete": dto["capabilities"]["comment"]
                        and row["removed_at"] is None
                        and (
                            row["author_id"] == actor.id
                            or bool(meta and meta["role"] in {"owner", "admin"})
                        ),
                    }
                )
            return {"items": items, "nextCursor": next_activity(rows, limit)}
