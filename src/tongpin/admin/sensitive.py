from __future__ import annotations

import sqlite3
import time
from contextlib import contextmanager

from tongpin.admin.authz import cursor
from tongpin.contracts.base import APIError
from tongpin.domain.security import audit


@contextmanager
def query_budget(conn):
    deadline = time.perf_counter() + 0.25
    steps = 0

    def stop():
        nonlocal steps
        steps += 5000
        return steps > 2000000 or time.perf_counter() > deadline

    conn.set_progress_handler(stop, 5000)
    try:
        yield
    except sqlite3.OperationalError as error:
        if getattr(error, "sqlite_errorcode", None) == sqlite3.SQLITE_INTERRUPT:
            raise APIError(
                "QUERY_TOO_BROAD", "查询范围过大，请增加账号、会话或时间筛选。", 422
            ) from error
        raise
    finally:
        conn.set_progress_handler(None, 0)


@contextmanager
def sensitive_read(service, actor, action, subject, reason, request_id=""):
    service.runtime.auth.security.rate("admin-sensitive-read", actor.id, 120, 60)
    details = {"requestId": request_id}
    try:
        with service.runtime.db.write() as conn:
            service.runtime.auth.current_in_transaction(conn, actor, admin=True)
            yield conn, details
            audit(conn, actor.id, "admin.read." + action, subject, reason=reason, details=details)
    except APIError as error:
        # A failed read still leaves a receipt, but never records content or credentials.
        with service.runtime.db.write() as conn:
            service.runtime.auth.current_in_transaction(conn, actor, admin=True)
            audit(
                conn,
                actor.id,
                "admin.read." + action,
                subject,
                reason=reason,
                result="failed",
                details={"requestId": request_id, "code": error.code},
            )
        raise


def search_terms(data, alias):
    conditions, values = [], []
    if data.conversationId:
        conditions.append(f"{alias}.conversation_id=?")
        values.append(data.conversationId)
    if data.fromAt is not None:
        conditions.append(f"{alias}.created_at>=?")
        values.append(data.fromAt)
    if data.until is not None:
        conditions.append(f"{alias}.created_at<=?")
        values.append(data.until)
    return conditions, values


def paged_sql(where, values, after, alias):
    boundary = cursor(after, 2)
    if boundary:
        if type(boundary[0]) is not int or type(boundary[1]) is not str:
            raise APIError("VALIDATION_ERROR", "分页位置无效。", 422)
        where += f" AND ({alias}.created_at,{alias}.id)<(?,?)"
        values = [*values, *boundary]
    return where, values


def like_query(value):
    return "%" + value.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%"
