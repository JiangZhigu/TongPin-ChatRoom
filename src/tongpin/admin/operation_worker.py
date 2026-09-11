from __future__ import annotations

import json
import re
import shutil
import sqlite3
import threading
import time
import uuid
import zipfile
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from itertools import islice

from tongpin.admin.artifacts import (
    MAX_BACKUP_BYTES,
    artifact_error,
    backup_file_entries,
    extract_entry,
    private_directory,
    read_verified_manifest,
    remove_private_tree,
    verify_database,
    write_archive,
)
from tongpin.admin.authz import compact
from tongpin.admin.operations import TERMINAL
from tongpin.admin.restoration import isolated_restore
from tongpin.contracts.base import APIError
from tongpin.domain.auth import Principal
from tongpin.domain.security import audit
from tongpin.infra.db import now_ms


class OperationControl:
    def __init__(self, admin, oid):
        self.admin, self.oid = admin, oid
        self.deadline, self.next_check, self.next_progress = time.monotonic() + 600, 0, 0

    def check(self, conn=None, *, force=False):
        if time.monotonic() >= self.deadline:
            raise artifact_error("处理超过10分钟预算，请缩小范围后重试。", "OPERATION_TIMEOUT")
        if self.admin.runtime._stopping.is_set():
            raise artifact_error(
                "实例正在停止，未完成步骤已停止，可重新预览重试。", "OPERATION_INTERRUPTED"
            )
        if conn is None:
            if not force and time.monotonic() < self.next_check:
                return
            with self.admin.runtime.db.read() as current:
                self.check(current)
            self.next_check = time.monotonic() + 0.2
            return
        row = self.admin.operation_row(conn, self.oid)
        if row["cancel_requested"] or row["status"] == "cancelled":
            raise artifact_error("已取消未完成步骤，已完成结果保留记录。", "OPERATION_CANCELLED")
        if row["status"] in TERMINAL:
            raise artifact_error("任务已经结束。", "OPERATION_FINISHED")
        self.admin.operation_authority(conn, row)

    def progress(self, completed, total, size, *, result=None):
        if time.monotonic() < self.next_progress and completed != total and result is None:
            return
        with self.admin.runtime.db.write() as conn:
            self.check(conn)
            conn.execute(
                "UPDATE admin_operations SET progress=?,total=?,bytes=?,updated_at=? WHERE id=?",
                (completed, total, size, now_ms(), self.oid),
            )
            if result is not None:
                conn.execute(
                    "UPDATE admin_operations SET result_json=? WHERE id=?",
                    (compact(result), self.oid),
                )
        self.next_progress = time.monotonic() + 0.5


class OperationWorker:
    def initialize_operations(self):
        # RuntimeLock proves no previous process can still own these steps.
        with self.runtime.db.write() as conn:
            rows = conn.execute("SELECT * FROM admin_operations WHERE status='running'").fetchall()
            for row in rows:
                self.operation_failed(
                    conn, row, "OPERATION_INTERRUPTED", "前次进程结束时任务未完成，请重新预览重试。"
                )
                conn.execute(
                    "UPDATE jobs SET status='failed',lease_until=NULL,last_error_code='OPERATION_INTERRUPTED',completed_at=? WHERE id=?",
                    (now_ms(), row["job_id"]),
                )
            conn.execute(
                "INSERT INTO instance_metadata(key,value) VALUES('backup_active','0') ON CONFLICT(key) DO UPDATE SET value='0'"
            )
            conn.execute("DELETE FROM instance_metadata WHERE key='backup_owner'")
            conn.execute(
                "UPDATE jobs SET status='pending',lease_until=NULL WHERE id IN(SELECT job_id FROM admin_operations WHERE status='queued') AND status='running'"
            )
            self.schedule_backup(conn)

    def operation_authority(self, conn, row):
        if row["actor_id"] is None:
            if row["kind"] != "backup.create" or row["backup_class"] not in ("daily", "weekly"):
                raise artifact_error("自动任务授权无效。", "ADMIN_AUTH_CHANGED")
            return
        user = conn.execute("SELECT * FROM users WHERE id=?", (row["actor_id"],)).fetchone()
        session = conn.execute("SELECT * FROM sessions WHERE id=?", (row["session_id"],)).fetchone()
        try:
            if not user or not session:
                raise APIError("AUTH_REQUIRED", "会话失效。", 401)
            self.runtime.auth.current_in_transaction(
                conn, Principal(dict(user), dict(session)), admin=True
            )
        except APIError as error:
            raise artifact_error(
                "执行者权限或设备会话已变化，任务已停止。", "ADMIN_AUTH_CHANGED"
            ) from error

    @contextmanager
    def file_snapshot_hold(self, oid):
        with self.runtime.files.storage_lock, self.runtime.db.write() as conn:
            held = conn.execute(
                "SELECT value FROM instance_metadata WHERE key='backup_active'"
            ).fetchone()
            if held and held[0] == "1":
                raise artifact_error(
                    "另一个完整性任务正在占用文件保留，请稍后重试。", "BACKUP_BUSY"
                )
            conn.execute(
                "INSERT INTO instance_metadata(key,value) VALUES('backup_active','1') ON CONFLICT(key) DO UPDATE SET value='1'"
            )
            conn.execute(
                "INSERT INTO instance_metadata(key,value) VALUES('backup_owner',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (oid,),
            )
        try:
            yield
        finally:
            with self.runtime.files.storage_lock, self.runtime.db.write() as conn:
                owner = conn.execute(
                    "SELECT value FROM instance_metadata WHERE key='backup_owner'"
                ).fetchone()
                if owner and owner[0] == oid:
                    conn.execute("UPDATE instance_metadata SET value='0' WHERE key='backup_active'")
                    conn.execute("DELETE FROM instance_metadata WHERE key='backup_owner'")

    def process_operation(self, job):
        # Protect direct test/host calls as well as the single dedicated runner.
        with self.operation_lock:
            oid = job["payload"]["operationId"]
            control = OperationControl(self, oid)
            directory = None
            try:
                with self.runtime.db.write() as conn:
                    row = self.operation_row(conn, oid)
                    if row["status"] in TERMINAL:
                        return {"status": row["status"], "operationId": oid}
                    control.check(conn)
                    conn.execute(
                        "UPDATE admin_operations SET status='running',message='正在处理，请以最终结果为准。',updated_at=? WHERE id=?",
                        (now_ms(), oid),
                    )
                base = (
                    self.runtime.paths.backups
                    if row["kind"] == "backup.create"
                    else self.runtime.paths.exports
                )
                self.expire_artifacts(control)
                directory = private_directory(self.runtime, base, "op-" + oid, create=True)
                if any(directory.iterdir()):
                    raise artifact_error(
                        "任务目录已有未核对产物，请重新预览创建新任务。", "ARTIFACT_EXISTS"
                    )
                intent = json.loads(row["parameters_json"])
                if row["kind"] in ("backup.create", "export.create"):
                    with self.file_snapshot_hold(oid):
                        result = self.build_artifact(row, intent, directory, control)
                        self.complete_operation(row, result, control, artifact=True)
                elif row["kind"] in ("backup.verify", "backup.drill"):
                    with self.file_snapshot_hold(oid):
                        result = self.verify_or_restore(row, intent, directory, control)
                        self.complete_operation(row, result, control)
                else:
                    result = self.cleanup_storage(control)
                    self.complete_operation(row, result, control)
                return {"operationId": oid, "status": "completed"}
            except Exception as error:  # noqa: BLE001 -- Publish a safe terminal result, never raw file or database errors.
                code = error.code if isinstance(error, APIError) else "OPERATION_FAILED"
                message = (
                    error.message
                    if isinstance(error, APIError)
                    else "运维处理失败，未发布不完整产物。请按任务编号核对日志后重新预览。"
                )
                with self.runtime.db.write() as conn:
                    row = self.operation_row(conn, oid)
                    if row["status"] not in TERMINAL:
                        self.operation_failed(conn, row, code, message)
                    # Keep generic queue state consistent with the domain result.
                    conn.execute(
                        "UPDATE jobs SET status=?,lease_until=NULL,last_error_code=?,completed_at=? WHERE id=?",
                        (
                            "cancelled" if code == "OPERATION_CANCELLED" else "failed",
                            code,
                            now_ms(),
                            job["id"],
                        ),
                    )
                self.runtime.logs.push(
                    code,
                    level="warning" if code == "OPERATION_CANCELLED" else "error",
                    job_id=job["id"],
                )
                if directory:
                    try:
                        remove_private_tree(self.runtime, directory)
                    except (OSError, ValueError):
                        self.runtime.logs.push("ARTIFACT_CLEANUP_FAILED", job_id=job["id"])
                return {
                    "operationId": oid,
                    "status": "cancelled" if code == "OPERATION_CANCELLED" else "failed",
                    "code": code,
                }

    def operation_failed(self, conn, row, code, message):
        status = "cancelled" if code == "OPERATION_CANCELLED" else "failed"
        conn.execute(
            "UPDATE admin_operations SET status=?,error_code=?,message=?,updated_at=?,expires_at=?,storage_key=NULL WHERE id=?",
            (status, code, message, now_ms(), now_ms() + 86400000, row["id"]),
        )
        audit(
            conn,
            row["actor_id"],
            "admin.operation.finish",
            row["id"],
            result="cancelled" if status == "cancelled" else "failed",
            reason=json.loads(row["parameters_json"]).get("reason", ""),
            details={"code": code, "requestId": row["request_id"], "jobId": row["job_id"]},
        )

    def fail_operation(self, conn, job, code):
        row = conn.execute(
            "SELECT * FROM admin_operations WHERE job_id=? AND status IN('queued','running')",
            (job["id"],),
        ).fetchone()
        if row:
            self.operation_failed(conn, row, code, "运维处理器未完成，请重新预览重试。")

    def complete_operation(self, row, result, control, *, artifact=False):
        with self.runtime.db.write() as conn:
            control.check(conn)
            if row["kind"] == "export.create":
                self.revalidate_export(
                    conn,
                    json.loads(row["parameters_json"])["parameters"],
                    json.loads(row["selection_json"]),
                )
            days = (
                32
                if row["backup_class"] == "weekly"
                else 8
                if row["kind"] == "backup.create"
                else 1
            )
            conn.execute(
                "UPDATE admin_operations SET status='completed',message=?,result_json=?,progress=total,bytes=?,storage_key=?,sha256=?,expires_at=?,updated_at=? WHERE id=?",
                (
                    "完整产物已生成并完成校验。"
                    if artifact
                    else "检查及处理完成，具体范围见结果。",
                    compact(result),
                    result.get("bytes", result.get("bytesReleased", 0)),
                    "archive.zip" if artifact else None,
                    result.get("sha256"),
                    now_ms() + days * 86400000,
                    now_ms(),
                    row["id"],
                ),
            )
            audit(
                conn,
                row["actor_id"],
                "admin.operation.finish",
                row["id"],
                reason=json.loads(row["parameters_json"]).get("reason", ""),
                details={
                    "kind": row["kind"],
                    "requestId": row["request_id"],
                    "jobId": row["job_id"],
                    "bytes": result.get("bytes", 0),
                    "sha256": result.get("sha256"),
                },
            )
            self.trim_backup_retention(conn)

    def build_artifact(self, row, intent, directory, control):
        is_backup = row["kind"] == "backup.create"
        if is_backup:
            database = directory / "database.sqlite3"
            self.runtime.db.backup(database, check=control.check)
            conn = sqlite3.connect(database)
            conn.row_factory = sqlite3.Row
            try:
                entries = [
                    {
                        "name": "database.sqlite3",
                        "path": database,
                        "bytes": database.stat().st_size,
                    },
                    *backup_file_entries(self.runtime, conn),
                ]
                instance = conn.execute(
                    "SELECT value FROM instance_metadata WHERE key='instance_id'"
                ).fetchone()[0]
            finally:
                conn.close()
            maximum, extra = (
                MAX_BACKUP_BYTES,
                {"instanceId": instance, "checks": verify_database(self.runtime, database)},
            )
        else:
            with self.runtime.db.read() as conn:
                entries = self.export_entries(
                    conn,
                    intent["parameters"],
                    json.loads(row["selection_json"]),
                    directory,
                    control.check,
                    control.progress,
                )
            maximum, extra = (
                intent["parameters"]["maxBytes"],
                {"recordCount": len(json.loads(row["selection_json"]))},
            )
        estimated = sum(entry["bytes"] for entry in entries) + 1024 + len(entries) * 300
        if estimated > maximum:
            raise artifact_error("文件集合超出本次完整归档预算。", "ARTIFACT_LIMIT")
        if shutil.disk_usage(directory).free < estimated + 64 * 1024**2:
            raise artifact_error("空间不足以保留完整产物及工作余量。", "STORAGE_FULL")
        output = write_archive(
            self.runtime,
            directory / "archive.zip",
            "backup" if is_backup else "export",
            row["id"],
            entries,
            control.check,
            control.progress,
            maximum,
            extra=extra,
        )
        if is_backup:
            manifest = read_verified_manifest(
                self.runtime, directory / "archive.zip", output["sha256"], control.check
            )
            output["checks"] = extra["checks"] | {
                "filesVerified": len(manifest["files"]),
                "signature": "valid",
            }
        output.pop("manifest")
        output.update({key: value for key, value in extra.items() if key != "checks"})
        # Plaintext staging records and database do not outlive the completed ZIP.
        (directory / ("database.sqlite3" if is_backup else "records.jsonl")).unlink()
        return output

    def verify_or_restore(self, row, intent, directory, control):
        with self.runtime.db.read() as conn:
            source = self.completed_backup(conn, intent["sourceId"])
            archive_path = self.operation_path(source)
            if source["sha256"] != intent["sourceSha256"]:
                raise artifact_error("原备份已变化，请重新预览。")
        manifest = read_verified_manifest(
            self.runtime, archive_path, source["sha256"], control.check
        )
        checked_db = directory / "checked.sqlite3"
        with zipfile.ZipFile(archive_path) as archive:
            extract_entry(archive, "database.sqlite3", checked_db, control.check)
        checked = verify_database(self.runtime, checked_db)
        checked_db.unlink()
        result = {
            "sourceId": source["id"],
            "filesVerified": len(manifest["files"]),
            "signature": "valid",
            "checks": checked,
        }
        if row["kind"] == "backup.drill":
            authority = directory / "current-authority.sqlite3"
            self.runtime.db.backup(authority, check=control.check)
            result["restore"] = isolated_restore(
                self.runtime,
                archive_path,
                manifest,
                directory / "restored-instance",
                authority,
                control.check,
            )
            authority.unlink()
        control.progress(len(manifest["files"]), len(manifest["files"]), source["bytes"])
        return result

    def cleanup_storage(self, control):
        total = {
            "messagesPurged": 0,
            "accountsPurged": 0,
            "filesRemoved": 0,
            "bytesReleased": 0,
            "orphanFilesRemoved": 0,
            "heldByBackup": False,
        }
        for step in range(100):
            control.check(force=True)
            result = self.runtime.lifecycle.cleanup()
            files = self.runtime.files.cleanup()
            for key in ("messagesPurged", "accountsPurged"):
                total[key] += result[key]
            for key in ("filesRemoved", "bytesReleased"):
                total[key] += files.get(key, 0)
            total["heldByBackup"] |= result["heldByBackup"] or files.get("heldByBackup", False)
            control.progress(step + 1, 100, total["bytesReleased"], result=total)
            if total["heldByBackup"] or not result.get("morePending") and files["removed"] < 100:
                break
        total["batchLimitReached"] = step == 99
        orphan = self.cleanup_orphans(control)
        total["filesRemoved"] += orphan["filesRemoved"]
        total["bytesReleased"] += orphan["bytesReleased"]
        total["orphanFilesRemoved"] = orphan["filesRemoved"]
        total["orphanCandidatesChecked"] = orphan["checked"]
        total["heldByBackup"] |= orphan["heldByBackup"]
        total["artifactsExpired"] = self.expire_artifacts(control)
        return total

    def cleanup_orphans(self, control):
        result = {"filesRemoved": 0, "bytesReleased": 0, "checked": 0, "heldByBackup": False}
        # Walk at most 1000 private files per task. A persisted name cursor avoids
        # repeatedly checking the first batch while other orphan files starve.
        with self.runtime.files.storage_lock, self.runtime.db.write() as conn:
            held = conn.execute(
                "SELECT value FROM instance_metadata WHERE key='backup_active'"
            ).fetchone()
            if held and held[0] == "1":
                return result | {"heldByBackup": True}
            old = conn.execute(
                "SELECT value FROM instance_metadata WHERE key='orphan_cursor'"
            ).fetchone()
            after = old[0] if old else ""
            # Filesystem iteration itself is capped; OS directory ordering is not
            # stable, so keep GC conservative and only report examined candidates.
            candidates = list(islice(self.runtime.paths.uploads.iterdir(), 100000))
            names = sorted(path.name for path in candidates if path.name > after)[:1000]
            for name in names:
                control.check()
                result["checked"] += 1
                if not re.fullmatch(r"[0-9a-f]{48}\.bin(?:\.(?:preview|thumbnail)\.webp)?", name):
                    continue
                original = name.split(".bin")[0] + ".bin"
                if conn.execute(
                    "SELECT 1 FROM attachments WHERE storage_key=? OR preview_key=? OR thumbnail_key=? LIMIT 1",
                    (original, name, name),
                ).fetchone():
                    continue
                path = self.runtime.files.path(name)
                if not path.is_file() or now_ms() - int(path.stat().st_mtime * 1000) < 600000:
                    continue
                size = path.stat().st_size
                path.unlink()
                result["filesRemoved"] += 1
                result["bytesReleased"] += size
            conn.execute(
                "INSERT INTO instance_metadata(key,value) VALUES('orphan_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (names[-1] if len(names) == 1000 else "",),
            )
        return result

    def expire_artifacts(self, control=None):
        removed = 0
        with self.runtime.db.read() as conn:
            rows = conn.execute(
                "SELECT * FROM admin_operations WHERE expires_at<=? AND status IN('completed','failed','cancelled') ORDER BY expires_at LIMIT 100",
                (now_ms(),),
            ).fetchall()
        for row in rows:
            if control:
                control.check(force=True)
            base = (
                self.runtime.paths.backups
                if row["kind"] == "backup.create"
                else self.runtime.paths.exports
            )
            directory = private_directory(self.runtime, base, "op-" + row["id"])
            with self.runtime.files.storage_lock:
                with self.runtime.db.read() as conn:
                    held = conn.execute(
                        "SELECT value FROM instance_metadata WHERE key='backup_active'"
                    ).fetchone()
                if held and held[0] == "1":
                    break
                if directory.exists():
                    remove_private_tree(self.runtime, directory)
                    removed += 1
                with self.runtime.db.write() as conn:
                    conn.execute(
                        "UPDATE admin_operations SET storage_key=NULL,expires_at=NULL WHERE id=?",
                        (row["id"],),
                    )
        return removed

    def schedule_backup(self, conn):
        next_midnight = (datetime.now(UTC) + timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        self.runtime.jobs.enqueue_in_transaction(
            conn,
            "backups.schedule",
            {},
            dedupe_key="backups-schedule",
            run_after=int(next_midnight.timestamp() * 1000),
        )

    def scheduled_backup(self, job):
        with self.runtime.db.write() as conn:
            stamp = datetime.now(UTC)
            day = stamp.strftime("%Y-%m-%d")
            previous = conn.execute(
                "SELECT value FROM instance_metadata WHERE key='last_automatic_backup_day'"
            ).fetchone()
            if not previous or previous[0] != day:
                categories = ("daily", "weekly") if stamp.weekday() == 6 else ("daily",)
                queued = conn.execute(
                    "SELECT COUNT(*) FROM admin_operations WHERE status IN('queued','running')"
                ).fetchone()[0]
                if queued + len(categories) > 20:
                    conn.execute(
                        "UPDATE jobs SET status='pending',attempts=0,lease_until=NULL,run_after=?,last_error_code='BACKUP_SCHEDULE_BUSY' WHERE id=?",
                        (now_ms() + 300000, job["id"]),
                    )
                    self.runtime.logs.push("BACKUP_SCHEDULE_BUSY", job_id=job["id"])
                    return {"deferred": True, "retryAfterMs": 300000}
                for category in categories:
                    self.create_operation(
                        conn,
                        str(uuid.uuid4()),
                        "backup.create",
                        None,
                        None,
                        {"parameters": {}, "reason": "每日自动完整备份"},
                        "",
                        backup_class=category,
                    )
                conn.execute(
                    "INSERT INTO instance_metadata(key,value) VALUES('last_automatic_backup_day',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (day,),
                )
            next_midnight = (stamp + timedelta(days=1)).replace(
                hour=0, minute=0, second=0, microsecond=0
            )
            conn.execute(
                "UPDATE jobs SET status='pending',attempts=0,lease_until=NULL,run_after=? WHERE id=?",
                (int(next_midnight.timestamp() * 1000), job["id"]),
            )
            self.trim_backup_retention(conn)
        return {"scheduledFor": day}

    @staticmethod
    def trim_backup_retention(conn):
        for category, keep in (("daily", 7), ("weekly", 4)):
            old = conn.execute(
                "SELECT id FROM admin_operations WHERE backup_class=? AND status='completed' AND expires_at IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET ?",
                (category, keep),
            ).fetchall()
            conn.executemany(
                "UPDATE admin_operations SET expires_at=MIN(expires_at,?) WHERE id=?",
                [(now_ms(), row[0]) for row in old],
            )

    @staticmethod
    def new_operation_lock():
        return threading.RLock()
