from tongpin.infra.db import now_ms

DAY = 86400000


class TaskRetention:
    def purge_account_in(self, conn, user_id):
        # Report holds remain explicit; unrelated private tasks disappear atomically.
        conn.execute(
            "DELETE FROM todo_tasks WHERE owner_id=? AND NOT EXISTS(SELECT 1 FROM todo_reports r WHERE r.task_id=todo_tasks.id)",
            (user_id,),
        )
        for table in ("todo_preferences", "todo_labels", "todo_marks", "todo_reminders"):
            conn.execute("DELETE FROM " + table + " WHERE user_id=?", (user_id,))

    def member_joined(self, conn, period_id):
        activity = conn.execute(
            "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='todo_activities'),0)"
        ).fetchone()[0]
        comment = conn.execute(
            "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='todo_comments'),0)"
        ).fetchone()[0]
        conn.execute(
            "INSERT INTO todo_membership_watermarks(period_id,activity_floor,comment_floor) VALUES(?,?,?)",
            (period_id, activity, comment),
        )

    def member_left(self, conn, group_id, user_id):
        stamp = now_ms()
        conn.execute(
            "INSERT INTO todo_activities(task_id,actor_id,kind,created_at) SELECT id,NULL,'member_left',? FROM todo_tasks WHERE group_id=? AND assignee_id=? AND status<>'done'",
            (stamp, group_id, user_id),
        )
        conn.execute(
            "UPDATE todo_tasks SET assignee_id=NULL,version=version+1,schedule_revision=schedule_revision+1,updated_at=? WHERE group_id=? AND assignee_id=? AND status<>'done'",
            (stamp, group_id, user_id),
        )
        conn.execute(
            "UPDATE todo_reminders SET rule='none',version=version+1 WHERE user_id=? AND task_id IN(SELECT id FROM todo_tasks WHERE group_id=?)",
            (user_id, group_id),
        )
        conn.execute(
            "DELETE FROM todo_marks WHERE user_id=? AND task_id IN(SELECT id FROM todo_tasks WHERE group_id=?)",
            (user_id, group_id),
        )
        self.runtime.events.publish(
            conn,
            self.runtime.access.recipients(conn, group_id),
            "task.group.updated",
            group_id,
            group_id,
        )

    def cleanup_in(self, conn, stamp):
        # Open reports hold their object; closed reports have a further 30 day window.
        reports = conn.execute(
            "DELETE FROM todo_reports WHERE id IN(SELECT id FROM todo_reports WHERE status='closed' AND closed_at<=? ORDER BY closed_at,id LIMIT 100)",
            (stamp - 30 * DAY,),
        ).rowcount
        rows = conn.execute(
            "SELECT t.* FROM todo_tasks t LEFT JOIN conversations c ON c.id=t.group_id LEFT JOIN users u ON u.id=t.owner_id WHERE ((t.deleted_at IS NOT NULL AND t.deleted_at<=?) OR (c.status='dissolved' AND c.dissolved_at<=?) OR (t.scope='personal' AND u.status='deleted')) AND NOT EXISTS(SELECT 1 FROM todo_reports r WHERE r.task_id=t.id) ORDER BY t.updated_at,t.id LIMIT 100",
            (stamp - 30 * DAY, stamp - 30 * DAY),
        ).fetchall()
        for row in rows:
            self.runtime.events.publish(
                conn, self.audience(conn, row), "task.deleted", row["id"], row["group_id"]
            )
            conn.execute("DELETE FROM todo_tasks WHERE id=?", (row["id"],))
        keys = conn.execute(
            "DELETE FROM todo_mutation_keys WHERE rowid IN(SELECT rowid FROM todo_mutation_keys WHERE created_at<? ORDER BY created_at LIMIT 1000)",
            (stamp - 30 * DAY,),
        ).rowcount
        for table in ("todo_preferences", "todo_labels", "todo_marks", "todo_reminders"):
            conn.execute(
                f"DELETE FROM {table} WHERE user_id IN(SELECT id FROM users WHERE status='deleted')"
            )
        return {"tasksPurged": len(rows), "taskReportsPurged": reports, "taskKeysPurged": keys}
