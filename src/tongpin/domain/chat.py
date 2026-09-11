from __future__ import annotations

import hashlib
import json

from tongpin.contracts.base import APIError
from tongpin.contracts.chat import message_text, sequence
from tongpin.domain.access import pair, user_summary
from tongpin.domain.security import identifier
from tongpin.infra.db import now_ms


def activity_cursor(value):
    if not value:
        return 0, ""
    parts = value.split(":", 1)
    if len(parts) != 2 or not 1 <= len(parts[1]) <= 80:
        raise APIError("VALIDATION_ERROR", "分页游标无效。", 422)
    return sequence(parts[0]), parts[1]


def next_activity(rows, limit, field="created_at"):
    return f"{rows[limit - 1][field]}:{rows[limit - 1]['id']}" if len(rows) > limit else None


class ChatService:
    def __init__(self, runtime):
        self.runtime = runtime

    def message_view(self, conn, actor_id, row):
        sender = (
            conn.execute("SELECT * FROM users WHERE id=?", (row["sender_id"],)).fetchone()
            if row["sender_id"]
            else None
        )
        visible = row["status"] == "sent"
        reply = None
        if visible and row["reply_id"]:
            try:
                original, _ = self.runtime.access.message(conn, actor_id, row["reply_id"])
                original_sender = (
                    conn.execute(
                        "SELECT * FROM users WHERE id=?", (original["sender_id"],)
                    ).fetchone()
                    if original["sender_id"]
                    else None
                )
                reply = {
                    "id": original["id"],
                    "status": "available" if original["status"] == "sent" else "unavailable",
                    "text": original["text"][:240] if original["status"] == "sent" else "",
                    "author": user_summary(original_sender)["nickname"]
                    if original_sender
                    else "系统",
                }
            except APIError as error:
                if error.status not in (403, 404):
                    raise
                reply = {"id": row["reply_id"], "status": "unavailable", "text": "", "author": ""}
        attachments = (
            self.runtime.files.message_attachments(conn, actor_id, row)
            if visible and getattr(self.runtime, "files", None)
            else []
        )
        result = {
            "id": row["id"],
            "conversationId": row["conversation_id"],
            "seq": str(row["seq"]),
            "senderId": row["sender_id"],
            "sender": user_summary(sender) if sender else None,
            "clientMessageId": row["client_message_id"] if actor_id == row["sender_id"] else None,
            "kind": row["kind"],
            "text": row["text"] if visible else "",
            "status": row["status"],
            "createdAt": row["created_at"],
            "reply": reply,
            "replyToMessageId": row["reply_id"] if visible else None,
            "mentionedUserIds": json.loads(row["mentioned_ids"]) if visible else [],
            "attachments": attachments,
            "reactions": [],
        }
        if getattr(self.runtime, "interactions", None):
            result.update(self.runtime.interactions.decorate(conn, actor_id, row))
        return result

    def conversation_view(self, conn, actor_id, cid):
        meta = self.runtime.access.conversation(conn, actor_id, cid)
        row = meta["row"]
        preference = conn.execute(
            "SELECT * FROM conversation_preferences WHERE user_id=? AND conversation_id=?",
            (actor_id, cid),
        ).fetchone()
        read_seq = max(preference["read_seq"] if preference else 0, meta["minSeq"] - 1)
        last = conn.execute(
            "SELECT * FROM messages WHERE conversation_id=? AND seq>=? ORDER BY seq DESC LIMIT 1",
            (cid, meta["minSeq"]),
        ).fetchone()
        unread = conn.execute(
            "SELECT COUNT(*) FROM messages WHERE conversation_id=? AND seq>? AND seq>=? AND (sender_id IS NULL OR sender_id<>?)",
            (cid, read_seq, meta["minSeq"], actor_id),
        ).fetchone()[0]
        can_send, reason, error_code = True, None, None
        try:
            self.runtime.access.conversation(conn, actor_id, cid, write=True)
        except APIError as error:
            can_send, reason, error_code = False, error.message, error.code
        peer, peer_read = None, None
        if row["kind"] == "direct":
            peer_id = row["high_id"] if actor_id == row["low_id"] else row["low_id"]
            other = conn.execute("SELECT * FROM users WHERE id=?", (peer_id,)).fetchone()
            peer = user_summary(other) | {
                "online": self.runtime.access.presence(conn, actor_id, peer_id)
            }
            own = conn.execute("SELECT preferences FROM users WHERE id=?", (actor_id,)).fetchone()
            if (
                can_send
                and json.loads(own[0]).get("readReceipts", True)
                and json.loads(other["preferences"]).get("readReceipts", True)
            ):
                other_pref = conn.execute(
                    "SELECT read_seq FROM conversation_preferences WHERE user_id=? AND conversation_id=?",
                    (peer_id, cid),
                ).fetchone()
                peer_read = str(other_pref[0]) if other_pref else "0"
            friend_pref = conn.execute("SELECT remark FROM friend_preferences WHERE user_id=? AND friend_id=?", (actor_id, peer_id)).fetchone()
            title, member_count = (friend_pref["remark"] if friend_pref and friend_pref["remark"] else peer["nickname"]), 2
        else:
            title = row["name"]
            member_count = conn.execute(
                "SELECT COUNT(*) FROM memberships WHERE conversation_id=? AND left_at IS NULL",
                (cid,),
            ).fetchone()[0]
        return {
            "id": cid,
            "kind": row["kind"],
            "title": title,
            "description": row["description"],
            "avatarUrl": peer["avatarUrl"] if peer else "/api/v1/groups/" + cid + "/avatar?v=" + row["avatar_id"] if row["avatar_id"] and not row["avatar_hidden"] else None,
            "peer": peer,
            "role": meta["role"],
            "periodId": meta["periodId"],
            "memberCount": member_count,
            "lastSeq": str(row["last_seq"]),
            "readSeq": str(read_seq),
            "peerReadSeq": peer_read,
            "unreadCount": unread,
            "lastMessage": self.message_view(conn, actor_id, last) if last else None,
            "canSend": can_send,
            "sendDisabledReason": reason,
            "sendErrorCode": error_code,
            "accessKey": meta["accessKey"],
            "updatedAt": row["updated_at"],
            "preferences": {
                key: bool(preference[key]) if preference else False
                for key in ("muted", "pinned", "archived")
            } | {"onlyMentions": bool(preference["only_mentions"]) if preference else False},
        }

    def list_in(self, conn, actor_id, after="", limit=50):
        before, last_id = activity_cursor(after)
        rows = conn.execute(
            "SELECT c.* FROM conversations c WHERE ((kind='direct' AND (low_id=? OR high_id=?)) OR (kind='group' AND status<>'dissolved' AND EXISTS(SELECT 1 FROM memberships m WHERE m.conversation_id=c.id AND m.user_id=? AND m.left_at IS NULL))) AND (?=0 OR c.updated_at<? OR(c.updated_at=? AND c.id<?)) ORDER BY c.updated_at DESC,c.id DESC LIMIT ?",
            (actor_id, actor_id, actor_id, before, before, before, last_id, limit + 1),
        ).fetchall()
        return {
            "items": [self.conversation_view(conn, actor_id, row["id"]) for row in rows[:limit]],
            "nextCursor": next_activity(rows, limit, "updated_at"),
        }

    def list(self, actor, after="", limit=50):
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            return self.list_in(conn, actor.id, after, limit)

    def get(self, actor, cid):
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            return self.conversation_view(conn, actor.id, cid)

    def direct(self, actor, other_id):
        with self.runtime.db.write() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            self.runtime.access.direct_write(conn, actor.id, other_id)
            low, high = pair(actor.id, other_id)
            row = conn.execute(
                "SELECT id FROM conversations WHERE kind='direct' AND low_id=? AND high_id=?",
                (low, high),
            ).fetchone()
            if row:
                return self.conversation_view(conn, actor.id, row["id"])
            cid = identifier("c_")
            conn.execute(
                "INSERT INTO conversations(id,kind,low_id,high_id,created_at,updated_at) VALUES(?,'direct',?,?,?,?)",
                (cid, low, high, now_ms(), now_ms()),
            )
            self.runtime.events.publish(conn, [low, high], "conversation.created", cid, cid)
            return self.conversation_view(conn, actor.id, cid)

    def history(self, actor, cid, before=None, after=None, limit=50):
        if before and after:
            raise APIError("VALIDATION_ERROR", "不能同时指定两个消息方向。", 422)
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            meta = self.runtime.access.conversation(conn, actor.id, cid)
            start = max(sequence(after) if after else 0, meta["minSeq"] - 1)
            stop = sequence(before) if before else meta["row"]["last_seq"] + 1
            direction = "ASC" if after is not None else "DESC"
            rows = conn.execute(
                f"SELECT * FROM messages WHERE conversation_id=? AND seq>? AND seq<? ORDER BY seq {direction} LIMIT ?",
                (cid, start, stop, limit + 1),
            ).fetchall()
            page = rows[:limit]
            if after is None:
                page = list(reversed(page))
            return {
                "items": [self.message_view(conn, actor.id, row) for row in page],
                "hasMore": len(rows) > limit,
                "nextCursor": str(rows[limit - 1]["seq"]) if len(rows) > limit else None,
                "lastSeq": str(meta["row"]["last_seq"]),
                "accessKey": meta["accessKey"],
            }

    def send(self, actor, cid, data):
        self.runtime.auth.security.rate("message-send", actor.id, 120, 60)
        attachments = list(data.attachmentIds)
        mentions = sorted(set(data.mentionedUserIds))
        text = message_text(data.text, allow_empty=bool(attachments))
        if len(set(attachments)) != len(attachments):
            raise APIError("VALIDATION_ERROR", "同一附件不能重复添加。", 422)
        payload = {
            "conversationId": cid,
            "text": text,
            "attachmentIds": attachments,
            "replyToMessageId": data.replyToMessageId,
            "mentionedUserIds": mentions,
            "accessKey": data.accessKey,
        }
        # Existing offline messages did not include this optional field in their
        # payload hash. Preserve their idempotence when the new value is false.
        if data.mentionAll:
            payload["mentionAll"] = True
        payload_hash = hashlib.sha256(
            json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
        ).hexdigest()
        with self.runtime.db.write() as conn:
            actor = self.runtime.auth.current_in_transaction(conn, actor)
            if data.actorContext is not None and data.actorContext != actor.id:
                raise APIError("AUTH_REQUIRED", "浏览器账号已改变，请重新连接后继续。", 401)
            access = self.runtime.access.conversation(conn, actor.id, cid, write=True)
            if access["accessKey"] != data.accessKey:
                raise APIError("STALE_ACCESS", "会话权限已改变，请检查并重新编辑待发内容。", 409)
            duplicate = conn.execute(
                "SELECT * FROM messages WHERE sender_id=? AND client_message_id=?",
                (actor.id, data.clientMessageId),
            ).fetchone()
            if duplicate:
                if duplicate["payload_hash"] != payload_hash:
                    raise APIError(
                        "IDEMPOTENCY_CONFLICT",
                        "消息标识对应的内容已改变，请保留草稿并检查发送结果。",
                        409,
                    )
                self.runtime.access.message(conn, actor.id, duplicate["id"])
                result = {
                    "message": self.message_view(conn, actor.id, duplicate),
                    "duplicate": True,
                }
            else:
                if (
                    access["row"]["kind"] == "group"
                    and access["role"] == "member"
                    and access["row"]["slow_seconds"]
                ):
                    last = conn.execute(
                        "SELECT MAX(created_at) FROM messages WHERE conversation_id=? AND sender_id=?",
                        (cid, actor.id),
                    ).fetchone()[0]
                    delay = (
                        (last + access["row"]["slow_seconds"] * 1000 - now_ms())
                        if last is not None
                        else 0
                    )
                    if delay > 0:
                        raise APIError(
                            "SLOW_MODE",
                            "群聊启用了慢速模式，请稍后重试这条消息。",
                            429,
                            retry_after_ms=delay,
                        )
                if data.replyToMessageId:
                    original, _ = self.runtime.access.message(conn, actor.id, data.replyToMessageId)
                    if original["conversation_id"] != cid or original["status"] != "sent":
                        raise APIError("RESOURCE_UNAVAILABLE", "引用的消息已无法使用。", 404)
                recipients = self.runtime.access.recipients(conn, cid)
                if data.mentionAll and (access["row"]["kind"] != "group" or access["role"] not in {"owner", "admin"}):
                    raise APIError("FORBIDDEN", "只有当前群主和管理员可以提醒全体成员。", 403)
                if any(uid not in recipients for uid in mentions):
                    raise APIError("VALIDATION_ERROR", "只能提及当前会话中的成员。", 422)
                if attachments:
                    if not getattr(self.runtime, "files", None):
                        raise APIError("FILES_UNAVAILABLE", "附件服务尚未启用。", 503)
                    self.runtime.files.validate_for_message(conn, actor, cid, attachments)
                policy = self.runtime.policy.get(conn)
                message_text(
                    text,
                    max_chars=policy["message_codepoints"],
                    max_bytes=policy["message_bytes"],
                    allow_empty=bool(attachments),
                )
                seq = access["row"]["last_seq"] + 1
                mid, timestamp = identifier("m_"), now_ms()
                conn.execute(
                    "UPDATE conversations SET last_seq=?,updated_at=? WHERE id=?",
                    (seq, timestamp, cid),
                )
                conn.execute(
                    "INSERT INTO messages(id,conversation_id,seq,sender_id,client_message_id,payload_hash,text,reply_id,mentioned_ids,created_at,mention_all) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        mid,
                        cid,
                        seq,
                        actor.id,
                        data.clientMessageId,
                        payload_hash,
                        text,
                        data.replyToMessageId,
                        json.dumps(mentions),
                        timestamp,
                        int(data.mentionAll),
                    ),
                )
                if attachments:
                    self.runtime.files.bind_message(conn, actor, mid, attachments)
                self.runtime.events.publish(conn, recipients, "message.created", mid, cid)
                for uid in set(recipients if data.mentionAll else mentions) - {actor.id}:
                    self.runtime.events.notify(conn, uid, "message.mentioned", mid, actor.id)
                row = conn.execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone()
                result = {"message": self.message_view(conn, actor.id, row), "duplicate": False}
        # This return is deliberately outside the transaction: ACK means committed.
        return result

    def read(self, actor, cid, value):
        requested = sequence(value)
        with self.runtime.db.write() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            meta = self.runtime.access.conversation(conn, actor.id, cid)
            if not meta["minSeq"] - 1 <= requested <= meta["row"]["last_seq"]:
                raise APIError("VALIDATION_ERROR", "已读位置超出当前可见消息范围。", 422)
            old = conn.execute(
                "SELECT read_seq FROM conversation_preferences WHERE user_id=? AND conversation_id=?",
                (actor.id, cid),
            ).fetchone()
            maximum = max(requested, old[0] if old else 0)
            conn.execute(
                "INSERT INTO conversation_preferences(user_id,conversation_id,read_seq) VALUES(?,?,?) ON CONFLICT(user_id,conversation_id) DO UPDATE SET read_seq=MAX(read_seq,excluded.read_seq)",
                (actor.id, cid, maximum),
            )
            if not old or maximum > old[0]:
                visible_receipt = (
                    meta["row"]["kind"] == "direct"
                    and self.conversation_view(conn, actor.id, cid)["peerReadSeq"] is not None
                )
                recipients = (
                    self.runtime.access.recipients(conn, cid) if visible_receipt else [actor.id]
                )
                self.runtime.events.publish(conn, recipients, "read.updated", cid, cid)
        return {"readSeq": str(maximum)}

    def preferences(self, actor, cid, data):
        values = data.model_dump(exclude_unset=True, exclude_none=True)
        if not values:
            raise APIError("VALIDATION_ERROR", "请选择要修改的会话偏好。", 422)
        with self.runtime.db.write() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            self.runtime.access.conversation(conn, actor.id, cid)
            conn.execute(
                "INSERT OR IGNORE INTO conversation_preferences(user_id,conversation_id) VALUES(?,?)",
                (actor.id, cid),
            )
            for key, value in values.items():
                # keys are the explicit validated model field allowlist.
                column = "only_mentions" if key == "onlyMentions" else key
                conn.execute(
                    f"UPDATE conversation_preferences SET {column}=? WHERE user_id=? AND conversation_id=?",
                    (int(value), actor.id, cid),
                )
            self.runtime.events.publish(conn, [actor.id], "conversation.updated", cid, cid)
            return self.conversation_view(conn, actor.id, cid)
