from __future__ import annotations

import json

from tongpin.admin.authz import cursor, identity, page
from tongpin.admin.sensitive import query_budget
from tongpin.contracts.base import APIError


def safe_details(value, depth=0):
    if depth > 5:
        return "[层级已截断]"
    if isinstance(value, dict):
        return {
            key: safe_details(item, depth + 1)
            for key, item in list(value.items())[:100]
            if not any(
                part in key.lower()
                for part in ("password", "secret", "token", "cookie", "recovery", "ciphertext")
            )
            and key.lower() not in ("body", "text", "query", "digest")
        }
    if isinstance(value, list):
        return [safe_details(item, depth + 1) for item in value[:100]]
    if isinstance(value, str):
        return value[:2000]
    return value


def time_filters(data, prefix=""):
    conditions, args = [], []
    if data.fromAt is not None:
        conditions.append(prefix + "created_at>=?")
        args.append(data.fromAt)
    if data.until is not None:
        conditions.append(prefix + "created_at<=?")
        args.append(data.until)
    return conditions, args


def audit_filters(data):
    conditions, args = time_filters(data)
    for key, column in (
        ("actorId", "actor_id"),
        ("subjectId", "subject_id"),
        ("action", "action"),
        ("result", "result"),
        ("requestId", "json_extract(details,'$.requestId')"),
        ("jobId", "json_extract(details,'$.jobId')"),
    ):
        value = getattr(data, key)
        if value:
            conditions.append(column + "=?")
            args.append(value)
    return conditions, args


def id_boundary(after):
    parsed = cursor(after)
    if not parsed:
        return None
    try:
        value = int(parsed[0])
        if not 0 <= value <= 2**63 - 1:
            raise ValueError
        return value
    except (ValueError, TypeError) as error:
        raise APIError("VALIDATION_ERROR", "分页位置无效。", 422) from error


class AuditAdmin:
    @staticmethod
    def audit_view(conn, row):
        details = safe_details(json.loads(row["details"]))
        return {
            "id": str(row["id"]),
            "actor": identity(conn, row["actor_id"]) if row["actor_id"] else None,
            "subjectId": row["subject_id"],
            "action": row["action"],
            "reason": row["reason"],
            "result": row["result"],
            "device": row["device"],
            "details": details,
            "createdAt": row["created_at"],
            "requestId": details.get("requestId"),
            "jobId": details.get("jobId"),
        }

    def audit_events(self, actor, data, *, after="", limit=50):
        boundary = id_boundary(after)
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            conditions, args = audit_filters(data)
            with query_budget(conn):
                total = conn.execute(
                    "SELECT COUNT(*) FROM audit_events WHERE "
                    + (" AND ".join(conditions) or "1=1"),
                    args,
                ).fetchone()[0]
                if boundary is not None:
                    conditions.append("id<?")
                    args.append(boundary)
                rows = conn.execute(
                    "SELECT * FROM audit_events WHERE "
                    + (" AND ".join(conditions) or "1=1")
                    + " ORDER BY id DESC LIMIT ?",
                    [*args, limit + 1],
                ).fetchall()
                return page(
                    rows,
                    total,
                    limit,
                    lambda row: self.audit_view(conn, row),
                    key=lambda row: [str(row["id"])],
                )

    @staticmethod
    def log_view(row):
        return {
            "id": str(row["id"]),
            "level": row["level"],
            "code": row["code"],
            "route": row["route"],
            "status": row["status"],
            "actorId": row["actor_id"],
            "requestId": row["request_id"],
            "jobId": row["job_id"],
            "createdAt": row["created_at"],
        }

    def runtime_log_events(self, actor, data, *, after="", limit=50):
        boundary = id_boundary(after)
        self.runtime.logs.persist()
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            conditions, args = time_filters(data)
            for name, column in (
                ("level", "level"),
                ("requestId", "request_id"),
                ("jobId", "job_id"),
            ):
                value = getattr(data, name)
                if value:
                    conditions.append(column + "=?")
                    args.append(value)
            total = conn.execute(
                "SELECT COUNT(*) FROM runtime_logs WHERE " + (" AND ".join(conditions) or "1=1"),
                args,
            ).fetchone()[0]
            if boundary is not None:
                conditions.append("id<?")
                args.append(boundary)
            rows = conn.execute(
                "SELECT * FROM runtime_logs WHERE "
                + (" AND ".join(conditions) or "1=1")
                + " ORDER BY id DESC LIMIT ?",
                [*args, limit + 1],
            ).fetchall()
            return page(rows, total, limit, self.log_view, key=lambda row: [str(row["id"])])
