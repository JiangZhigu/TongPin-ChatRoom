from __future__ import annotations

import json
import secrets

from tongpin.infra.db import Database, now_ms


class JobRepository:
    def __init__(self, database: Database):
        self.db = database
        self.failure_handlers = {}

    def enqueue(self, kind, payload=None, *, entity_id="", dedupe_key=None, run_after=None):
        with self.db.write() as connection:
            return self.enqueue_in_transaction(
                connection,
                kind,
                payload,
                entity_id=entity_id,
                dedupe_key=dedupe_key,
                run_after=run_after,
            )

    def enqueue_in_transaction(
        self, connection, kind, payload=None, *, entity_id="", dedupe_key=None, run_after=None
    ):
        identifier = secrets.token_urlsafe(18)
        connection.execute(
            "INSERT INTO jobs(id,kind,entity_id,dedupe_key,payload_json,status,run_after,created_at) VALUES(?,?,?,?,?,'pending',?,?) ON CONFLICT(dedupe_key) DO NOTHING",
            (
                identifier,
                kind,
                entity_id,
                dedupe_key,
                json.dumps(payload or {}),
                run_after or now_ms(),
                now_ms(),
            ),
        )
        if dedupe_key:
            identifier = connection.execute(
                "SELECT id FROM jobs WHERE dedupe_key=?", (dedupe_key,)
            ).fetchone()[0]
        return identifier

    def claim(self, lease_ms=60000, *, kinds=None, excluded_kinds=()):
        now = now_ms()
        with self.db.write() as connection:
            connection.execute(
                "UPDATE jobs SET status='pending',lease_until=NULL WHERE status='running' AND lease_until<?",
                (now,),
            )
            clauses, parameters = ["status='pending'", "run_after<=?"], [now]
            if kinds is not None:
                if not kinds:
                    return None
                clauses.append("kind IN (" + ",".join("?" for _ in kinds) + ")")
                parameters.extend(kinds)
            if excluded_kinds:
                clauses.append("kind NOT IN (" + ",".join("?" for _ in excluded_kinds) + ")")
                parameters.extend(excluded_kinds)
            row = connection.execute(
                "SELECT * FROM jobs WHERE " + " AND ".join(clauses) + " ORDER BY run_after,created_at LIMIT 1",
                parameters,
            ).fetchone()
            if row is None:
                return None
            connection.execute(
                "UPDATE jobs SET status='running',attempts=attempts+1,lease_until=? WHERE id=?",
                (now + lease_ms, row["id"]),
            )
            result = dict(row)
            result["attempts"] += 1
            result["payload"] = json.loads(row["payload_json"])
            return result

    def complete(self, identifier, result=None):
        with self.db.write() as connection:
            connection.execute(
                "UPDATE jobs SET status='completed',lease_until=NULL,completed_at=?,result_json=? WHERE id=? AND status='running'",
                (now_ms(), json.dumps(result or {}), identifier),
            )

    def fail(self, identifier, code, attempts, retry=True):
        with self.db.write() as connection:
            row = connection.execute(
                "SELECT * FROM jobs WHERE id=? AND status='running'", (identifier,)
            ).fetchone()
            if not row:
                return
            status = "pending" if retry and attempts < 5 else "failed"
            connection.execute(
                "UPDATE jobs SET status=?,lease_until=NULL,run_after=?,last_error_code=?,completed_at=? WHERE id=? AND status='running'",
                (
                    status,
                    now_ms() + min(60000, 1000 * 2**attempts),
                    str(code)[:80],
                    now_ms() if status == "failed" else None,
                    identifier,
                ),
            )
            handler = self.failure_handlers.get(row["kind"])
            if status == "failed" and handler:
                # The job and its domain result become terminal in the same commit.
                handler(connection, row, str(code)[:80])
