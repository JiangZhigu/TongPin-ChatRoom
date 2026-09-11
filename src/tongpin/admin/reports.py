from __future__ import annotations

from tongpin.admin.authz import conflict, identity, page, unavailable
from tongpin.admin.sensitive import paged_sql, query_budget, sensitive_read
from tongpin.contracts.base import APIError
from tongpin.domain.security import audit
from tongpin.infra.db import now_ms


class ReportsAdmin:
    def report_summary(self, conn, row):
        return {
            "id": row["id"],
            "reporter": identity(conn, row["reporter_id"]),
            "targetKind": row["target_kind"],
            "targetId": row["target_id"],
            "category": row["category"],
            "status": row["status"],
            "assignedTo": identity(conn, row["assigned_to"]) if row["assigned_to"] else None,
            "version": row["version"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    def reports_list(self, actor, status="", category="", assigned="all", after="", limit=50):
        if (
            status not in ("", "open", "claimed", "resolved", "rejected")
            or category not in ("", "spam", "harassment", "illegal", "other")
            or assigned not in ("all", "mine", "unassigned")
        ):
            raise APIError("VALIDATION_ERROR", "工单筛选无效。", 422)
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            conditions, args = [], []
            for field, value in (("status", status), ("category", category)):
                if value:
                    conditions.append("r." + field + "=?")
                    args.append(value)
            if assigned == "mine":
                conditions.append("r.assigned_to=?")
                args.append(actor.id)
            elif assigned == "unassigned":
                conditions.append("r.assigned_to IS NULL")
            where = " AND ".join(conditions) or "1=1"
            more_where, more_args = paged_sql(where, args, after, "r")
            with query_budget(conn):
                total = conn.execute(
                    "SELECT COUNT(*) FROM reports r WHERE " + where, args
                ).fetchone()[0]
                rows = conn.execute(
                    "SELECT * FROM reports r WHERE "
                    + more_where
                    + " ORDER BY r.created_at DESC,r.id DESC LIMIT ?",
                    [*more_args, limit + 1],
                ).fetchall()
                return page(
                    rows,
                    total,
                    limit,
                    lambda row: self.report_summary(conn, row),
                    key=lambda row: [row["created_at"], row["id"]],
                )

    def report_read(self, actor, rid, data, request_id=""):
        with sensitive_read(self, actor, "report", rid, data.reason, request_id) as (conn, _):
            row = conn.execute("SELECT * FROM reports WHERE id=?", (rid,)).fetchone()
            if not row:
                raise unavailable()
            target = None
            if row["target_kind"] == "message":
                message = conn.execute(
                    "SELECT * FROM messages WHERE id=?", (row["target_id"],)
                ).fetchone()
                target = self.content_view(conn, message) if message else None
            elif row["target_kind"] == "user":
                target = identity(conn, row["target_id"])
            else:
                group = conn.execute(
                    "SELECT * FROM conversations WHERE id=?", (row["target_id"],)
                ).fetchone()
                target = self.group_view(conn, group) if group else None
            events = conn.execute(
                "SELECT * FROM report_events WHERE report_id=? ORDER BY id DESC LIMIT 100", (rid,)
            ).fetchall()
            return {
                "report": self.report_summary(conn, row)
                | {"description": row["description"], "feedback": row["feedback"]},
                "target": target,
                "events": [
                    {
                        "id": str(item["id"]),
                        "actor": identity(conn, item["actor_id"]),
                        "action": item["action"],
                        "reason": item["reason"],
                        "createdAt": item["created_at"],
                    }
                    for item in reversed(events)
                ],
            }

    def report_disposition(self, conn, row, parameters):
        disposition = parameters.get("disposition")
        if not disposition:
            return None
        action, target = disposition["action"], disposition["targetId"]
        allowed = {(row["target_kind"], row["target_id"])}
        if row["target_kind"] == "message":
            message = conn.execute(
                "SELECT sender_id,conversation_id FROM messages WHERE id=?", (row["target_id"],)
            ).fetchone()
            if message:
                allowed.update(
                    {("user", message["sender_id"]), ("group", message["conversation_id"])}
                )
        kind = (
            "user"
            if action.startswith("user.")
            else "message"
            if action.startswith("message.")
            else "group"
        )
        if (kind, target) not in allowed:
            raise conflict("关联处置对象必须来自本工单的举报对象或消息上下文。")
        extra = {"until": disposition["until"]} if action == "user.mute" else {}
        self.validate_parameters(action, [target], extra)
        snapshot, label, detail = self.inspect_target(conn, action, target, extra)
        return {
            "action": action,
            "targetId": target,
            "parameters": extra,
            "snapshot": snapshot,
            "label": label,
            "detail": detail,
        }

    def inspect_report(self, conn, action, rid, parameters):
        row = conn.execute("SELECT * FROM reports WHERE id=?", (rid,)).fetchone()
        if not row:
            raise unavailable()
        if (
            (action == "report.claim" and row["status"] != "open")
            or (action == "report.reopen" and row["status"] not in ("resolved", "rejected"))
            or (
                action in ("report.resolve", "report.reject")
                and row["status"] not in ("open", "claimed")
            )
        ):
            raise conflict("工单状态已改变，不再符合本次操作条件。")
        snapshot = {"id": rid, "version": row["version"], "status": row["status"]}
        disposition = self.report_disposition(conn, row, parameters)
        if disposition:
            snapshot["disposition"] = disposition
        detail = row["status"] + ("；同时处置 " + disposition["label"] if disposition else "")
        return snapshot, "举报工单 " + rid, detail

    def apply_report(self, conn, command, rid, parameters):
        self.inspect_report(conn, command["action"], rid, parameters)
        row = conn.execute("SELECT * FROM reports WHERE id=?", (rid,)).fetchone()
        disposition = self.report_disposition(conn, row, parameters)
        if disposition:
            linked = dict(command) | {"action": disposition["action"]}
            handler = (
                self.apply_user
                if linked["action"].startswith("user.")
                else self.apply_content
                if linked["action"].startswith("message.")
                else self.apply_group
            )
            handler(conn, linked, disposition["targetId"], disposition["parameters"])
            audit(
                conn,
                command["actor_id"],
                "admin.report.disposition",
                disposition["targetId"],
                reason=command["reason"],
                details={
                    "reportId": rid,
                    "operationId": command["id"],
                    "action": linked["action"],
                    "requestId": command["request_id"],
                },
            )
        state = {
            "report.claim": "claimed",
            "report.reopen": "open",
            "report.resolve": "resolved",
            "report.reject": "rejected",
        }[command["action"]]
        feedback = parameters.get("feedback")
        conn.execute(
            "UPDATE reports SET status=?,assigned_to=?,feedback=?,version=version+1,updated_at=? WHERE id=?",
            (state, None if state == "open" else command["actor_id"], feedback, now_ms(), rid),
        )
        conn.execute(
            "INSERT INTO report_events(report_id,actor_id,action,reason,created_at) VALUES(?,?,?,?,?)",
            (rid, command["actor_id"], command["action"], command["reason"], now_ms()),
        )
        self.runtime.events.publish(conn, [row["reporter_id"]], "reports.updated", rid)
        if state != "claimed":
            self.runtime.events.notify(conn, row["reporter_id"], "report.updated", rid)
        return "工单状态及关联处置已保存。"
