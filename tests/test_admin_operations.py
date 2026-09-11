from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
import uuid
import zipfile

import httpx
import pytest
import pytest_asyncio
from test_admin import ORIGIN, PASSWORD, execute, fails, preview
from test_admin import admin_app as admin_app  # noqa: PLC0414
from test_admin_s2 import message
from test_files import direct, image_bytes, upload

from tongpin.admin.artifacts import read_verified_manifest
from tongpin.admin.authz import compact
from tongpin.admin.restoration import apply_current_authority
from tongpin.contracts.admin_s3 import OperationDownload
from tongpin.contracts.auth import ReauthInput
from tongpin.domain.security import audit
from tongpin.infra.db import now_ms

pytestmark = pytest.mark.asyncio
REASON = "隔离运维功能的真实产物与权限核验"


@pytest_asyncio.fixture
async def ops_app(admin_app):
    admin_app[0].runtime._stopping.clear()
    yield admin_app
    admin_app[0].runtime._stopping.set()


def run_operation(rt):
    job = rt.operation_runner.claim()
    assert job
    result = rt.admin.process_operation(job)
    rt.jobs.complete(job["id"], result)
    return result


def export_parameters(**changes):
    return {
        "kind": "content",
        "filters": {},
        "maxRows": 20,
        "maxBytes": 1024 * 1024,
        "includeFiles": True,
    } | changes


def artifact_path(rt, oid):
    with rt.db.read() as conn:
        return rt.admin.operation_path(rt.admin.operation_row(conn, oid))


async def test_export_real_records_files_budget_current_content_and_http_download(ops_app):
    app, actors, tokens, _, _ = ops_app
    rt, owner, peer = app.runtime, actors[2], actors[3]
    conversation = direct(rt, owner, peer)
    data = image_bytes()
    image = upload(rt, owner, conversation, data, "隔离导出.png")
    sent = message(rt, owner, conversation, attachmentIds=[image["id"]])
    parameters = export_parameters(
        filters={"conversationId": conversation["id"], "senderId": owner.id}
    )
    receipt, command, _ = execute(ops_app, "export.create", ["instance"], parameters)
    assert receipt["status"] == "completed"
    assert rt.admin.operation(actors[0], command.operationId)["status"] == "queued"
    assert run_operation(rt)["status"] == "completed"
    view = rt.admin.operation(actors[0], command.operationId)
    path = artifact_path(rt, command.operationId)
    assert view["canDownload"] and view["bytes"] == path.stat().st_size
    assert view["sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()
    with zipfile.ZipFile(path) as archive:
        records = [json.loads(line) for line in archive.read("records.jsonl").splitlines()]
        assert len(records) == 1 and records[0]["id"] == sent["id"]
        assert records[0]["text"] == sent["text"]
        assert "expected_sha256" not in json.dumps(records)
        assert any(
            archive.read(name) == data for name in archive.namelist() if name.startswith("files/")
        )
    assert not (path.parent / "records.jsonl").exists()
    fails(
        "ARTIFACT_UNAVAILABLE",
        lambda: rt.admin.operation_download(
            actors[1], command.operationId, OperationDownload(reason=REASON)
        ),
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=ORIGIN, headers={"Origin": ORIGIN}
    ) as client:
        client.cookies.set(rt.auth.cookie_name, tokens[0])
        client.headers["X-CSRF-Token"] = rt.auth.security.csrf(tokens[0])
        response = await client.post(
            "/api/v1/admin/operations/" + command.operationId + "/download", json={"reason": REASON}
        )
        assert response.status_code == 200, response.text
        assert (
            response.content == path.read_bytes()
            and "no-store" in response.headers["cache-control"]
        )
        assert (await client.get("/api/v1/admin/jobs?kind=admin.operation")).json()["data"][
            "total"
        ] == 1
        assert (await client.get("/api/v1/admin/operations?status=completed")).json()["data"][
            "total"
        ] == 1
    execute(ops_app, "message.hide", [sent["id"]])
    fails(
        "EXPORT_CHANGED",
        lambda: rt.admin.operation_download(
            actors[0], command.operationId, OperationDownload(reason=REASON)
        ),
    )
    fails(
        "EXPORT_LIMIT",
        lambda: preview(
            rt, actors[0], "export.create", ["instance"], export_parameters(maxBytes=1024)
        ),
    )
    fails(
        "VALIDATION_ERROR",
        lambda: preview(
            rt,
            actors[0],
            "export.create",
            ["instance"],
            export_parameters(kind="files", filters={"status": "ready"}),
        ),
    )


async def test_backup_manifest_verify_drill_current_authority_and_private_download(ops_app):
    rt, actors = ops_app[0].runtime, ops_app[1]
    conversation = direct(rt, actors[2], actors[3])
    image = upload(rt, actors[2], conversation, image_bytes(), "备份图.png")
    sent = message(rt, actors[2], conversation, attachmentIds=[image["id"]])
    _, command, _ = execute(ops_app, "backup.create", ["instance"])
    assert run_operation(rt)["status"] == "completed"
    path = artifact_path(rt, command.operationId)
    view = rt.admin.operation(actors[0], command.operationId)
    manifest = read_verified_manifest(rt, path, view["sha256"], lambda: None)
    assert manifest["instanceId"] and manifest["checks"]["integrity"] == "ok"
    assert view["result"]["checks"]["filesVerified"] >= 2
    assert "development.key" not in [row["name"] for row in manifest["files"]]
    fails(
        "REAUTH_REQUIRED",
        lambda: rt.admin.operation_download(
            actors[0], command.operationId, OperationDownload(reason=REASON)
        ),
    )
    token = rt.auth.reauth(
        actors[0],
        ReauthInput(
            action="backup.download:" + command.operationId,
            password=PASSWORD,
            secondFactor=ops_app[3][0].pop(),
        ),
    )["reauthToken"]
    assert (
        rt.admin.operation_download(
            actors[0], command.operationId, OperationDownload(reason=REASON, reauthToken=token)
        )[0]
        == path
    )
    fails(
        "REAUTH_REQUIRED",
        lambda: rt.admin.operation_download(
            actors[0], command.operationId, OperationDownload(reason=REASON, reauthToken=token)
        ),
    )
    _, verification, _ = execute(ops_app, "backup.verify", [command.operationId])
    assert run_operation(rt)["status"] == "completed"
    assert (
        rt.admin.operation(actors[0], verification.operationId)["result"]["checks"]["integrity"]
        == "ok"
    )
    execute(ops_app, "user.ban", [actors[3].id])
    execute(ops_app, "message.delete", [sent["id"]])
    _, drill, _ = execute(ops_app, "backup.drill", [command.operationId])
    result = run_operation(rt)
    assert result["status"] == "completed", result
    restored = (
        rt.paths.exports
        / ("op-" + drill.operationId)
        / "restored-instance"
        / "data"
        / "tongpin.sqlite3"
    )
    with sqlite3.connect(restored) as conn:
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert not conn.execute("PRAGMA foreign_key_check").fetchall()
        assert (
            conn.execute("SELECT status FROM users WHERE id=?", (actors[3].id,)).fetchone()[0]
            == "banned"
        )
        assert (
            conn.execute("SELECT status FROM messages WHERE id=?", (sent["id"],)).fetchone()[0]
            != "sent"
        )
        assert (
            conn.execute("SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL").fetchone()[0]
            == 0
        )
        current_codes = {
            row[0]: row[1] for row in conn.execute("SELECT id,consumed_at FROM recovery_codes")
        }
    with rt.db.read() as conn:
        assert current_codes == {
            row[0]: row[1] for row in conn.execute("SELECT id,consumed_at FROM recovery_codes")
        }
        assert (
            conn.execute(
                "SELECT value FROM instance_metadata WHERE key='backup_active'"
            ).fetchone()[0]
            == "0"
        )
    result = rt.admin.operation(actors[0], drill.operationId)["result"]["restore"]
    assert result["isolatedOnly"] and result["activationAllowed"] is False


async def test_operation_cancellation_revocation_failed_retry_and_source_tamper(ops_app):
    rt, actors = ops_app[0].runtime, ops_app[1]
    _, first, _ = execute(ops_app, "backup.create", ["instance"])
    execute(ops_app, "operation.cancel", [first.operationId])
    result = run_operation(rt)
    assert result["status"] == "cancelled" and result["code"] == "OPERATION_CANCELLED"
    assert rt.admin.operation(actors[0], first.operationId)["canRetry"]
    execute(ops_app, "operation.retry", [first.operationId])
    result = run_operation(rt)
    assert result["status"] == "completed" and result["operationId"] != first.operationId
    old = result["operationId"]
    _, verification, _ = execute(ops_app, "backup.verify", [old])
    path = artifact_path(rt, old)
    with path.open("ab") as stream:
        stream.write(b"tampered")
    result = run_operation(rt)
    assert result["status"] == "failed" and result["code"] == "ARTIFACT_INVALID"
    assert not (rt.paths.exports / ("op-" + verification.operationId)).exists()
    _, pending, _ = execute(ops_app, "backup.create", ["instance"])
    execute(ops_app, "session.revoke", [actors[0].session["id"]], index=1)
    result = run_operation(rt)
    assert result["code"] == "ADMIN_AUTH_CHANGED"
    assert rt.admin.operation(actors[1], pending.operationId)["status"] == "failed"


async def test_real_cleanup_orphans_holds_and_schedule(ops_app):
    rt, actors = ops_app[0].runtime, ops_app[1]
    orphan = rt.files.path("a" * 48 + ".bin")
    orphan.write_bytes(b"isolated orphan payload")
    os.utime(orphan, (time.time() - 700, time.time() - 700))
    untouched = rt.paths.uploads / "unknown.keep"
    untouched.write_bytes(b"not app-owned")
    _, cleanup, _ = execute(ops_app, "storage.cleanup", ["instance"])
    result = run_operation(rt)
    assert result["status"] == "completed", result
    view = rt.admin.operation(actors[0], cleanup.operationId)
    assert view["result"]["orphanFilesRemoved"] == 1
    assert view["result"]["bytesReleased"] == len(b"isolated orphan payload")
    assert not orphan.exists() and untouched.is_file()
    with rt.admin.file_snapshot_hold("isolated-hold"):
        assert rt.files.cleanup()["heldByBackup"]
        assert rt.lifecycle.cleanup()["heldByBackup"]
    with rt.db.write() as conn:
        conn.execute("UPDATE jobs SET run_after=0 WHERE kind='backups.schedule'")
    job = rt.jobs.claim(kinds=("backups.schedule",))
    assert job
    rt.admin.scheduled_backup(job)
    rt.admin.scheduled_backup(job)
    with rt.db.read() as conn:
        automatic = conn.execute("SELECT * FROM admin_operations WHERE actor_id IS NULL").fetchall()
        assert 1 <= len(automatic) <= 2
        assert (
            conn.execute("SELECT status FROM jobs WHERE id=?", (job["id"],)).fetchone()[0]
            == "pending"
        )
    assert run_operation(rt)["status"] == "completed"


async def test_audit_export_fixed_selection_and_recover_interrupted(ops_app):
    rt, actors = ops_app[0].runtime, ops_app[1]
    with rt.db.write() as conn:
        audit(
            conn,
            actors[0].id,
            "isolated.export.seed",
            reason=REASON,
            details={"password": "never exported", "requestId": "audit-request"},
        )
    _, command, _ = execute(
        ops_app,
        "export.create",
        ["instance"],
        export_parameters(
            kind="audit", includeFiles=False, filters={"action": "isolated.export.seed"}
        ),
    )
    assert run_operation(rt)["status"] == "completed"
    with zipfile.ZipFile(artifact_path(rt, command.operationId)) as archive:
        content = archive.read("records.jsonl").decode()
        assert "audit-request" in content and "never exported" not in content
    _, interrupted, _ = execute(ops_app, "backup.create", ["instance"])
    with rt.db.write() as conn:
        conn.execute(
            "UPDATE admin_operations SET status='running' WHERE id=?", (interrupted.operationId,)
        )
        conn.execute("UPDATE instance_metadata SET value='1' WHERE key='backup_active'")
    rt.admin.initialize_operations()
    assert (
        rt.admin.operation(actors[0], interrupted.operationId)["errorCode"]
        == "OPERATION_INTERRUPTED"
    )
    with rt.db.read() as conn:
        assert (
            conn.execute(
                "SELECT value FROM instance_metadata WHERE key='backup_active'"
            ).fetchone()[0]
            == "0"
        )


async def test_cooperative_cancel_during_actual_zip_keeps_progress_and_removes_partial(
    ops_app, monkeypatch
):
    import tongpin.admin.operation_worker as worker

    rt, actors = ops_app[0].runtime, ops_app[1]
    conversation = direct(rt, actors[2], actors[3])
    uploaded = upload(rt, actors[2], conversation, image_bytes(), "分步取消.png")
    message(rt, actors[2], conversation, attachmentIds=[uploaded["id"]])
    _, command, _ = execute(ops_app, "backup.create", ["instance"])
    original = worker.write_archive
    cancelled = False

    def with_cancel(runtime, output, kind, oid, entries, check, progress, maximum, **kwargs):
        def on_progress(completed, total, size):
            nonlocal cancelled
            progress(completed, total, size)
            if not cancelled:
                execute(ops_app, "operation.cancel", [oid], index=1)
                cancelled = True

        return original(runtime, output, kind, oid, entries, check, on_progress, maximum, **kwargs)

    monkeypatch.setattr(worker, "write_archive", with_cancel)
    result = run_operation(rt)
    assert cancelled and result["code"] == "OPERATION_CANCELLED"
    view = rt.admin.operation(actors[0], command.operationId)
    assert view["progress"] >= 1 and view["bytes"] > 0 and not view["canDownload"]
    assert not (rt.paths.backups / ("op-" + command.operationId)).exists()
    with rt.db.read() as conn:
        assert (
            conn.execute(
                "SELECT value FROM instance_metadata WHERE key='backup_active'"
            ).fetchone()[0]
            == "0"
        )
        assert (
            conn.execute("SELECT status FROM jobs WHERE id=?", (view["jobId"],)).fetchone()[0]
            == "cancelled"
        )


async def test_export_content_change_after_zip_is_rechecked_before_publication(
    ops_app, monkeypatch
):
    import tongpin.admin.operation_worker as worker

    rt, actors = ops_app[0].runtime, ops_app[1]
    conversation = direct(rt, actors[2], actors[3])
    sent = message(rt, actors[2], conversation)
    _, command, _ = execute(
        ops_app, "export.create", ["instance"], export_parameters(includeFiles=False)
    )
    original = worker.write_archive

    def changed_after_zip(*args, **kwargs):
        result = original(*args, **kwargs)
        execute(ops_app, "message.hide", [sent["id"]], index=1)
        return result

    monkeypatch.setattr(worker, "write_archive", changed_after_zip)
    result = run_operation(rt)
    assert result["code"] == "EXPORT_CHANGED"
    assert not rt.admin.operation(actors[0], command.operationId)["canDownload"]
    assert not (rt.paths.exports / ("op-" + command.operationId)).exists()


async def test_source_file_hash_mismatch_and_expired_export_rejected(ops_app):
    rt, actors = ops_app[0].runtime, ops_app[1]
    conversation = direct(rt, actors[2], actors[3])
    uploaded = upload(rt, actors[2], conversation, image_bytes(), "校验变化.png")
    message(rt, actors[2], conversation, attachmentIds=[uploaded["id"]])
    execute(ops_app, "backup.create", ["instance"])
    with rt.db.read() as conn:
        key = conn.execute(
            "SELECT storage_key FROM attachments WHERE id=?", (uploaded["id"],)
        ).fetchone()[0]
    original = rt.files.path(key).read_bytes()
    rt.files.path(key).write_bytes(b"x" * len(original))
    assert run_operation(rt)["code"] == "FILE_INTEGRITY_FAILED"
    rt.files.path(key).write_bytes(original)
    _, export, _ = execute(ops_app, "export.create", ["instance"], export_parameters())
    assert run_operation(rt)["status"] == "completed"
    path = artifact_path(rt, export.operationId)
    with rt.db.write() as conn:
        conn.execute(
            "UPDATE admin_operations SET expires_at=? WHERE id=?",
            (now_ms() - 1, export.operationId),
        )
    fails(
        "ARTIFACT_UNAVAILABLE",
        lambda: rt.admin.operation_download(
            actors[0], export.operationId, OperationDownload(reason=REASON)
        ),
    )
    with rt.admin.file_snapshot_hold("expiry-hold"):
        assert rt.admin.expire_artifacts() == 0 and path.is_file()
    assert rt.admin.expire_artifacts() >= 1 and not path.exists()


async def test_backup_retention_counts_job_retry_and_foreign_authority(ops_app):
    rt, actors = ops_app[0].runtime, ops_app[1]
    _, command, _ = execute(ops_app, "backup.create", ["instance"])
    assert run_operation(rt)["status"] == "completed"
    with rt.db.write() as conn:
        source = dict(rt.admin.operation_row(conn, command.operationId))
        for category, count in (("daily", 9), ("weekly", 6)):
            for index in range(count):
                row = source | {
                    "id": str(uuid.uuid4()),
                    "backup_class": category,
                    "created_at": now_ms() + index,
                    "expires_at": now_ms() + 40 * 86400000,
                    "storage_key": None,
                }
                columns = list(row)
                conn.execute(
                    "INSERT INTO admin_operations("
                    + ",".join(columns)
                    + ") VALUES("
                    + ",".join("?" for _ in columns)
                    + ")",
                    [row[key] for key in columns],
                )
        rt.admin.trim_backup_retention(conn)
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM admin_operations WHERE backup_class='daily' AND expires_at>?",
                (now_ms(),),
            ).fetchone()[0]
            == 7
        )
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM admin_operations WHERE backup_class='weekly' AND expires_at>?",
                (now_ms(),),
            ).fetchone()[0]
            == 4
        )
        jid = rt.jobs.enqueue_in_transaction(conn, "files.cleanup")
        conn.execute("UPDATE jobs SET status='failed',attempts=5 WHERE id=?", (jid,))
        bad = rt.jobs.enqueue_in_transaction(conn, "admin.execute")
        conn.execute("UPDATE jobs SET status='failed',attempts=5 WHERE id=?", (bad,))
    fails("JOB_NOT_RETRYABLE", lambda: preview(rt, actors[0], "job.retry", [bad]))
    execute(ops_app, "job.retry", [jid])
    with rt.db.read() as conn:
        assert tuple(
            conn.execute("SELECT status,attempts FROM jobs WHERE id=?", (jid,)).fetchone()
        ) == ("pending", 0)
    authority = rt.paths.exports / "foreign-authority.sqlite3"
    rt.db.backup(authority)
    with sqlite3.connect(authority) as conn:
        conn.execute(
            "UPDATE instance_metadata SET value='another-instance' WHERE key='instance_id'"
        )
    fails(
        "RESTORE_AUTHORITY_MISMATCH", lambda: apply_current_authority(rt, authority, lambda: None)
    )
    assert rt.auth.load(ops_app[2][0]).id == actors[0].id


async def test_signed_archive_traversal_is_rejected_before_extract(ops_app):
    rt = ops_app[0].runtime
    path = rt.paths.exports / "malformed.zip"
    entries = {"database.sqlite3": b"not a database", "files/../../escape.bin": b"forbidden"}
    manifest = {
        "format": 1,
        "kind": "backup",
        "files": [
            {"name": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            for name, data in entries.items()
        ],
    }
    envelope = {
        "manifest": manifest,
        "signature": rt.auth.security.digest(compact(manifest), "artifact-manifest"),
    }
    with zipfile.ZipFile(path, "x") as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
        archive.writestr("manifest.json", compact(envelope))
    fails(
        "ARTIFACT_INVALID",
        lambda: read_verified_manifest(
            rt, path, hashlib.sha256(path.read_bytes()).hexdigest(), lambda: None
        ),
    )
    assert not (rt.paths.root / "escape.bin").exists()
