from __future__ import annotations

import logging
import re
import threading
from collections import deque

from tongpin.infra.db import now_ms


class RuntimeLogs(logging.Handler):
    """Bounded metadata-only collection; no request bodies or exception messages."""

    def __init__(self, runtime):
        super().__init__(logging.WARNING)
        self.runtime = runtime
        self.pending = deque(maxlen=512)
        self.guard = threading.Lock()
        self.dropped = 0

    @staticmethod
    def identifier(value):
        return (
            value
            if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_:.-]{1,128}", value)
            else None
        )

    def push(
        self,
        code,
        *,
        level="error",
        route="",
        status=None,
        actor_id=None,
        request_id=None,
        job_id=None,
    ):
        code = (
            code
            if isinstance(code, str) and re.fullmatch(r"[A-Z0-9_.-]{1,80}", code)
            else "SYSTEM_ERROR"
        )
        row = (
            level if level in ("warning", "error") else "error",
            code,
            route[:200],
            status,
            self.identifier(actor_id),
            self.identifier(request_id),
            self.identifier(job_id),
            now_ms(),
        )
        with self.guard:
            if len(self.pending) == self.pending.maxlen:
                self.dropped += 1
            self.pending.append(row)

    def emit(self, record):
        self.push(
            "SYSTEM_ERROR",
            level="error" if record.levelno >= logging.ERROR else "warning",
            request_id=getattr(record, "request_id", None),
            job_id=getattr(record, "job_id", None),
        )

    def persist(self):
        with self.guard:
            rows = list(self.pending)
            self.pending.clear()
            dropped, self.dropped = self.dropped, 0
        if dropped:
            rows.append(("warning", "LOG_BUFFER_LIMIT", "", None, None, None, None, now_ms()))
        try:
            with self.runtime.db.write() as conn:
                if rows:
                    conn.executemany(
                        "INSERT INTO runtime_logs(level,code,route,status,actor_id,request_id,job_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
                        rows,
                    )
                days = self.runtime.policy.get(conn).get("logs_days", 30)
                conn.execute(
                    "DELETE FROM runtime_logs WHERE created_at<?", (now_ms() - days * 86400000,)
                )
                conn.execute(
                    "DELETE FROM runtime_logs WHERE id IN(SELECT id FROM runtime_logs ORDER BY id DESC LIMIT -1 OFFSET 10000)"
                )
        except Exception:
            with self.guard:
                for row in reversed(rows):
                    if len(self.pending) < self.pending.maxlen:
                        self.pending.appendleft(row)
                    else:
                        self.dropped += 1
            raise
