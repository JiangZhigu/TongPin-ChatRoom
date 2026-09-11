from __future__ import annotations

import json
import secrets

from tongpin.admin.authz import compact, conflict, cursor, identity, page, unavailable
from tongpin.admin.sensitive import query_budget
from tongpin.config import DEFAULT_POLICY
from tongpin.contracts.base import APIError
from tongpin.domain.security import audit, identifier
from tongpin.infra.db import now_ms


def field(key, label, group, kind, minimum=None, maximum=None, help_text="", options=None):
    value = {"key": key, "label": label, "group": group, "type": kind, "help": help_text}
    if minimum is not None:
        value["min"] = minimum
    if maximum is not None:
        value["max"] = maximum
    if options:
        value["options"] = [{"value": key, "label": label} for key, label in options]
    return value


POLICY_FIELDS = [
    field(
        "registration_mode",
        "注册准入",
        "账号与准入",
        "enum",
        options=[("closed", "关闭注册"), ("invite-only", "仅凭站点邀请码"), ("open", "开放注册")],
    ),
    field(
        "group_limit",
        "每群成员上限",
        "群聊与消息",
        "integer",
        2,
        200,
        "缩小不移出既有成员，只限制后续入群。",
    ),
    field(
        "owned_group_limit",
        "每人活跃自建群上限",
        "群聊与消息",
        "integer",
        1,
        20,
        "既有群保留；新建或接收群主时检查。",
    ),
    field("message_codepoints", "消息字符上限", "群聊与消息", "integer", 1, 4000),
    field("message_bytes", "消息UTF-8字节上限", "群聊与消息", "integer", 4, 16384),
    field("recall_seconds", "本人撤回期限（秒）", "群聊与消息", "integer", 0, 120),
    field("image_limit_bytes", "图片大小上限（字节）", "文件与空间", "integer", 1024, 10 * 1024**2),
    field("file_limit_bytes", "文件大小上限（字节）", "文件与空间", "integer", 1024, 25 * 1024**2),
    field("attachment_count", "每条消息附件上限", "文件与空间", "integer", 1, 6),
    field(
        "message_attachment_bytes",
        "每条消息附件合计上限（字节）",
        "文件与空间",
        "integer",
        1024,
        50 * 1024**2,
    ),
    field(
        "user_quota_bytes",
        "默认账号配额（字节）",
        "文件与空间",
        "integer",
        1024,
        1024**4,
        "账号单独配额优先；缩小不删除已有文件。",
    ),
    field("disk_high_watermark", "磁盘使用高水位（%）", "文件与空间", "integer", 50, 95),
    field(
        "deleted_content_days",
        "被处置内容保留（天）",
        "数据保留",
        "integer",
        1,
        365,
        "缩小会改变管理读取/恢复期限；到期正文由后续清理任务删除。",
    ),
    field("audit_days", "审计保留（天）", "数据保留", "integer", 30, 3650),
    field("log_days", "运行日志保留（天）", "数据保留", "integer", 1, 365),
    field("events_days", "同步事件保留（天）", "数据保留", "integer", 7, 365),
    field("export_hours", "导出可下载期限（小时）", "数据保留", "integer", 1, 24),
    field(
        "deletion_cooling_days",
        "注销冷静期（天）",
        "数据保留",
        "integer",
        1,
        90,
        "仅新提交的注销采用新期限，已给用户的日期不追溯缩短。",
    ),
    field("registration_per_hour", "每来源每小时注册尝试上限", "限流与通知", "integer", 1, 100),
    field("login_ip_per_15m", "每来源15分钟登录尝试上限", "限流与通知", "integer", 5, 500),
    field("login_user_per_15m", "每账号15分钟登录尝试上限", "限流与通知", "integer", 3, 50),
    field("message_per_minute", "每账号每分钟发送尝试上限", "限流与通知", "integer", 1, 600),
    field("group_create_per_hour", "每账号每小时建群尝试上限", "限流与通知", "integer", 1, 60),
    field(
        "online_notifications",
        "允许好友上线提醒",
        "限流与通知",
        "boolean",
        help_text="仍需逐好友启用，并遵守隐身、勿扰与屏蔽设置。",
    ),
    field(
        "maintenance",
        "开启维护模式",
        "运行与运营信息",
        "boolean",
        help_text="暂停普通用户新消息、建群与群管理、注册和上传；允许读取及管理员退出维护。",
    ),
    field("operator_name", "运营者名称", "运行与运营信息", "string", 0, 100),
    field("operator_contact", "运营联系信息", "运行与运营信息", "string", 0, 200),
    field(
        "terms_version",
        "注册条款版本",
        "运行与运营信息",
        "string",
        1,
        80,
        "条款改变后需新的注册确认，现有账号不会自动代表接受新条款。",
    ),
]
FIELD_MAP = {item["key"]: item for item in POLICY_FIELDS}


def editable_values(policy):
    return {key: policy[key] for key in FIELD_MAP}


def validate_values(values):
    if not isinstance(values, dict) or set(values) != set(FIELD_MAP):
        raise APIError("VALIDATION_ERROR", "站点策略字段不完整或包含不允许编辑的字段。", 422)
    for key, value in values.items():
        item = FIELD_MAP[key]
        valid = True
        if item["type"] == "integer":
            valid = type(value) is int and item["min"] <= value <= item["max"]
        elif item["type"] == "boolean":
            valid = type(value) is bool
        elif item["type"] == "string":
            valid = (
                isinstance(value, str)
                and item["min"] <= len(value.strip()) <= item["max"]
                and not any(ord(char) < 32 for char in value)
            )
        elif item["type"] == "enum":
            valid = value in [option["value"] for option in item["options"]]
        if not valid:
            raise APIError(
                "VALIDATION_ERROR",
                item["label"] + "不在允许范围内。",
                422,
                {key: "请按所示范围填写。"},
            )
    return dict(values)


class SettingsAdmin:
    def settings_view(self, actor):
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            policy = self.runtime.policy.get(conn)
            row = conn.execute(
                "SELECT created_at FROM policy_versions ORDER BY version DESC LIMIT 1"
            ).fetchone()
            return {
                "version": policy["version"],
                "values": editable_values(policy),
                "fields": POLICY_FIELDS,
                "appliedAt": row[0] if row else None,
                "effect": "immediate",
                "environment": self.runtime.settings.environment,
                "readOnly": [
                    "用户名4–24位、密码15–128字符、CAPTCHA及单次再认证属于安全硬限制。",
                    "已有设备会话到期日与客户端离线100条/7天/50MiB上限不在这里追溯改写。",
                    "部署密钥、监听地址、并发数、扫描器连接及生产严格扫描由启动器配置，不能在后台降低。",
                    "本页历史回滚只回滚列出的站点策略项；监控阈值在运行监控中单独变更。",
                ],
            }

    def settings_versions(self, actor, after="", limit=50):
        boundary = cursor(after)
        if boundary and type(boundary[0]) is not int:
            raise APIError("VALIDATION_ERROR", "策略版本分页无效。", 422)
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            rows = conn.execute(
                "SELECT * FROM policy_versions WHERE (?=0 OR version<?) ORDER BY version DESC LIMIT ?",
                (boundary[0] if boundary else 0, boundary[0] if boundary else 0, limit + 1),
            ).fetchall()
            total = conn.execute("SELECT COUNT(*) FROM policy_versions").fetchone()[0]
            return page(
                rows,
                total,
                limit,
                lambda row: {
                    "version": row["version"],
                    "actor": identity(conn, row["actor_id"]) if row["actor_id"] else None,
                    "reason": row["reason"],
                    "createdAt": row["created_at"],
                    "values": editable_values(DEFAULT_POLICY | json.loads(row["values_json"])),
                },
                key=lambda row: [row["version"]],
            )

    def settings_candidate(self, conn, action, parameters):
        current = self.runtime.policy.get(conn)
        if parameters["expectedVersion"] != current["version"]:
            raise conflict("站点策略已被其他操作更新，请重新读取当前版本。")
        if action == "settings.rollback":
            row = conn.execute(
                "SELECT values_json FROM policy_versions WHERE version=?", (parameters["version"],)
            ).fetchone()
            if parameters["version"] == 0 and not row:
                candidate = editable_values(DEFAULT_POLICY)
            elif not row:
                raise unavailable()
            else:
                candidate = editable_values(DEFAULT_POLICY | json.loads(row[0]))
        else:
            candidate = parameters["values"]
        candidate = validate_values(candidate)
        if (
            self.runtime.settings.production
            and candidate["registration_mode"] == "open"
            and (
                not candidate["operator_name"].strip()
                or not candidate["operator_contact"].strip()
                or candidate["terms_version"].startswith("development")
            )
        ):
            raise APIError(
                "PRODUCTION_PRECHECK_FAILED",
                "开放注册前需要填写真实运营信息并设置正式条款版本。",
                409,
            )
        if editable_values(current) == candidate:
            raise conflict("所选策略与当前运行值相同。")
        return current, candidate

    def inspect_settings(self, conn, action, target, parameters):
        current, candidate = self.settings_candidate(conn, action, parameters)
        changes = []
        for key, item in FIELD_MAP.items():
            if current[key] != candidate[key]:

                def describe(value, field_item=item):
                    if type(value) is bool:
                        return "开启" if value else "关闭"
                    return next(
                        (
                            option["label"]
                            for option in field_item.get("options", [])
                            if option["value"] == value
                        ),
                        str(value) or "（空）",
                    )

                changes.append(
                    item["label"] + "：" + describe(current[key]) + " → " + describe(candidate[key])
                )
        with query_budget(conn):
            if candidate["deleted_content_days"] < current["deleted_content_days"]:
                count = conn.execute(
                    "SELECT COUNT(*) FROM messages WHERE status IN('recalled','moderated') AND removed_at<=?",
                    (now_ms() - candidate["deleted_content_days"] * 86400000,),
                ).fetchone()[0]
                changes.append(
                    f"新保留期下已有{count}条被处置内容到期；保存不物理删除，后续清理任务处理。"
                )
            for key, table in (("audit_days", "audit_events"), ("events_days", "user_events")):
                if candidate[key] < current[key]:
                    count = conn.execute(
                        "SELECT COUNT(*) FROM " + table + " WHERE created_at<?",
                        (now_ms() - candidate[key] * 86400000,),
                    ).fetchone()[0]
                    changes.append(
                        f"{FIELD_MAP[key]['label']}缩小后，后续清理可处理{count}项到期记录。"
                    )
        return (
            {"version": current["version"]},
            "站点策略版本 " + str(current["version"]),
            "\n".join(changes),
        )

    def apply_settings(self, conn, command, parameters):
        current, candidate = self.settings_candidate(conn, command["action"], parameters)
        version = current.pop("version") + 1
        changed = {
            key: {"before": current[key], "after": candidate[key]}
            for key in FIELD_MAP
            if current[key] != candidate[key]
        }
        if version == 1:
            conn.execute(
                "INSERT INTO policy_versions VALUES(?,?,NULL,?,?)",
                (0, compact(current), "首次策略变更前保存的初始配置", now_ms()),
            )
        conn.execute(
            "INSERT INTO policy_versions VALUES(?,?,?,?,?)",
            (
                version,
                compact(current | candidate),
                command["actor_id"],
                command["reason"],
                now_ms(),
            ),
        )
        audit(
            conn,
            command["actor_id"],
            "admin.settings.diff",
            "instance",
            reason=command["reason"],
            details={
                "operationId": command["id"],
                "requestId": command["request_id"],
                "version": version,
                "changes": changed,
            },
        )
        return f"运行中的站点策略已更新为版本{version}；后续请求使用新值。"

    def site_invites(self, actor, after="", limit=50):
        boundary = cursor(after)
        if boundary and type(boundary[0]) is not str:
            raise APIError("VALIDATION_ERROR", "邀请码分页无效。", 422)
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            rows = conn.execute(
                "SELECT * FROM site_invites WHERE (?='' OR id<?) ORDER BY id DESC LIMIT ?",
                (boundary[0] if boundary else "", boundary[0] if boundary else "", limit + 1),
            ).fetchall()
            total = conn.execute("SELECT COUNT(*) FROM site_invites").fetchone()[0]

            def convert(row):
                return {
                    "id": row["id"],
                    "createdBy": identity(conn, row["created_by"]) if row["created_by"] else None,
                    "createdAt": row["created_at"],
                    "expiresAt": row["expires_at"],
                    "maxUses": row["max_uses"],
                    "used": row["used"],
                    "revokedAt": row["revoked_at"],
                    "status": "revoked"
                    if row["revoked_at"]
                    else "expired"
                    if row["expires_at"] <= now_ms()
                    else "exhausted"
                    if row["used"] >= row["max_uses"]
                    else "active",
                }

            return page(rows, total, limit, convert)

    def inspect_site_invite(self, conn, action, target, parameters):
        if action == "site_invite.create":
            return (
                {"policyVersion": self.runtime.policy.get(conn)["version"]},
                "新站点邀请码",
                f"最多{parameters['maxUses']}次；{parameters['expiresInHours']}小时后到期；仅单次领取。",
            )
        row = conn.execute("SELECT * FROM site_invites WHERE id=?", (target,)).fetchone()
        if not row:
            raise unavailable()
        if row["revoked_at"]:
            raise conflict("该邀请码已经撤销。")
        return (
            {key: value for key, value in dict(row).items() if key != "digest"},
            "站点邀请码 " + target,
            f"已用{row['used']} / {row['max_uses']}次",
        )

    def apply_site_invite(self, conn, command, target, parameters):
        if command["action"] == "site_invite.revoke":
            conn.execute("UPDATE site_invites SET revoked_at=? WHERE id=?", (now_ms(), target))
            return "站点邀请码已撤销，不能再用于注册。"
        value, iid = secrets.token_urlsafe(32), identifier("site_")
        expiry = now_ms() + parameters["expiresInHours"] * 3600000
        conn.execute(
            "INSERT INTO site_invites(id,digest,created_by,created_at,expires_at,max_uses) VALUES(?,?,?,?,?,?)",
            (
                iid,
                self.runtime.auth.security.digest(value, "site_invite"),
                command["actor_id"],
                now_ms(),
                expiry,
                parameters["maxUses"],
            ),
        )
        self.secrets.set(
            command["id"],
            {
                "credential": value,
                "username": "",
                "expiresAt": expiry,
                "kind": "site_invite",
                "actorId": command["actor_id"],
                "sessionId": command["session_id"],
            },
        )
        return "站点邀请码已创建，5分钟内可在原管理会话领取一次。编号：" + iid
