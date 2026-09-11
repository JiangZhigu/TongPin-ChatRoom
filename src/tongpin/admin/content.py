from __future__ import annotations

import json

from tongpin.admin.authz import conflict, identity, page, unavailable
from tongpin.admin.sensitive import (
    like_query,
    paged_sql,
    query_budget,
    search_terms,
    sensitive_read,
)
from tongpin.infra.db import now_ms

DAY = 86400000


class ContentAdmin:
    @staticmethod
    def shared_task_card(conn, message_id):
        card = conn.execute(
            "SELECT * FROM todo_message_cards WHERE message_id=?", (message_id,)
        ).fetchone()
        if not card:
            return None
        if card["kind"] == "snapshot":
            # This is already-shared chat material. There is deliberately no
            # reference through which an administrator can read a private task.
            return {"kind": "snapshot", "snapshot": json.loads(card["snapshot_json"])}
        task = conn.execute(
            "SELECT id,group_id FROM todo_tasks WHERE id=? AND scope='group' AND deleted_at IS NULL AND moderated_deleted=0 AND report_only=0",
            (card["task_id"],),
        ).fetchone()
        return (
            {"kind": "live", "taskId": task["id"], "groupId": task["group_id"]}
            if task
            else {"kind": "unavailable"}
        )

    def content_retained(self, conn, row):
        return row["status"] == "sent" or (
            row["status"] in ("recalled", "moderated")
            and row["removed_at"] is not None
            and row["removed_at"] + self.runtime.policy.get(conn)["deleted_content_days"] * DAY
            > now_ms()
        )

    def content_view(self, conn, row):
        conversation = conn.execute(
            "SELECT id,kind,name,status,low_id,high_id FROM conversations WHERE id=?",
            (row["conversation_id"],),
        ).fetchone()
        title = (
            conversation["name"]
            if conversation["kind"] == "group"
            else " / ".join(
                identity(conn, uid)["nickname"]
                for uid in (conversation["low_id"], conversation["high_id"])
            )
        )
        retained = self.content_retained(conn, row)
        return {
            "id": row["id"],
            "conversationId": row["conversation_id"],
            "seq": str(row["seq"]),
            "conversation": {
                "id": conversation["id"],
                "title": title,
                "kind": conversation["kind"],
                "status": conversation["status"],
            },
            "sender": identity(conn, row["sender_id"]) if row["sender_id"] else None,
            "kind": row["kind"],
            "text": row["text"] if retained else None,
            "taskCard": self.shared_task_card(conn, row["id"]) if retained else None,
            "status": row["status"],
            "moderationKind": row["moderation_kind"],
            "createdAt": row["created_at"],
            "removedAt": row["removed_at"],
            "removedReason": row["removed_reason"] if retained else None,
            "retained": retained,
            "canRestore": retained and row["status"] == "moderated",
            "attachments": [
                self.file_view(conn, attachment)
                for attachment in conn.execute(
                    "SELECT * FROM attachments WHERE message_id=? ORDER BY message_position",
                    (row["id"],),
                )
            ]
            if retained
            else [],
            "replyToMessageId": row["reply_id"] if retained else None,
            "reviewedAt": row["reviewed_at"],
            "reviewedBy": identity(conn, row["reviewed_by"]) if row["reviewed_by"] else None,
            "version": row["content_version"],
        }

    def content_search(self, actor, data, request_id=""):
        with sensitive_read(self, actor, "content.search", None, data.reason, request_id) as (
            conn,
            audit_details,
        ):
            conditions, args = search_terms(data, "m")
            for column, value in (
                ("m.sender_id", data.senderId),
                ("m.status", data.status),
                ("c.kind", data.kind),
            ):
                if value:
                    conditions.append(column + "=?")
                    args.append(value)
            if data.query:
                conditions.append(
                    "m.text LIKE ? ESCAPE '!' AND (m.status='sent' OR (m.status IN('recalled','moderated') AND m.removed_at>?))"
                )
                args.extend(
                    [
                        like_query(data.query),
                        now_ms() - self.runtime.policy.get(conn)["deleted_content_days"] * DAY,
                    ]
                )
            where = " AND ".join(conditions) or "1=1"
            source = " FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE "
            more_where, more_args = paged_sql(where, args, data.after, "m")
            with query_budget(conn):
                total = conn.execute("SELECT COUNT(*)" + source + where, args).fetchone()[0]
                rows = conn.execute(
                    "SELECT m.*"
                    + source
                    + more_where
                    + " ORDER BY m.created_at DESC,m.id DESC LIMIT ?",
                    [*more_args, data.limit + 1],
                ).fetchall()
                result = page(
                    rows,
                    total,
                    data.limit,
                    lambda row: self.content_view(conn, row),
                    key=lambda row: [row["created_at"], row["id"]],
                )
            audit_details.update(
                targetIds=[row["id"] for row in rows[: data.limit]],
                returned=len(result["items"]),
                queryLength=len(data.query),
            )
            return result

    def content_read(self, actor, mid, data, request_id=""):
        with sensitive_read(self, actor, "content.context", mid, data.reason, request_id) as (
            conn,
            details,
        ):
            row = conn.execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone()
            if not row:
                raise unavailable()
            before = conn.execute(
                "SELECT * FROM messages WHERE conversation_id=? AND seq<? ORDER BY seq DESC LIMIT 25",
                (row["conversation_id"], row["seq"]),
            ).fetchall()
            after = conn.execute(
                "SELECT * FROM messages WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT 25",
                (row["conversation_id"], row["seq"]),
            ).fetchall()
            rows = [*reversed(before), row, *after]
            details["targetIds"] = [item["id"] for item in rows]
            return {
                "message": self.content_view(conn, row),
                "items": [self.content_view(conn, item) for item in rows],
                "hasBefore": bool(
                    conn.execute(
                        "SELECT 1 FROM messages WHERE conversation_id=? AND seq<?",
                        (row["conversation_id"], rows[0]["seq"]),
                    ).fetchone()
                ),
                "hasAfter": bool(
                    conn.execute(
                        "SELECT 1 FROM messages WHERE conversation_id=? AND seq>?",
                        (row["conversation_id"], rows[-1]["seq"]),
                    ).fetchone()
                ),
            }

    def inspect_content(self, conn, action, mid, parameters):
        row = conn.execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone()
        if not row:
            raise unavailable()
        if row["kind"] != "user" or not self.content_retained(conn, row):
            raise conflict("该内容未保留或不是可处置的用户消息。")
        if action == "message.restore" and row["status"] != "moderated":
            raise conflict("只能恢复保留期内的管理处置，不能重新发布用户撤回的消息。")
        if action in ("message.hide", "message.delete") and row["status"] != "sent":
            raise conflict("该消息已不处于正常发送状态。")
        snapshot = {key: row[key] for key in ("id", "status", "content_version", "removed_at")}
        snapshot["retentionDays"] = self.runtime.policy.get(conn)["deleted_content_days"]
        return snapshot, "消息 " + mid, row["status"] + "；会话 " + row["conversation_id"]

    def apply_content(self, conn, command, mid, parameters):
        action = command["action"]
        self.inspect_content(conn, action, mid, parameters)
        if action == "message.review":
            conn.execute(
                "UPDATE messages SET reviewed_at=?,reviewed_by=? WHERE id=?",
                (now_ms(), command["actor_id"], mid),
            )
            return "已记录本次审阅。"
        if action == "message.restore":
            conn.execute(
                "UPDATE messages SET status='sent',moderation_kind=NULL,removed_at=NULL,removed_by=NULL,removed_reason=NULL WHERE id=?",
                (mid,),
            )
        else:
            conn.execute(
                "UPDATE messages SET status='moderated',moderation_kind=?,removed_at=?,removed_by=?,removed_reason=? WHERE id=?",
                (
                    "hidden" if action == "message.hide" else "deleted",
                    now_ms(),
                    command["actor_id"],
                    command["reason"],
                    mid,
                ),
            )
        cid = conn.execute("SELECT conversation_id FROM messages WHERE id=?", (mid,)).fetchone()[0]
        self.runtime.events.publish(
            conn, self.runtime.access.recipients(conn, cid), "message.updated", mid, cid
        )
        return "管理处置已生效，相关会话将重新读取当前消息状态。"
