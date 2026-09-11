from __future__ import annotations

from datetime import date, timedelta

from tongpin.contracts.base import APIError
from tongpin.domain.security import audit, identifier
from tongpin.infra.db import now_ms
from tongpin.tasks.policy import canonical, strong_etag, unavailable
from tongpin.tasks.timezones import local_instant


class TaskEnhanced:
    def schedule_reminders(self, conn, row):
        if (
            not self.runtime.settings.feature_tasks_enhanced
            or not row["due_on"]
            or row["deleted_at"] is not None
            or row["status"] == "done"
        ):
            return
        for pref in conn.execute(
            "SELECT * FROM todo_reminders WHERE task_id=? AND rule<>'none'", (row["id"],)
        ).fetchall():
            try:
                self.task_access(conn, pref["user_id"], row["id"])
            except APIError as error:
                if error.status in (403, 404):
                    continue
                raise
            day = date.fromisoformat(row["due_on"]) - timedelta(
                days=1 if pref["rule"] == "day_before" else 0
            )
            instant = local_instant(day, pref["local_time"], row["due_timezone"])
            if instant <= now_ms():
                continue
            payload = {
                "taskId": row["id"],
                "userId": pref["user_id"],
                "revision": row["schedule_revision"],
                "preferenceVersion": pref["version"],
            }
            self.runtime.jobs.enqueue_in_transaction(
                conn,
                "tasks.remind",
                payload,
                entity_id=row["id"],
                dedupe_key=f"task-reminder:{row['id']}:{pref['user_id']}:{row['schedule_revision']}:{pref['version']}",
                run_after=instant,
            )

    def remind(self, job):
        payload = job["payload"]
        with self.runtime.db.write() as conn:
            if (
                not self.runtime.settings.feature_tasks
                or not self.runtime.settings.feature_tasks_enhanced
            ):
                return {"delivered": False}
            row = conn.execute(
                "SELECT * FROM todo_tasks WHERE id=?", (payload["taskId"],)
            ).fetchone()
            pref = conn.execute(
                "SELECT * FROM todo_reminders WHERE task_id=? AND user_id=?",
                (payload["taskId"], payload["userId"]),
            ).fetchone()
            user = conn.execute(
                "SELECT status FROM users WHERE id=?", (payload["userId"],)
            ).fetchone()
            if (
                not row
                or not pref
                or not user
                or user["status"] != "active"
                or row["deleted_at"] is not None
                or row["status"] == "done"
                or row["schedule_revision"] != payload["revision"]
                or pref["version"] != payload["preferenceVersion"]
                or pref["rule"] == "none"
            ):
                return {"delivered": False}
            try:
                self.task_access(conn, payload["userId"], row["id"])
            except APIError as error:
                if error.status in (403, 404):
                    return {"delivered": False}
                raise
            added = conn.execute(
                "INSERT INTO todo_reminder_receipts(task_id,user_id,schedule_revision,preference_version,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING",
                (
                    row["id"],
                    payload["userId"],
                    payload["revision"],
                    payload["preferenceVersion"],
                    now_ms(),
                ),
            ).rowcount
            if added:
                self.notify_task(conn, row, payload["userId"], "task.due")
        return {"delivered": bool(added)}

    def comment_access(self, conn, actor_id, row, meta, comment_id):
        comment = conn.execute(
            "SELECT * FROM todo_comments WHERE task_id=? AND id=?", (row["id"], comment_id)
        ).fetchone()
        if not comment:
            raise unavailable()
        if meta:
            floor = conn.execute(
                "SELECT * FROM todo_membership_watermarks WHERE period_id=?", (meta["periodId"],)
            ).fetchone()
            if (
                not floor
                or comment["seq"] <= floor["comment_floor"]
                or comment["created_at"] < meta["membership"]["joined_at"]
            ):
                raise unavailable()
        return comment

    def enhanced_command(self, conn, actor, row, meta, manager, action, data, item_id):
        if action == "comment.create":
            conn.execute(
                "INSERT INTO todo_comments(id,task_id,author_id,period_id,text,created_at) VALUES(?,?,?,?,?,?)",
                (
                    identifier("comment_"),
                    row["id"],
                    actor.id,
                    meta["periodId"] if meta else None,
                    data.text,
                    now_ms(),
                ),
            )
            recipients = {row["creator_id"], row["assignee_id"]} | {
                item[0]
                for item in conn.execute(
                    "SELECT user_id FROM todo_marks WHERE task_id=? AND followed=1", (row["id"],)
                )
            }
            for uid in recipients:
                self.notify_task(conn, row, uid, "task.comment", actor.id)
            return "comment", False
        if action == "comment.remove":
            comment = self.comment_access(conn, actor.id, row, meta, item_id)
            self.require(manager or comment["author_id"] == actor.id)
            conn.execute(
                "UPDATE todo_comments SET text='',removed_at=COALESCE(removed_at,?) WHERE id=?",
                (now_ms(), item_id),
            )
            return "comment_removed", False
        if action == "reminder":
            conn.execute(
                "INSERT INTO todo_reminders(task_id,user_id,rule,local_time) VALUES(?,?,?,?) ON CONFLICT(task_id,user_id) DO UPDATE SET rule=excluded.rule,local_time=excluded.local_time,version=version+1",
                (row["id"], actor.id, data.rule, data.time),
            )
            # Preference revision invalidates this user's older generation only.
            self.schedule_reminders(conn, row)
            return "reminder", False
        if action == "marks":
            if not data.model_fields_set or any(
                getattr(data, key) is None for key in data.model_fields_set
            ):
                raise APIError("VALIDATION_ERROR", "请选择收藏或关注设置。", 422)
            old = conn.execute(
                "SELECT * FROM todo_marks WHERE task_id=? AND user_id=?", (row["id"], actor.id)
            ).fetchone()
            followed = (
                int(data.followed) if data.followed is not None else old["followed"] if old else 0
            )
            bookmarked = (
                int(data.bookmarked)
                if data.bookmarked is not None
                else old["bookmarked"]
                if old
                else 0
            )
            conn.execute(
                "INSERT INTO todo_marks(task_id,user_id,followed,bookmarked) VALUES(?,?,?,?) ON CONFLICT(task_id,user_id) DO UPDATE SET followed=excluded.followed,bookmarked=excluded.bookmarked",
                (row["id"], actor.id, followed, bookmarked),
            )
            return "marks", False
        raise APIError("VALIDATION_ERROR", "不支持的待办命令。", 422)

    def set_preferences(self, actor, data, key):
        with self.runtime.db.write() as conn:
            actor = self.current(conn, actor, enhanced=True)
            self.write_allowed(conn, actor.id)
            old, digest = self.key_lookup(conn, actor.id, key, "preferences", data.model_dump())
            if not old:
                conn.execute(
                    "INSERT INTO todo_preferences(user_id,assignments,comments,completed,due,timezone) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET assignments=excluded.assignments,comments=excluded.comments,completed=excluded.completed,due=excluded.due,timezone=excluded.timezone",
                    (
                        actor.id,
                        int(data.assignments),
                        int(data.comments),
                        int(data.completed),
                        int(data.due),
                        data.timezone,
                    ),
                )
                self.key_store(conn, actor.id, key, digest, "preferences", actor.id)
                self.runtime.events.publish(conn, [actor.id], "task.preferences.changed", actor.id)
            return self.preferences_in(conn, actor.id)

    def label(self, actor, data, key, label_id=None, remove=False):
        with self.runtime.db.write() as conn:
            actor = self.current(conn, actor, enhanced=True)
            self.write_allowed(conn, actor.id)
            target = (
                conn.execute(
                    "SELECT * FROM todo_labels WHERE id=? AND user_id=?", (label_id, actor.id)
                ).fetchone()
                if label_id
                else None
            )
            if label_id and not target:
                old = conn.execute(
                    "SELECT * FROM todo_mutation_keys WHERE user_id=? AND key=?", (actor.id, key)
                ).fetchone()
                if not remove or not old:
                    raise unavailable()
            command = (
                "label.delete:" if remove else "label.update:" if label_id else "label.create:"
            ) + (label_id or "")
            old, digest = self.key_lookup(conn, actor.id, key, command, data.model_dump())
            if old:
                if remove:
                    return {"deleted": True}
                result = conn.execute(
                    "SELECT id,name,kind FROM todo_labels WHERE id=? AND user_id=?",
                    (old["result_ref"], actor.id),
                ).fetchone()
                if not result:
                    raise unavailable()
                return dict(result)
            if remove:
                affected = [
                    item[0]
                    for item in conn.execute(
                        "SELECT id FROM todo_tasks WHERE list_id=? UNION SELECT task_id FROM todo_task_tags WHERE label_id=?",
                        (label_id, label_id),
                    )
                ]
                conn.execute("DELETE FROM todo_labels WHERE id=?", (label_id,))
                for tid in affected:
                    self.changed(conn, tid, actor.id, "updated")
                result = {"deleted": True}
            else:
                if target:
                    self.require(target["kind"] == data.kind)
                if conn.execute(
                    "SELECT 1 FROM todo_labels WHERE user_id=? AND kind=? AND name=? AND id<>?",
                    (actor.id, data.kind, data.name, label_id or ""),
                ).fetchone():
                    raise APIError("LABEL_EXISTS", "同类名称已存在。", 409)
                if (
                    not target
                    and conn.execute(
                        "SELECT COUNT(*) FROM todo_labels WHERE user_id=?", (actor.id,)
                    ).fetchone()[0]
                    >= 100
                ):
                    raise APIError("LABEL_LIMIT", "个人清单与标签总数最多100个。", 409)
                label_id = label_id or identifier("label_")
                conn.execute(
                    "INSERT INTO todo_labels(id,user_id,kind,name) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name",
                    (label_id, actor.id, data.kind, data.name),
                )
                result = {"id": label_id, "name": data.name, "kind": data.kind}
            self.key_store(conn, actor.id, key, digest, "label", label_id)
            self.runtime.events.publish(conn, [actor.id], "task.labels.changed", actor.id)
            return result

    def group_settings_in(self, conn, actor_id, group_id):
        meta = self.group_meta(conn, actor_id, group_id)
        row = conn.execute(
            "SELECT * FROM todo_group_settings WHERE group_id=?", (group_id,)
        ).fetchone()
        manager = meta["role"] in {"owner", "admin"}
        reason = None
        try:
            self.write_allowed(conn, actor_id, group_id)
        except APIError as error:
            reason = error.message
        policy = row["create_policy"] if row else "members"
        result = {
            "groupId": group_id,
            "createPolicy": policy,
            "canManage": manager and reason is None,
            "canCreate": reason is None and (policy == "members" or manager),
            "writeReason": reason,
            "count": conn.execute(
                "SELECT COUNT(*) FROM todo_tasks WHERE group_id=?", (group_id,)
            ).fetchone()[0],
            "quota": self.quota(conn, "group"),
        }
        result["etag"] = strong_etag(
            {"view": result, "access": meta["accessKey"], "version": row["version"] if row else 1}
        )
        return result

    def group_settings(self, actor, group_id, data=None, key=None, etag=None):
        with self.runtime.db.write() if data else self.runtime.db.read() as conn:
            actor = self.current(conn, actor)
            result = self.group_settings_in(conn, actor.id, group_id)
            if data:
                self.enabled(True)
                self.write_allowed(conn, actor.id, group_id)
                self.require(result["canManage"])
                old, digest = self.key_lookup(
                    conn, actor.id, key, "group.settings:" + group_id, data.model_dump()
                )
                if old:
                    return result
                self.check_version(result, etag)
                conn.execute(
                    "INSERT INTO todo_group_settings(group_id,create_policy,version) VALUES(?,?,2) ON CONFLICT(group_id) DO UPDATE SET create_policy=excluded.create_policy,version=version+1",
                    (group_id, data.createPolicy),
                )
                self.key_store(conn, actor.id, key, digest, "group.settings", group_id)
                audit(
                    conn,
                    actor.id,
                    "task.group.settings",
                    group_id,
                    details={"createPolicy": data.createPolicy},
                )
                self.runtime.events.publish(
                    conn,
                    self.runtime.access.recipients(conn, group_id),
                    "task.group.settings.changed",
                    group_id,
                    group_id,
                )
                result = self.group_settings_in(conn, actor.id, group_id)
            return result

    def report(self, actor, task_id, data, key, etag):
        self.runtime.auth.security.rate("task-report", actor.id, 10, 3600)
        with self.runtime.db.write() as conn:
            actor = self.current(conn, actor, enhanced=True)
            row, meta, _, _ = self.task_access(conn, actor.id, task_id)
            if row["deleted_at"] is not None:
                raise unavailable()
            self.write_allowed(conn, actor.id, row["group_id"])
            comment = (
                self.comment_access(conn, actor.id, row, meta, data.commentId)
                if data.commentId
                else None
            )
            old, digest = self.key_lookup(
                conn, actor.id, key, "report:" + task_id, data.model_dump()
            )
            if old:
                result = conn.execute(
                    "SELECT id,status,created_at AS createdAt FROM todo_reports WHERE id=? AND reporter_id=?",
                    (old["result_ref"], actor.id),
                ).fetchone()
                if not result:
                    raise unavailable()
                return dict(result)
            self.check_version(self.view_in(conn, actor.id, task_id), etag)
            existing = conn.execute(
                "SELECT id,status,created_at AS createdAt FROM todo_reports WHERE task_id=? AND reporter_id=? AND status='open' AND comment_id IS ?",
                (task_id, actor.id, data.commentId),
            ).fetchone()
            if existing:
                self.key_store(conn, actor.id, key, digest, "report", existing["id"])
                return dict(existing)
            rid, stamp = identifier("taskreport_"), now_ms()
            snapshot = {"title": row["title"], "scope": row["scope"], "groupId": row["group_id"]}
            snapshot.update(
                {
                    "comment": comment["text"] if comment["removed_at"] is None else "",
                    "commentId": comment["id"],
                }
                if comment
                else {"description": row["description"]}
            )
            conn.execute(
                "INSERT INTO todo_reports(id,task_id,comment_id,reporter_id,category,description,snapshot_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
                (
                    rid,
                    task_id,
                    data.commentId,
                    actor.id,
                    data.category,
                    data.description,
                    canonical(snapshot),
                    stamp,
                ),
            )
            self.key_store(conn, actor.id, key, digest, "report", rid)
            audit(conn, actor.id, "task.report", rid, details={"scope": row["scope"]})
            for admin in conn.execute("SELECT id FROM users WHERE site_role='super_admin' AND status='active'"):
                self.runtime.events.notify(conn, admin[0], "task.report.created", rid)
            return {"id": rid, "status": "open", "createdAt": stamp}
