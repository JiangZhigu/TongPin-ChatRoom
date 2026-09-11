from __future__ import annotations

import json
import secrets

from tongpin.infra.db import Database, now_ms


class JobRepository:
    def __init__(self, database: Database):
        self.db = database

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

    def claim(self, lease_ms=60000):
        now = now_ms()
        with self.db.write() as connection:
            connection.execute(
                "UPDATE jobs SET status='pending',lease_until=NULL WHERE status='running' AND lease_until<?",
                (now,),
            )
            row = connection.execute(
                "SELECT * FROM jobs WHERE status='pending' AND run_after<=? ORDER BY run_after,created_at LIMIT 1",
                (now,),
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
            connection.execute(
                "UPDATE jobs SET status=?,lease_until=NULL,run_after=?,last_error_code=? WHERE id=? AND status='running'",
                (
                    "pending" if retry and attempts < 5 else "failed",
                    now_ms() + min(60000, 1000 * 2**attempts),
                    str(code)[:80],
                    identifier,
                ),
            )
