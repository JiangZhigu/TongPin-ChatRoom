from __future__ import annotations

import json
import uuid

from tongpin.admin.artifacts import MAX_BACKUP_BYTES, artifact_error, private_directory
from tongpin.admin.authz import compact, cursor, identity, page, unavailable
from tongpin.contracts.base import APIError
from tongpin.domain.security import audit
from tongpin.infra.db import now_ms

OPERATION_KINDS = (
    "export.create",
    "backup.create",
    "backup.verify",
    "backup.drill",
    "storage.cleanup",
)
OPERATION_ACTIONS = (*OPERATION_KINDS, "operation.cancel", "operation.retry", "job.retry")
SAFE_RETRY_JOBS = (
    "files.process",
    "events.dispatch",
    "retention.cleanup",
    "files.cleanup",
    "groups.expire",
)
TERMINAL = ("completed", "failed", "cancelled")


class OperationsAdmin:
    @staticmethod
    def operation_row(conn, oid):
        row = conn.execute("SELECT * FROM admin_operations WHERE id=?", (oid,)).fetchone()
        if not row:
            raise unavailable()
        return row

    def operation_path(self, row):
        if row["kind"] not in ("backup.create", "export.create") or not row["storage_key"]:
            raise unavailable()
        base = (
            self.runtime.paths.backups
            if row["kind"] == "backup.create"
            else self.runtime.paths.exports
        )
        directory = private_directory(self.runtime, base, "op-" + row["id"])
        if row["storage_key"] != "archive.zip":
            raise artifact_error()
        return self.runtime.paths.private_file(directory, row["storage_key"])

    def completed_backup(self, conn, oid):
        row = self.operation_row(conn, oid)
        if (
            row["kind"] != "backup.create"
            or row["status"] != "completed"
            or (row["expires_at"] or 0) <= now_ms()
        ):
            raise APIError("BACKUP_UNAVAILABLE", "请选择尚未到期的完整备份。", 409)
        if not self.operation_path(row).is_file():
            raise APIError("BACKUP_UNAVAILABLE", "备份文件已不存在，请核对存储状态。", 409)
        return row

    def inspect_operation(self, conn, action, target, parameters):
        if action == "export.create":
            selected = self.export_selection(conn, parameters)
            return (
                selected,
                "受控导出",
                f"匹配{selected['totalMatches']}条，固定选中{len(selected['items'])}条，估计{selected['estimatedBytes']}字节，附件文件{selected['fileCount']}个。",
            )
        if action == "backup.create":
            return (
                {"kind": action},
                "当前实例完整备份",
                f"数据库和引用文件；最多{MAX_BACKUP_BYTES}字节，完成后逐文件校验。",
            )
        if action == "storage.cleanup":
            return (
                {"kind": action},
                "当前实例私有存储",
                "分批重新核对到期、引用和备份占用，仅报告实际完成删除。",
            )
        if action in ("backup.verify", "backup.drill"):
            row = self.completed_backup(conn, target)
            return (
                {"id": row["id"], "sha256": row["sha256"], "expiresAt": row["expires_at"]},
                target,
                "完整备份校验"
                if action == "backup.verify"
                else "在全新私有目录恢复并重放当前权限和删除状态。",
            )
        if action == "job.retry":
            row = conn.execute("SELECT * FROM jobs WHERE id=?", (target,)).fetchone()
            if not row or row["status"] != "failed" or row["kind"] not in SAFE_RETRY_JOBS:
                raise APIError(
                    "JOB_NOT_RETRYABLE", "该任务不能直接重试；管理操作请重新预览未完成目标。", 409
                )
            return dict(row), row["kind"], "将此失败任务重新排入已注册的幂等处理器。"
        row = self.operation_row(conn, target)
        if action == "operation.cancel":
            if row["status"] in TERMINAL or row["cancel_requested"]:
                raise APIError("OPERATION_FINISHED", "任务已结束或已请求取消，请刷新状态。", 409)
            return (
                {"id": row["id"], "kind": row["kind"], "cancelRequested": 0},
                target,
                "请求取消，实际已完成步骤保留。",
            )
        if row["status"] not in ("failed", "cancelled"):
            raise APIError("OPERATION_NOT_RETRYABLE", "仅失败或已取消的运维任务可以重新预览。", 409)
        intent = json.loads(row["parameters_json"])
        snap, _, detail = self.inspect_operation(
            conn, row["kind"], intent.get("sourceId", "instance"), intent.get("parameters", {})
        )
        return (
            {"id": target, "status": row["status"], "intent": snap},
            target,
            detail + " 将创建新的任务编号。",
        )

    def create_operation(
        self, conn, oid, kind, actor_id, session_id, intent, request_id, *, backup_class=None
    ):
        if (
            conn.execute(
                "SELECT COUNT(*) FROM admin_operations WHERE status IN('queued','running')"
            ).fetchone()[0]
            >= 20
        ):
            raise APIError("OPERATIONS_BUSY", "运维队列已满，请等待已有任务完成。", 429)
        selected = (
            self.export_selection(conn, intent["parameters"])["items"]
            if kind == "export.create"
            else []
        )
        job_id = self.runtime.jobs.enqueue_in_transaction(
            conn, "admin.operation", {"operationId": oid}, entity_id=oid
        )
        stamp = now_ms()
        conn.execute(
            "INSERT INTO admin_operations(id,kind,actor_id,session_id,parameters_json,selection_json,status,job_id,request_id,created_at,updated_at,backup_class,message) VALUES(?,?,?,?,?,?,'queued',?,?,?,?,?,'已排入运维队列，尚未处理完成。')",
            (
                oid,
                kind,
                actor_id,
                session_id,
                compact(intent),
                compact(selected),
                job_id,
                request_id,
                stamp,
                stamp,
                backup_class,
            ),
        )
        return oid

    def apply_operation(self, conn, command, target, parameters):
        action = command["action"]
        if action == "operation.cancel":
            conn.execute(
                "UPDATE admin_operations SET cancel_requested=1,updated_at=?,message=? WHERE id=?",
                (now_ms(), "已请求取消，等待当前步骤确认停止。", target),
            )
            return "已记录取消请求，请查看运维任务的最终状态。"
        if action == "job.retry":
            conn.execute(
                "UPDATE jobs SET status='pending',attempts=0,run_after=?,lease_until=NULL,completed_at=NULL,last_error_code=NULL WHERE id=? AND status='failed'",
                (now_ms(), target),
            )
            return "已重新排队，实际结果请查看后台任务。"
        if action == "operation.retry":
            old = self.operation_row(conn, target)
            kind, intent = old["kind"], json.loads(old["parameters_json"])
            oid = str(uuid.uuid4())
            intent = intent | {"retryOf": target, "reason": command["reason"]}
        else:
            kind, oid = action, command["id"]
            intent = {"parameters": parameters, "reason": command["reason"]}
            if action in ("backup.verify", "backup.drill"):
                intent["sourceId"] = target
                intent["sourceSha256"] = self.completed_backup(conn, target)["sha256"]
        self.create_operation(
            conn,
            oid,
            kind,
            command["actor_id"],
            command["session_id"],
            intent,
            command["request_id"],
        )
        return "已排入运维任务 " + oid + "；请在运维页面查看实际结果。"

    def operation_view(self, conn, actor, row):
        downloadable = (
            row["status"] == "completed"
            and row["storage_key"]
            and (row["expires_at"] or 0) > now_ms()
        )
        if row["kind"] == "export.create":
            downloadable = (
                downloadable
                and row["actor_id"] == actor.id
                and row["session_id"] == actor.session["id"]
            )
        return {
            "id": row["id"],
            "kind": row["kind"],
            "status": row["status"],
            "creator": identity(conn, row["actor_id"]) if row["actor_id"] else None,
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "expiresAt": row["expires_at"],
            "progress": row["progress"],
            "total": row["total"],
            "bytes": row["bytes"],
            "message": row["message"],
            "errorCode": row["error_code"],
            "result": json.loads(row["result_json"]),
            "jobId": row["job_id"],
            "requestId": row["request_id"],
            "canCancel": row["status"] not in TERMINAL and not row["cancel_requested"],
            "canRetry": row["status"] in ("failed", "cancelled"),
            "canDownload": bool(downloadable),
            "sha256": row["sha256"],
            "backupClass": row["backup_class"],
        }

    def operation(self, actor, oid):
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            return self.operation_view(conn, actor, self.operation_row(conn, oid))

    def operations(self, actor, *, kind="", status="", after="", limit=50, jobs=False):
        statuses = ("pending", "running", *TERMINAL) if jobs else ("queued", "running", *TERMINAL)
        if (
            status
            and status not in statuses
            or kind
            and (len(kind) > 80 or not jobs and kind not in OPERATION_KINDS)
        ):
            raise APIError("VALIDATION_ERROR", "任务种类或状态无效。", 422)
        table = "jobs" if jobs else "admin_operations"
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            terms, args = [], []
            for key, value in (("kind", kind), ("status", status)):
                if value:
                    terms.append(key + "=?")
                    args.append(value)
            where = " AND ".join(terms) or "1=1"
            total = conn.execute(
                "SELECT COUNT(*) FROM " + table + " WHERE " + where, args
            ).fetchone()[0]
            if position := cursor(after, 2):
                where += " AND (created_at,id)<(?,?)"
                args += position
            rows = conn.execute(
                "SELECT * FROM "
                + table
                + " WHERE "
                + where
                + " ORDER BY created_at DESC,id DESC LIMIT ?",
                [*args, limit + 1],
            ).fetchall()

            def view(row):
                if not jobs:
                    return self.operation_view(conn, actor, row)
                linked = conn.execute(
                    "SELECT id FROM admin_operations WHERE job_id=?", (row["id"],)
                ).fetchone()
                can_retry = row["status"] == "failed" and row["kind"] in SAFE_RETRY_JOBS
                return {
                    "id": row["id"],
                    "kind": row["kind"],
                    "entityId": row["entity_id"],
                    "status": row["status"],
                    "attempts": row["attempts"],
                    "createdAt": row["created_at"],
                    "runAfter": row["run_after"],
                    "leaseUntil": row["lease_until"],
                    "completedAt": row["completed_at"],
                    "errorCode": row["last_error_code"],
                    "operationId": linked[0] if linked else None,
                    "canRetry": can_retry,
                    "limitation": None
                    if can_retry
                    else "关联运维任务请使用其取消或重试操作；治理命令请重新预览未完成目标。"
                    if row["kind"].startswith("admin.")
                    else "仅已失败且允许幂等重试的任务提供重试；运行中的系统步骤不能直接中断。",
                }

            return page(rows, total, limit, view, key=lambda row: [row["created_at"], row["id"]])

    def operation_download(self, actor, oid, data, request_id=""):
        with self.runtime.db.write() as conn:
            actor = self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            row = self.operation_row(conn, oid)
            if not self.operation_view(conn, actor, row)["canDownload"]:
                raise APIError(
                    "ARTIFACT_UNAVAILABLE", "文件未完成、已到期或不属于当前管理会话。", 403
                )
            if row["kind"] == "backup.create":
                self.runtime.auth.consume_reauth(
                    conn, actor, data.reauthToken or "", "backup.download:" + oid, admin=True
                )
            path = self.operation_path(row)
            if not path.is_file():
                raise unavailable()
            # Export records are rechecked even after completion: removed content
            # must not remain accessible through an old private artifact.
            if row["kind"] == "export.create":
                intent = json.loads(row["parameters_json"])
                self.revalidate_export(
                    conn, intent["parameters"], json.loads(row["selection_json"])
                )
            audit(
                conn,
                actor.id,
                "admin.operation.download",
                oid,
                reason=data.reason,
                details={"requestId": request_id, "jobId": row["job_id"], "sha256": row["sha256"]},
            )
            return (
                path,
                "application/zip",
                ("tongpin-backup-" if row["kind"] == "backup.create" else "tongpin-export-")
                + oid
                + ".zip",
            )
