from __future__ import annotations

from tongpin.admin.authz import conflict, identity, page, unavailable
from tongpin.admin.sensitive import (
    like_query,
    paged_sql,
    query_budget,
    search_terms,
    sensitive_read,
)
from tongpin.infra.db import now_ms


class FilesAdmin:
    def file_content_allowed(self, conn, row):
        if row["state"] != "ready" or row["scan_status"] == "infected":
            return False
        if row["message_id"]:
            message = conn.execute(
                "SELECT * FROM messages WHERE id=?", (row["message_id"],)
            ).fetchone()
            return bool(message and self.content_retained(conn, message))
        return bool(row["avatar_bound"] or row["expires_at"] > now_ms())

    def file_view(self, conn, row):
        available = self.file_content_allowed(conn, row)
        original = (
            available
            and row["purpose"] == "message"
            and self.runtime.files.path(row["storage_key"]).is_file()
        )
        preview = (
            available
            and bool(row["preview_key"])
            and self.runtime.files.path(row["preview_key"]).is_file()
        )
        held = conn.execute(
            "SELECT value FROM instance_metadata WHERE key='backup_active'"
        ).fetchone()
        reason = (
            "正在执行完整备份"
            if held and held[0] == "1"
            else "仍由消息或头像引用"
            if row["message_id"] or row["avatar_bound"]
            else "尚在上传保留期"
            if row["expires_at"] > now_ms()
            else "等待清理任务"
            if row["quota_bytes"]
            else None
        )
        return {
            "id": row["id"],
            "name": row["name"],
            "owner": identity(conn, row["owner_id"]),
            "conversationId": row["conversation_id"],
            "messageId": row["message_id"],
            "purpose": row["purpose"],
            "kind": row["kind"],
            "mime": row["mime"],
            "size": row["size"] or row["expected_size"],
            "sha256": row["expected_sha256"],
            "state": row["state"],
            "scanStatus": row["scan_status"],
            "governance": row["governance"],
            "governanceReason": row["governance_reason"],
            "chargedBytes": row["quota_bytes"],
            "createdAt": row["created_at"],
            "expiresAt": row["expires_at"],
            "version": row["governance_version"],
            "contentAvailable": bool(original),
            "previewAvailable": bool(preview),
            "cleanupReason": reason,
        }

    def files_search(self, actor, data, request_id=""):
        with sensitive_read(self, actor, "files.search", None, data.reason, request_id) as (
            conn,
            details,
        ):
            conditions, args = search_terms(data, "a")
            for field, value in (
                ("owner_id", data.ownerId),
                ("state", data.state),
                ("governance", data.governance),
                ("kind", data.kind),
            ):
                if value:
                    conditions.append("a." + field + "=?")
                    args.append(value)
            if data.query:
                conditions.append("a.name LIKE ? ESCAPE '!'")
                args.append(like_query(data.query))
            where = " AND ".join(conditions) or "1=1"
            more_where, more_args = paged_sql(where, args, data.after, "a")
            with query_budget(conn):
                total = conn.execute(
                    "SELECT COUNT(*) FROM attachments a WHERE " + where, args
                ).fetchone()[0]
                rows = conn.execute(
                    "SELECT a.* FROM attachments a WHERE "
                    + more_where
                    + " ORDER BY a.created_at DESC,a.id DESC LIMIT ?",
                    [*more_args, data.limit + 1],
                ).fetchall()
                result = page(
                    rows,
                    total,
                    data.limit,
                    lambda row: self.file_view(conn, row),
                    key=lambda row: [row["created_at"], row["id"]],
                )
            details.update(
                targetIds=[item["id"] for item in result["items"]], queryLength=len(data.query)
            )
            return result

    def file_read(self, actor, fid, data, request_id=""):
        with sensitive_read(self, actor, "file.metadata", fid, data.reason, request_id) as (
            conn,
            _,
        ):
            return {"file": self.file_view(conn, self.runtime.files.row(conn, fid))}

    def file_content(self, actor, fid, data, request_id=""):
        with sensitive_read(self, actor, "file." + data.variant, fid, data.reason, request_id) as (
            conn,
            _,
        ):
            row = self.runtime.files.row(conn, fid)
            if not self.file_content_allowed(conn, row):
                raise unavailable()
            key = (
                row["storage_key"]
                if data.variant == "content" and row["purpose"] == "message"
                else row[data.variant + "_key"]
                if data.variant != "content"
                else None
            )
            if not key or not self.runtime.files.path(key).is_file():
                raise unavailable()
            return (
                self.runtime.files.path(key),
                row["mime"] if data.variant == "content" else "image/webp",
                row["name"],
            )

    def inspect_file(self, conn, action, fid, parameters):
        row = self.runtime.files.row(conn, fid)
        if row["quota_bytes"] == 0 or row["state"] in ("expired", "cancelled", "rejected"):
            raise conflict("该附件已到期、拒绝或清理，不能调整访问。")
        desired = {
            "file.quarantine": "quarantined",
            "file.release": "available",
            "file.revoke": "revoked",
        }[action]
        if row["governance"] == desired:
            raise conflict("该附件已经处于目标管理状态。")
        return (
            {"id": fid, "version": row["governance_version"], "governance": row["governance"]},
            "附件 " + fid,
            row["governance"] + " / " + row["state"],
        )

    def apply_file(self, conn, command, fid, parameters):
        self.inspect_file(conn, command["action"], fid, parameters)
        value = {
            "file.quarantine": "quarantined",
            "file.release": "available",
            "file.revoke": "revoked",
        }[command["action"]]
        conn.execute(
            "UPDATE attachments SET governance=?,governance_reason=?,updated_at=? WHERE id=?",
            (value, command["reason"], now_ms(), fid),
        )
        row = self.runtime.files.row(conn, fid)
        if row["message_id"]:
            self.runtime.events.publish(
                conn,
                self.runtime.access.recipients(conn, row["conversation_id"]),
                "message.updated",
                row["message_id"],
                row["conversation_id"],
            )
        elif row["avatar_bound"] and row["conversation_id"]:
            conn.execute(
                "UPDATE conversations SET avatar_hidden=?,updated_at=? WHERE id=? AND avatar_id=?",
                (int(value != "available"), now_ms(), row["conversation_id"], fid),
            )
            self.runtime.groups.changed(conn, row["conversation_id"])
        else:
            if row["avatar_bound"]:
                conn.execute(
                    "UPDATE users SET avatar_hidden=?,updated_at=? WHERE id=? AND avatar_id=?",
                    (int(value != "available"), now_ms(), row["owner_id"], fid),
                )
            self.runtime.events.user_changed(conn, row["owner_id"])
        return "管理访问状态已更新；原扫描结果及内容保留限制继续执行。"
