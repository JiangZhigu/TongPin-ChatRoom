from __future__ import annotations

import hashlib
import sqlite3
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def sql_statements(source: str) -> list[str]:
    statements, current = [], ""
    for line in source.splitlines(keepends=True):
        current += line
        if sqlite3.complete_statement(current):
            statements.append(current)
            current = ""
    if current.strip() and not all(
        line.strip().startswith("--") for line in current.splitlines() if line.strip()
    ):
        raise ValueError("Incomplete SQL migration")
    return statements


class Database:
    def __init__(self, path: Path, migrations: Path | None = None):
        self.path = path
        self.migrations = migrations or Path(__file__).resolve().parents[1] / "migrations"
        self._writer = threading.RLock()
        self.metrics = None

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            self.path, timeout=5, isolation_level=None, check_same_thread=True
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=5000")
        connection.execute("PRAGMA synchronous=FULL")
        return connection

    @contextmanager
    def read(self) -> Iterator[sqlite3.Connection]:
        connection = self.connect()
        try:
            connection.execute("BEGIN")
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    @contextmanager
    def write(self) -> Iterator[sqlite3.Connection]:
        started = time.perf_counter()
        with self._writer:
            connection = self.connect()
            wait_ms, failed = None, False
            try:
                connection.execute("BEGIN IMMEDIATE")
                wait_ms = (time.perf_counter() - started) * 1000
                yield connection
                connection.commit()
            except sqlite3.Error:
                failed = True
                connection.rollback()
                raise
            except BaseException:
                connection.rollback()
                raise
            finally:
                connection.close()
                if self.metrics:
                    self.metrics.database_write(wait_ms if wait_ms is not None else (time.perf_counter() - started) * 1000, failed)

    def migrate(self) -> list[int]:
        with self._writer:
            connection = self.connect()
            try:
                mode = connection.execute("PRAGMA journal_mode=WAL").fetchone()[0]
                if mode != "wal":
                    raise RuntimeError("SQLite WAL is required")
                connection.execute(
                    "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, checksum TEXT NOT NULL)"
                )
            finally:
                connection.close()
            files = sorted(self.migrations.glob("[0-9]*.sql"))
            known = {int(path.name.split("_", 1)[0]): path for path in files}
            with self.read() as connection:
                recorded = {
                    row["version"]: row["checksum"]
                    for row in connection.execute("SELECT version,checksum FROM schema_migrations")
                }
            if set(recorded) - set(known):
                raise RuntimeError("Database requires a newer application version")
            applied = []
            for version, path in known.items():
                contents = path.read_bytes()
                digest = hashlib.sha256(contents).hexdigest()
                if version in recorded:
                    if recorded[version] != digest:
                        raise RuntimeError(
                            f"Migration {version} checksum mismatch; existing migrations are immutable"
                        )
                    continue
                with self.write() as connection:
                    for statement in sql_statements(contents.decode("utf-8")):
                        connection.execute(statement)
                    connection.execute(
                        "INSERT INTO schema_migrations VALUES(?,?,?)", (version, now_ms(), digest)
                    )
                applied.append(version)
            return applied

    def health(self) -> dict:
        with self.write() as connection:
            connection.execute("CREATE TEMP TABLE IF NOT EXISTS ready_probe(value INTEGER)")
            connection.execute("INSERT INTO ready_probe VALUES(1)")
            version = connection.execute(
                "SELECT COALESCE(MAX(version),0) FROM schema_migrations"
            ).fetchone()[0]
            return {"schemaVersion": version, "sqliteVersion": sqlite3.sqlite_version}

    def backup(self, destination: Path) -> None:
        if destination.exists():
            raise FileExistsError("Backup destination already exists")
        source = self.connect()
        target = sqlite3.connect(destination)
        try:
            source.backup(target, pages=256)
            result = target.execute("PRAGMA integrity_check").fetchone()[0]
            if result != "ok" or target.execute("PRAGMA foreign_key_check").fetchall():
                raise RuntimeError("Backup integrity check failed")
        finally:
            target.close()
            source.close()
