from __future__ import annotations

import hashlib
import json
import uuid

from tongpin.contracts.base import APIError
from tongpin.infra.db import now_ms


def unavailable():
    return APIError("TASK_UNAVAILABLE", "待办不存在或当前无法访问。", 404)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def strong_etag(value):
    return '"' + hashlib.sha256(canonical(value).encode()).hexdigest() + '"'


class TaskPolicy:
    def quota(self, conn, scope):
        name = "task_personal_quota" if scope == "personal" else "task_group_quota"
        return min(self.runtime.policy.get(conn)[name], getattr(self.runtime.settings, name))

    def enabled(self, enhanced=False):
        if (
            not self.runtime.settings.feature_tasks
            or enhanced
            and not self.runtime.settings.feature_tasks_enhanced
        ):
            raise APIError("TASKS_DISABLED", "待办功能当前未启用。", 503)

    def current(self, conn, actor, *, enhanced=False):
        actor = self.runtime.auth.current_in_transaction(conn, actor)
        self.enabled(enhanced)
        return actor

    def write_allowed(self, conn, actor_id, group_id=None):
        if group_id:
            self.runtime.access.conversation(conn, actor_id, group_id, write=True)
        else:
            user = conn.execute(
                "SELECT status,muted_until FROM users WHERE id=?", (actor_id,)
            ).fetchone()
            if not user or user["status"] != "active":
                raise unavailable()
            if (user["muted_until"] or 0) > now_ms():
                raise APIError("MUTED", "账号当前被限制修改待办。", 403)
            if self.runtime.policy.get(conn)["maintenance"]:
                raise APIError("MAINTENANCE", "服务维护中，暂时不能修改待办。", 503)

    def group_meta(self, conn, actor_id, group_id):
        try:
            meta = self.runtime.access.conversation(conn, actor_id, group_id)
            if meta["row"]["kind"] != "group":
                raise unavailable()
            return meta
        except APIError as error:
            if error.status == 404:
                raise unavailable() from error
            raise

    def task_access(self, conn, actor_id, task_id):
        row = conn.execute("SELECT * FROM todo_tasks WHERE id=?", (task_id,)).fetchone()
        if (
            not row
            or row["moderated_deleted"]
            or row["report_only"]
            or row["deleted_at"] is not None
            and row["deleted_at"] + 30 * 86400000 <= now_ms()
        ):
            raise unavailable()
        meta = None
        if row["scope"] == "personal":
            if row["owner_id"] != actor_id:
                raise unavailable()
        else:
            meta = self.group_meta(conn, actor_id, row["group_id"])
        manager = bool(meta and meta["role"] in {"owner", "admin"})
        editor = row["scope"] == "personal" or manager or row["creator_id"] == actor_id
        if row["deleted_at"] is not None and not editor:
            raise unavailable()
        return row, meta, editor, manager

    def capabilities(self, conn, actor_id, row, meta, editor, manager):
        reason = None
        try:
            self.write_allowed(conn, actor_id, row["group_id"])
        except APIError as error:
            reason = error.message
        active = reason is None and row["deleted_at"] is None
        group = row["scope"] == "group"
        progress = editor or row["assignee_id"] == actor_id
        return {
            "edit": active and editor,
            "progress": active and progress,
            "assign": active and manager,
            "claim": active and group and row["assignee_id"] is None,
            "release": active
            and group
            and row["assignee_id"] is not None
            and (manager or row["assignee_id"] == actor_id),
            "checkStructure": active and editor,
            "checkToggle": active and progress,
            "remove": active and editor,
            "restore": reason is None and row["deleted_at"] is not None and editor,
            "comment": active and self.runtime.settings.feature_tasks_enhanced,
            "share": active,
            "copyToGroup": active and not group,
            "writeReason": reason,
        }

    @staticmethod
    def require(allowed):
        if not allowed:
            raise APIError("FORBIDDEN", "当前没有执行此待办操作的权限。", 403)

    def require_creation(self, conn, actor, data):
        self.write_allowed(conn, actor.id, data.groupId if data.scope == "group" else None)
        meta = None
        if data.scope == "personal":
            if data.groupId is not None or data.assigneeId not in (None, actor.id):
                raise APIError("VALIDATION_ERROR", "个人待办只能由本人负责，不能选择群空间。", 422)
        else:
            if not data.groupId:
                raise APIError("VALIDATION_ERROR", "请选择群空间。", 422)
            meta = self.group_meta(conn, actor.id, data.groupId)
            setting = conn.execute(
                "SELECT create_policy FROM todo_group_settings WHERE group_id=?", (data.groupId,)
            ).fetchone()
            self.require(
                not setting or setting[0] == "members" or meta["role"] in {"owner", "admin"}
            )
            self.validate_assignee(
                conn, actor.id, data.groupId, data.assigneeId, meta["role"] in {"owner", "admin"}
            )
        return meta

    def validate_assignee(self, conn, actor_id, group_id, assignee, manager, old_assignee=None):
        if assignee is not None:
            member = conn.execute(
                "SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.conversation_id=? AND m.user_id=? AND m.left_at IS NULL AND u.status='active'",
                (group_id, assignee),
            ).fetchone()
            if not member:
                raise APIError(
                    "VALIDATION_ERROR",
                    "负责人须为当前可用群成员。",
                    422,
                    {"assigneeId": "请选择当前群成员。"},
                )
        self.require(manager or assignee in (None, actor_id) and old_assignee in (None, actor_id))

    def labels_valid(self, conn, actor_id, scope, list_id, tag_ids):
        if scope != "personal" and (list_id or tag_ids):
            raise APIError("VALIDATION_ERROR", "个人清单与标签仅用于本人的个人待办。", 422)
        if len(set(tag_ids)) != len(tag_ids):
            raise APIError("VALIDATION_ERROR", "标签不能重复。", 422)
        for label_id, kind in [(list_id, "list")] + [(tag_id, "tag") for tag_id in tag_ids]:
            if (
                label_id
                and not conn.execute(
                    "SELECT 1 FROM todo_labels WHERE id=? AND user_id=? AND kind=?",
                    (label_id, actor_id, kind),
                ).fetchone()
            ):
                raise APIError("VALIDATION_ERROR", "清单或标签已不可用。", 422)

    def validate_source(self, conn, actor_id, data):
        if data.sourceMessageId:
            message, _ = self.runtime.access.message(conn, actor_id, data.sourceMessageId)
            if message["status"] != "sent":
                raise APIError("RESOURCE_UNAVAILABLE", "来源消息已不可用。", 404)
            if data.scope == "group" and message["conversation_id"] != data.groupId:
                raise APIError("FORBIDDEN", "不能将私聊或其他群的来源直接绑定到本群任务。", 403)
        if data.snapshotMessageId:
            if data.scope != "personal" or data.sourceMessageId:
                raise APIError("VALIDATION_ERROR", "静态副本只能确认存入本人的个人待办。", 422)
            card = self.card_in(conn, actor_id, data.snapshotMessageId)
            if card["kind"] != "snapshot":
                raise unavailable()

    @staticmethod
    def check_version(dto, supplied):
        if not supplied:
            raise APIError("PRECONDITION_REQUIRED", "请先读取待办的当前版本。", 428)
        if supplied != dto["etag"]:
            raise APIError(
                "VERSION_CONFLICT", "待办或权限已更新。已保留本机编辑，请查看最新内容并确认。", 412
            )

    def key_lookup(self, conn, actor_id, key, command, payload):
        try:
            parsed = uuid.UUID(key)
            if parsed.version != 4 or str(parsed) != key:
                raise ValueError
        except (ValueError, TypeError, AttributeError) as error:
            raise APIError(
                "VALIDATION_ERROR", "每次命令须使用有效的UUID v4幂等标识。", 422
            ) from error
        digest = hashlib.sha256(
            canonical({"command": command, "payload": payload}).encode()
        ).hexdigest()
        old = conn.execute(
            "SELECT * FROM todo_mutation_keys WHERE user_id=? AND key=?", (actor_id, key)
        ).fetchone()
        if old and old["payload_hash"] != digest:
            raise APIError(
                "IDEMPOTENCY_CONFLICT", "这个操作标识已有不同内容，请先确认原操作结果。", 409
            )
        return old, digest

    @staticmethod
    def key_store(conn, actor_id, key, digest, kind, ref):
        conn.execute(
            "INSERT INTO todo_mutation_keys(user_id,key,payload_hash,result_kind,result_ref,created_at) VALUES(?,?,?,?,?,?)",
            (actor_id, key, digest, kind, ref, now_ms()),
        )

    def replay_task(self, conn, actor_id, old):
        return {"task": self.view_in(conn, actor_id, old["result_ref"]), "duplicate": True}
