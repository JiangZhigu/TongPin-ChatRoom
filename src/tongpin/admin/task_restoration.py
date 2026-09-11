"""Replay current task privacy and delivery authority onto an isolated old snapshot."""

from tongpin.admin.artifacts import artifact_error
from tongpin.admin.restoration import upsert_row
from tongpin.infra.db import now_ms


def replay_tasks(clone, conn, source, check):
    tables = {r[0] for r in source.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "todo_tasks" not in tables:
        if conn.execute("SELECT 1 FROM todo_tasks LIMIT 1").fetchone():
            raise artifact_error("当前权限来源缺少待办权限状态。", "RESTORE_AUTHORITY_INCOMPLETE")
        return {"tasksRestricted": 0, "taskReportsCurrent": 0}
    result = {"tasksRestricted": 0, "taskReportsCurrent": 0}
    # Report snapshots are authority data. Never resurrect expired or closed-old holds.
    conn.execute("DELETE FROM todo_reports")
    for old in conn.execute("SELECT * FROM todo_tasks").fetchall():
        check()
        current = source.execute("SELECT * FROM todo_tasks WHERE id=?", (old["id"],)).fetchone()
        if not current:
            conn.execute("DELETE FROM todo_tasks WHERE id=?", (old["id"],))
            result["tasksRestricted"] += 1
            continue
        # Preserve backed-up text, but use current assignment, completion and due
        # generation so recovery cannot redispatch a completed or reassigned task.
        fields = [
            "assignee_id",
            "status",
            "completed_at",
            "completed_by",
            "deleted_at",
            "moderated_deleted",
            "report_only",
            "due_on",
            "due_timezone",
            "due_start",
            "due_end",
            "schedule_revision",
        ]
        conn.execute(
            "UPDATE todo_tasks SET "
            + ",".join(f + "=?" for f in fields)
            + ",version=MAX(version,?)+1 WHERE id=?",
            [*[current[f] for f in fields], current["version"], old["id"]],
        )
        result["tasksRestricted"] += 1
    for report in source.execute(
        "SELECT * FROM todo_reports WHERE status='open' OR closed_at>?", (now_ms() - 30 * 86400000,)
    ):
        check()
        if not conn.execute("SELECT 1 FROM todo_tasks WHERE id=?", (report["task_id"],)).fetchone():
            current = source.execute(
                "SELECT * FROM todo_tasks WHERE id=?", (report["task_id"],)
            ).fetchone()
            if (
                not current
                or current["group_id"]
                and not conn.execute(
                    "SELECT 1 FROM conversations WHERE id=?", (current["group_id"],)
                ).fetchone()
            ):
                raise artifact_error(
                    "当前举报关联的新群不在快照中，不能丢弃保留材料后完成恢复。",
                    "RESTORE_TASK_HOLD_INCOMPLETE",
                )
            # A new held object is retained only as a tombstone for the reported
            # material; unrelated post-backup content is not introduced to users.
            row = dict(current)
            row.update(
                title="举报保留对象",
                description="",
                source_message_id=None,
                list_id=None,
                deleted_at=row["deleted_at"] or now_ms(),
                moderated_deleted=1,
                report_only=1,
            )
            upsert_row(conn, "todo_tasks", row)
        upsert_row(conn, "todo_reports", dict(report))
        result["taskReportsCurrent"] += 1
    for row in conn.execute("SELECT * FROM todo_comments").fetchall():
        check()
        current = source.execute(
            "SELECT removed_at FROM todo_comments WHERE id=? AND task_id=?",
            (row["id"], row["task_id"]),
        ).fetchone()
        if not current or current["removed_at"] is not None:
            conn.execute(
                "UPDATE todo_comments SET removed_at=?,text='' WHERE id=?",
                (current[0] if current else now_ms(), row["id"]),
            )
    # The current period's watermark can exceed a snapshot's sequence. Advance
    # sequence generators too, otherwise new comments would stay below that floor.
    for table in ("todo_activities", "todo_comments"):
        current = source.execute(
            "SELECT seq FROM sqlite_sequence WHERE name=?", (table,)
        ).fetchone()
        if current:
            found = conn.execute(
                "SELECT seq FROM sqlite_sequence WHERE name=?", (table,)
            ).fetchone()
            if found:
                conn.execute(
                    "UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name=?", (current[0], table)
                )
            else:
                conn.execute(
                    "INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)", (table, current[0])
                )
    conn.execute("DELETE FROM todo_membership_watermarks")
    for row in source.execute("SELECT * FROM todo_membership_watermarks"):
        check()
        if conn.execute("SELECT 1 FROM memberships WHERE id=?", (row["period_id"],)).fetchone():
            upsert_row(conn, "todo_membership_watermarks", dict(row), ("period_id",))
    for row in conn.execute(
        "SELECT id FROM memberships WHERE left_at IS NULL AND id NOT IN(SELECT period_id FROM todo_membership_watermarks)"
    ).fetchall():
        clone.tasks.member_joined(conn, row[0])
    # Personal organization and delivery receipts are current privacy choices.
    lists = {
        r["id"]: r["list_id"]
        for r in conn.execute("SELECT id,list_id FROM todo_tasks WHERE list_id IS NOT NULL")
    }
    for table, keys in (
        ("todo_labels", ("id",)),
        ("todo_preferences", ("user_id",)),
        ("todo_mutation_keys", ("user_id", "key")),
        ("todo_group_settings", ("group_id",)),
        ("todo_marks", ("task_id", "user_id")),
        ("todo_reminders", ("task_id", "user_id")),
        (
            "todo_reminder_receipts",
            ("task_id", "user_id", "schedule_revision", "preference_version"),
        ),
    ):
        conn.execute("DELETE FROM " + table)
        for row in source.execute("SELECT * FROM " + table):
            check()
            data = dict(row)
            if (
                "task_id" in data
                and not conn.execute(
                    "SELECT 1 FROM todo_tasks WHERE id=?", (data["task_id"],)
                ).fetchone()
            ):
                continue
            if (
                "group_id" in data
                and not conn.execute(
                    "SELECT 1 FROM conversations WHERE id=?", (data["group_id"],)
                ).fetchone()
            ):
                continue
            upsert_row(conn, table, data, keys)
    for tid, lid in lists.items():
        if conn.execute("SELECT 1 FROM todo_labels WHERE id=?", (lid,)).fetchone():
            conn.execute("UPDATE todo_tasks SET list_id=? WHERE id=?", (lid, tid))
    for row in source.execute("SELECT * FROM todo_task_tags"):
        if conn.execute("SELECT 1 FROM todo_tasks WHERE id=?", (row["task_id"],)).fetchone():
            conn.execute(
                "INSERT OR IGNORE INTO todo_task_tags VALUES(?,?)",
                (row["task_id"], row["label_id"]),
            )
    # An old backup has no authority to undo current departure or account cleanup.
    for row in conn.execute(
        "SELECT DISTINCT group_id,assignee_id FROM todo_tasks WHERE scope='group' AND status<>'done' AND assignee_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.conversation_id=group_id AND m.user_id=assignee_id AND m.left_at IS NULL AND u.status='active')"
    ).fetchall():
        clone.tasks.member_left(conn, row["group_id"], row["assignee_id"])
    for table in ("todo_marks", "todo_reminders"):
        conn.execute(
            "DELETE FROM "
            + table
            + " WHERE task_id IN(SELECT id FROM todo_tasks WHERE scope='group' AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.conversation_id=todo_tasks.group_id AND m.user_id="
            + table
            + ".user_id AND m.left_at IS NULL))"
        )
    return result


def rebuild_reminders(clone, conn, check):
    # Cancelled old job dedupe keys must not suppress the replacement jobs. Keep
    # current receipts so a previously delivered generation cannot deliver twice.
    conn.execute("UPDATE jobs SET dedupe_key=NULL WHERE kind='tasks.remind'")
    for row in conn.execute(
        "SELECT * FROM todo_tasks WHERE due_on IS NOT NULL AND status<>'done' AND deleted_at IS NULL"
    ).fetchall():
        check()
        clone.tasks.schedule_reminders(conn, row)
