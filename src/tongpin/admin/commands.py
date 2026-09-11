from __future__ import annotations

import json
from datetime import UTC, datetime

from tongpin.admin.authz import compact, conflict, fingerprint, mute_until, unavailable
from tongpin.admin.monitoring import validate_thresholds
from tongpin.contracts.base import APIError
from tongpin.domain.auth import Principal
from tongpin.domain.security import audit
from tongpin.infra.db import now_ms


class CommandsAdmin:
    @staticmethod
    def action_impacts(payload):
        action, parameters = payload["action"], payload["parameters"]
        descriptions = {
            "user.ban": "封禁所列账号，并撤销其全部设备会话与再认证授权。",
            "user.unban": "解除账号封禁；此前撤销的设备需要重新登录。",
            "user.unmute": "解除所列账号的全站禁言。",
            "user.restore": "取消仍在冷静期的账号注销；此前退出的群和撤销的会话不自动恢复。",
            "user.password_reset": "撤销旧会话并要求改密。新凭据生成后5分钟内可领取一次，生成后1小时到期，使用后失效。",
            "session.revoke": "撤销所列设备会话并断开对应实时连接。",
            "user.logout_all": "撤销所列账号全部当前设备会话并断开连接。",
            "relationship.remove": "解除双方好友关系，关闭依赖该关系的私聊发送和好友上线提醒。",
            "friend_request.cancel": "取消仍待处理的好友申请。",
            "conversation.freeze": "冻结所列会话，参与人暂时不能发送新消息。",
            "conversation.unfreeze": "解除会话冻结，其他账号与成员限制仍适用。",
            "group.member.unmute": "解除所列成员在该群的禁言。",
            "group.member.remove": "移出所列非群主成员，终止当前加入期和相关访问。",
            "group.dissolve": "解散所列群，关闭全部成员加入期并撤销邀请、待审名额及在途转让。",
            "group.invite.revoke": "撤销所列邀请，使关联待审申请到期并释放预留名额。",
        }
        if action in ("user.mute", "group.member.mute"):
            until = datetime.fromtimestamp(parameters["until"] / 1000, UTC).isoformat()
            return [f"{'全站' if action == 'user.mute' else '所选群内'}禁言截止：{until}（UTC）。"]
        if action == "user.restrict":
            return [
                f"上传：{'禁止' if parameters['uploadDisabled'] else '允许'}；创建群聊：{'禁止' if parameters['groupCreationDisabled'] else '允许'}。既有内容保留。"
            ]
        if action == "group.member.role":
            return [
                f"将所列成员设为{'群管理员' if parameters['role'] == 'admin' else '普通成员'}。"
            ]
        if action == "group.owner.change":
            return [f"新群主账号编号：{parameters['userId']}；原群主改为普通成员，取消在途转让。"]
        if action == "monitoring.thresholds":
            labels = {
                "cpuPercent": "CPU使用率（%）",
                "memoryMiB": "内存（MiB）",
                "diskPercent": "磁盘使用率（%）",
                "httpP95Ms": "HTTP P95（毫秒）",
                "dbWaitMs": "数据库等待（毫秒）",
                "failedJobs": "失败任务数",
                "pendingJobs": "等待任务数",
            }
            return [f"{labels[key]}：{value}" for key, value in parameters["values"].items()]
        return [descriptions[action]]

    @staticmethod
    def validate_parameters(action, targets, parameters):
        expected = (
            {"until"}
            if action in ("user.mute", "group.member.mute")
            else {"role"}
            if action == "group.member.role"
            else {"userId"}
            if action == "group.owner.change"
            else {"uploadDisabled", "groupCreationDisabled"}
            if action == "user.restrict"
            else {"values"}
            if action == "monitoring.thresholds"
            else set()
        )
        if set(parameters) != expected:
            raise APIError("VALIDATION_ERROR", "操作参数与所选动作不匹配。", 422)
        if "until" in expected:
            mute_until(parameters)
        if action == "group.member.role" and parameters["role"] not in ("member", "admin"):
            raise APIError("VALIDATION_ERROR", "请选择群管理员或普通成员。", 422)
        if action == "group.owner.change" and (
            not isinstance(parameters["userId"], str) or not 1 <= len(parameters["userId"]) <= 128
        ):
            raise APIError("VALIDATION_ERROR", "请选择本群的当前成员。", 422)
        if action == "user.restrict" and any(
            type(value) is not bool for value in parameters.values()
        ):
            raise APIError("VALIDATION_ERROR", "限制开关必须是明确的开启或关闭。", 422)
        if action == "user.password_reset" and len(targets) != 1:
            raise APIError("VALIDATION_ERROR", "人工密码重置每次只处理一个已核验账号。", 422)
        if action == "monitoring.thresholds":
            if targets != ["instance"]:
                raise APIError("VALIDATION_ERROR", "监控阈值只作用于当前实例。", 422)
            validate_thresholds(parameters["values"])

    def inspect_target(self, conn, action, target, parameters):
        if action.startswith("user."):
            return self.inspect_user(conn, action, target, parameters)
        if action == "session.revoke":
            return self.inspect_session(conn, target)
        if action in ("relationship.remove", "friend_request.cancel"):
            return self.inspect_relation(conn, action, target)
        if action == "monitoring.thresholds":
            return self.inspect_monitoring(conn)
        return self.inspect_group(conn, action, target, parameters)

    @staticmethod
    def preview_view(row):
        payload = json.loads(row["payload_json"])
        targets = json.loads(row["targets_json"])
        return {
            "operationId": row["id"],
            "action": payload["action"],
            "reason": payload["reason"],
            "targetCount": len(targets),
            "targets": [{key: item[key] for key in ("id", "label", "detail")} for item in targets],
            "impacts": [
                *CommandsAdmin.action_impacts(payload),
                "仅对列出的目标执行；每个目标在提交时再次检查。",
                "本次理由及逐项结果会写入管理审计。",
            ],
            "expiresAt": row["expires_at"],
            "requiresReauthentication": True,
        }

    def preview(self, actor, data):
        self.validate_parameters(data.action, data.targetIds, data.parameters)
        self.runtime.auth.security.rate("admin-preview", actor.id, 60, 60)
        payload = data.model_dump(exclude={"operationId"})
        digest = fingerprint(payload)
        with self.runtime.db.write() as conn:
            actor = self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            command = conn.execute(
                "SELECT id FROM admin_commands WHERE id=?", (data.operationId,)
            ).fetchone()
            if command:
                raise APIError("COMMAND_EXISTS", "该操作已提交，请核对原操作结果。", 409)
            old = conn.execute(
                "SELECT * FROM admin_previews WHERE id=?", (data.operationId,)
            ).fetchone()
            if old:
                if (
                    old["actor_id"] != actor.id
                    or old["session_id"] != actor.session["id"]
                    or old["payload_hash"] != digest
                ):
                    raise APIError("IDEMPOTENCY_CONFLICT", "操作标识已用于不同的目标或参数。", 409)
                if old["expires_at"] <= now_ms():
                    raise APIError("PREVIEW_EXPIRED", "预览已过期，请重新预览。", 409)
                return self.preview_view(old)
            conn.execute(
                "DELETE FROM admin_previews WHERE id IN(SELECT id FROM admin_previews WHERE expires_at<=? LIMIT 1000)",
                (now_ms(),),
            )
            if (
                conn.execute(
                    "SELECT COUNT(*) FROM admin_previews WHERE actor_id=?", (actor.id,)
                ).fetchone()[0]
                >= 100
            ):
                raise APIError("ADMIN_BUSY", "待确认操作过多，请等待已有预览过期。", 429)
            targets = []
            for target in data.targetIds:
                snap, label, detail = self.inspect_target(
                    conn, data.action, target, data.parameters
                )
                targets.append(
                    {
                        "id": target,
                        "label": label,
                        "detail": detail,
                        "fingerprint": fingerprint(snap),
                    }
                )
            stamp = now_ms()
            conn.execute(
                "INSERT INTO admin_previews VALUES(?,?,?,?,?,?,?,?)",
                (
                    data.operationId,
                    actor.id,
                    actor.session["id"],
                    digest,
                    compact(payload),
                    compact(targets),
                    stamp,
                    stamp + 300000,
                ),
            )
            return self.preview_view(
                conn.execute(
                    "SELECT * FROM admin_previews WHERE id=?", (data.operationId,)
                ).fetchone()
            )

    def command_view(self, conn, row):
        items = conn.execute(
            "SELECT * FROM admin_command_items WHERE command_id=? ORDER BY ordinal", (row["id"],)
        ).fetchall()
        secret = self.secrets.get(row["id"]) if row["status"] == "completed" else None
        return {
            "operationId": row["id"],
            "action": row["action"],
            "status": row["status"],
            "total": len(items),
            "succeeded": sum(item["status"] == "succeeded" for item in items),
            "failed": sum(item["status"] in ("failed", "cancelled") for item in items),
            "pending": sum(item["status"] == "pending" for item in items),
            "items": [
                {
                    "id": item["target_id"],
                    "label": item["label"],
                    "status": item["status"],
                    "code": item["code"],
                    "message": item["message"],
                }
                for item in items
            ],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "jobId": row["job_id"],
            "secretAvailable": bool(secret),
        }

    def command(self, actor, operation_id):
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            row = conn.execute(
                "SELECT * FROM admin_commands WHERE id=? AND actor_id=?", (operation_id, actor.id)
            ).fetchone()
            if not row:
                raise unavailable()
            return self.command_view(conn, row)

    def execute(self, actor, data, request_id=""):
        with self.runtime.db.write() as conn:
            actor = self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            existing = conn.execute(
                "SELECT * FROM admin_commands WHERE id=?", (data.operationId,)
            ).fetchone()
            if existing:
                if existing["actor_id"] != actor.id:
                    raise unavailable()
                return self.command_view(conn, existing)
            preview = conn.execute(
                "SELECT * FROM admin_previews WHERE id=? AND actor_id=? AND session_id=?",
                (data.operationId, actor.id, actor.session["id"]),
            ).fetchone()
            if not preview or preview["expires_at"] <= now_ms():
                raise APIError("PREVIEW_EXPIRED", "请重新预览本次操作。", 409)
            payload, targets = (
                json.loads(preview["payload_json"]),
                json.loads(preview["targets_json"]),
            )
            self.validate_parameters(payload["action"], payload["targetIds"], payload["parameters"])
            for target in targets:
                snap, _, _ = self.inspect_target(
                    conn, payload["action"], target["id"], payload["parameters"]
                )
                if fingerprint(snap) != target["fingerprint"]:
                    raise conflict()
            self.runtime.auth.consume_reauth(
                conn, actor, data.reauthToken, "admin.execute:" + data.operationId, admin=True
            )
            stamp = now_ms()
            job_id = (
                self.runtime.jobs.enqueue_in_transaction(
                    conn,
                    "admin.execute",
                    {"commandId": data.operationId},
                    entity_id=data.operationId,
                )
                if len(targets) > 1
                else None
            )
            conn.execute(
                "INSERT INTO admin_commands VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    data.operationId,
                    actor.id,
                    actor.session["id"],
                    payload["action"],
                    payload["reason"],
                    compact(payload["parameters"]),
                    preview["payload_hash"],
                    request_id,
                    job_id,
                    "queued" if job_id else "running",
                    stamp,
                    stamp,
                ),
            )
            for ordinal, target in enumerate(targets):
                conn.execute(
                    "INSERT INTO admin_command_items(command_id,ordinal,target_id,label,fingerprint) VALUES(?,?,?,?,?)",
                    (
                        data.operationId,
                        ordinal,
                        target["id"],
                        target["label"],
                        target["fingerprint"],
                    ),
                )
            command = conn.execute(
                "SELECT * FROM admin_commands WHERE id=?", (data.operationId,)
            ).fetchone()
            audit(
                conn,
                actor.id,
                "admin.command.accept",
                data.operationId,
                reason=payload["reason"],
                details={
                    "action": payload["action"],
                    "targets": len(targets),
                    "requestId": request_id,
                    "jobId": job_id,
                },
            )
            if not job_id:
                item = conn.execute(
                    "SELECT * FROM admin_command_items WHERE command_id=?", (data.operationId,)
                ).fetchone()
                self.apply_item(conn, actor, command, item)
                self.finish_command(conn, data.operationId)
            result = self.command_view(
                conn,
                conn.execute(
                    "SELECT * FROM admin_commands WHERE id=?", (data.operationId,)
                ).fetchone(),
            )
        self.after_command()
        return result

    def apply_item(self, conn, actor, command, item):
        self.runtime.auth.current_in_transaction(conn, actor, admin=True)
        parameters = json.loads(command["parameters_json"])
        code, message, status = None, None, "succeeded"
        conn.execute("SAVEPOINT admin_target")
        try:
            self.validate_parameters(command["action"], [item["target_id"]], parameters)
            snap, _, _ = self.inspect_target(conn, command["action"], item["target_id"], parameters)
            if fingerprint(snap) != item["fingerprint"]:
                raise conflict()
            if command["action"].startswith("user."):
                message = self.apply_user(conn, command, item["target_id"], parameters)
            elif command["action"] == "session.revoke":
                message = self.apply_session(conn, item["target_id"])
            elif command["action"] in ("relationship.remove", "friend_request.cancel"):
                message = self.apply_relation(conn, command["action"], item["target_id"])
            elif command["action"] == "monitoring.thresholds":
                message = self.apply_monitoring(conn, command, parameters)
            else:
                message = self.apply_group(conn, command, item["target_id"], parameters)
            conn.execute("RELEASE admin_target")
        except APIError as error:
            conn.execute("ROLLBACK TO admin_target")
            conn.execute("RELEASE admin_target")
            status, code, message = "failed", error.code, error.message
        conn.execute(
            "UPDATE admin_command_items SET status=?,code=?,message=? WHERE command_id=? AND ordinal=?",
            (status, code, message, command["id"], item["ordinal"]),
        )
        audit(
            conn,
            actor.id,
            "admin." + command["action"],
            item["target_id"],
            reason=command["reason"],
            result="success" if status == "succeeded" else "failed",
            details={
                "operationId": command["id"],
                "requestId": command["request_id"],
                "jobId": command["job_id"],
                "beforeFingerprint": item["fingerprint"],
                "parameters": parameters,
                "code": code,
            },
        )

    @staticmethod
    def finish_command(conn, operation_id):
        counts = {
            row[0]: row[1]
            for row in conn.execute(
                "SELECT status,COUNT(*) FROM admin_command_items WHERE command_id=? GROUP BY status",
                (operation_id,),
            )
        }
        status = (
            "running"
            if counts.get("pending")
            else "partial"
            if counts.get("succeeded") and (counts.get("failed") or counts.get("cancelled"))
            else "completed"
            if counts.get("succeeded")
            else "failed"
            if counts.get("failed")
            else "cancelled"
        )
        conn.execute(
            "UPDATE admin_commands SET status=?,updated_at=? WHERE id=?",
            (status, now_ms(), operation_id),
        )

    def process_command(self, job):
        operation_id = job["payload"]["commandId"]
        for _ in range(10):
            with self.runtime.db.write() as conn:
                command = conn.execute(
                    "SELECT * FROM admin_commands WHERE id=?", (operation_id,)
                ).fetchone()
                if not command or command["status"] not in ("queued", "running"):
                    return {"finished": True}
                session = conn.execute(
                    "SELECT * FROM sessions WHERE id=?", (command["session_id"],)
                ).fetchone()
                user = conn.execute(
                    "SELECT * FROM users WHERE id=?", (command["actor_id"],)
                ).fetchone()
                try:
                    if not session or not user:
                        raise APIError("AUTH_REQUIRED", "执行者会话已失效。", 401)
                    actor = self.runtime.auth.current_in_transaction(
                        conn, Principal(dict(user), dict(session)), admin=True
                    )
                except APIError:
                    conn.execute(
                        "UPDATE admin_command_items SET status='cancelled',code='ADMIN_AUTH_CHANGED',message='执行者权限或会话已变化，未执行部分已停止。' WHERE command_id=? AND status='pending'",
                        (operation_id,),
                    )
                    self.finish_command(conn, operation_id)
                    audit(
                        conn,
                        command["actor_id"],
                        "admin.command.stop",
                        operation_id,
                        reason=command["reason"],
                        result="cancelled",
                        details={
                            "jobId": job["id"],
                            "requestId": command["request_id"],
                            "code": "ADMIN_AUTH_CHANGED",
                        },
                    )
                    return {"finished": True}
                item = conn.execute(
                    "SELECT * FROM admin_command_items WHERE command_id=? AND status='pending' ORDER BY ordinal LIMIT 1",
                    (operation_id,),
                ).fetchone()
                if not item:
                    self.finish_command(conn, operation_id)
                    return {"finished": True}
                self.apply_item(conn, actor, command, item)
                self.finish_command(conn, operation_id)
            self.after_command()
        with self.runtime.db.write() as conn:
            row = conn.execute(
                "SELECT status FROM admin_commands WHERE id=?", (operation_id,)
            ).fetchone()
            if row and row[0] in ("queued", "running"):
                conn.execute(
                    "UPDATE jobs SET status='pending',lease_until=NULL,run_after=?,attempts=0 WHERE id=? AND status='running'",
                    (now_ms() + 100, job["id"]),
                )
        return {"batchProcessed": 10}

    def fail_command(self, conn, job, code):
        command = conn.execute(
            "SELECT * FROM admin_commands WHERE job_id=? AND status IN('queued','running')",
            (job["id"],),
        ).fetchone()
        if not command:
            return
        conn.execute(
            "UPDATE admin_command_items SET status='failed',code=?,message='后台任务重试后仍未完成，请核对逐项结果后重新预览未完成目标。' WHERE command_id=? AND status='pending'",
            (code, command["id"]),
        )
        self.finish_command(conn, command["id"])
        audit(
            conn,
            command["actor_id"],
            "admin.command.fail",
            command["id"],
            reason=command["reason"],
            result="failed",
            details={"jobId": job["id"], "requestId": command["request_id"], "code": code},
        )

    def after_command(self):
        self.runtime.revalidate_connections()

    def reveal_secret(self, actor, operation_id):
        with self.runtime.db.write() as conn:
            self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            command = conn.execute(
                "SELECT * FROM admin_commands WHERE id=? AND actor_id=? AND session_id=? AND status='completed' AND action='user.password_reset'",
                (operation_id, actor.id, actor.session["id"]),
            ).fetchone()
            if not command:
                raise unavailable()
            output = []

            def take(value):
                if value["actorId"] != actor.id or value["sessionId"] != actor.session["id"]:
                    return False
                output.append({key: value[key] for key in ("credential", "expiresAt", "username")})
                return True

            if not self.secrets.consume(operation_id, take):
                raise APIError(
                    "SECRET_UNAVAILABLE",
                    "凭据已显示或已过展示期限；如未妥善保存，请重新核验并生成新的重置凭据。",
                    409,
                )
            audit(
                conn,
                actor.id,
                "admin.reset_credential.reveal",
                operation_id,
                reason=command["reason"],
            )
            return output[0]
