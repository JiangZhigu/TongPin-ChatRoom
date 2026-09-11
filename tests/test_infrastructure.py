from __future__ import annotations

import concurrent.futures
import sqlite3
import threading
import time

import pytest

from tongpin.config import Settings
from tongpin.infra.cache import BoundedCache
from tongpin.infra.db import Database
from tongpin.infra.paths import DataPaths
from tongpin.infra.runtime_lock import RuntimeLock
from tongpin.jobs.repository import JobRepository


def test_migrations_are_idempotent_and_persistent(database):
    assert database.migrate() == []
    with database.write() as connection:
        connection.execute("INSERT INTO instance_metadata VALUES('proof','persisted')")
        assert connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert connection.execute("PRAGMA synchronous").fetchone()[0] == 2
        assert connection.execute("PRAGMA busy_timeout").fetchone()[0] == 5000
    other = Database(database.path)
    with other.read() as connection:
        assert (
            connection.execute("SELECT value FROM instance_metadata WHERE key='proof'").fetchone()[
                0
            ]
            == "persisted"
        )


def test_write_transaction_rolls_back(database):
    with pytest.raises(RuntimeError), database.write() as connection:
        connection.execute("INSERT INTO instance_metadata VALUES('failed','not-saved')")
        raise RuntimeError("synthetic failure")
    with database.read() as connection:
        assert (
            connection.execute("SELECT * FROM instance_metadata WHERE key='failed'").fetchone()
            is None
        )


def test_migration_failure_rolls_back_and_checksum_is_immutable(tmp_path):
    migrations = tmp_path / "migrations"
    migrations.mkdir()
    first = migrations / "0001_test.sql"
    first.write_text("CREATE TABLE first_table(value TEXT);\n", encoding="utf-8")
    db = Database(tmp_path / "db.sqlite3", migrations)
    assert db.migrate() == [1]
    (migrations / "0002_bad.sql").write_text(
        "CREATE TABLE rollback_table(value TEXT);\nINVALID SQL;\n", encoding="utf-8"
    )
    with pytest.raises(sqlite3.OperationalError):
        db.migrate()
    with db.read() as connection:
        assert (
            connection.execute(
                "SELECT name FROM sqlite_master WHERE name='rollback_table'"
            ).fetchone()
            is None
        )
        assert connection.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0] == 1
    first.write_text("CREATE TABLE altered_table(value TEXT);\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="checksum"):
        db.migrate()


def test_cache_ttl_capacity_copy_and_singleflight():
    clock = [0.0]
    cache = BoundedCache(max_entries=2, max_bytes=60, ttl=2, clock=lambda: clock[0])
    cache.set("a", {"x": "one"})
    value = cache.get("a")
    value["x"] = "changed"
    assert cache.get("a")["x"] == "one"
    cache.set("b", "two")
    cache.set("c", "three")
    assert cache.stats()["entries"] == 2
    assert cache.stats()["bytes"] <= 60
    assert not cache.set("huge", "x" * 70)
    clock[0] = 3
    assert cache.get("c") is None
    counter = [0]
    lock = threading.Lock()

    def load():
        with lock:
            counter[0] += 1
        time.sleep(0.05)
        return {"value": 42}

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
        values = list(pool.map(lambda _: cache.get_or_load("new", load), range(10)))
    assert counter[0] == 1
    assert all(value["value"] == 42 for value in values)


def test_job_dedupe_and_lease_recovery(database):
    jobs = JobRepository(database)
    identifier = jobs.enqueue("test", {"x": 1}, dedupe_key="same")
    assert jobs.enqueue("test", dedupe_key="same") == identifier
    first = jobs.claim(lease_ms=-1)
    assert first["id"] == identifier
    assert jobs.claim()["attempts"] == 2
    assert jobs.claim() is None
    jobs.complete(identifier, {"done": True})
    with database.read() as connection:
        assert (
            connection.execute("SELECT status FROM jobs WHERE id=?", (identifier,)).fetchone()[0]
            == "completed"
        )


def test_private_paths_and_single_instance_lock(tmp_path):
    paths = DataPaths(tmp_path / "private")
    paths.prepare()
    assert paths.development_secret() == paths.development_secret()
    with pytest.raises(ValueError):
        paths.private_file(paths.uploads, "../outside")
    first = RuntimeLock(paths.lock_file)
    second = RuntimeLock(paths.lock_file)
    first.acquire()
    try:
        with pytest.raises(RuntimeError, match="another Tongpin"):
            second.acquire()
    finally:
        first.release()
    second.acquire()
    second.release()


def test_backup_is_consistent_and_destination_never_overwritten(database, tmp_path):
    with database.write() as connection:
        connection.execute("INSERT INTO instance_metadata VALUES('original','record')")
    target = tmp_path / "backup.sqlite3"
    database.backup(target)
    with sqlite3.connect(target) as connection:
        assert (
            connection.execute(
                "SELECT value FROM instance_metadata WHERE key='original'"
            ).fetchone()[0]
            == "record"
        )
    with pytest.raises(FileExistsError):
        database.backup(target)


def test_production_configuration_requires_real_secret_and_https(tmp_path):
    with pytest.raises(ValueError, match="HTTPS"):
        Settings(data_root=tmp_path / "data", environment="production").validate()
    with pytest.raises(ValueError, match="secret"):
        Settings(
            data_root=tmp_path / "data",
            environment="production",
            origins=("https://chat.example.test",),
        ).validate()
    with pytest.raises(ValueError, match="loopback"):
        Settings(data_root=tmp_path / "data", host="0.0.0.0").validate()
