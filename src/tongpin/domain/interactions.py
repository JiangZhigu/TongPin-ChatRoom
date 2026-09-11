from __future__ import annotations

import hashlib
import json
import sqlite3
import time

from tongpin.contracts.base import APIError
from tongpin.contracts.chat import message_text
from tongpin.domain.access import user_summary
from tongpin.domain.chat import activity_cursor
from tongpin.domain.emoji import emoji_keys, require_emoji
from tongpin.domain.security import audit, identifier
from tongpin.infra.cache import BoundedCache
from tongpin.infra.db import now_ms


class InteractionService:
    def __init__(self, runtime):
        self.runtime = runtime
        self.typing_cache = BoundedCache(max_entries=10000, max_bytes=1024 * 1024, ttl=5)
        self.typing_rate = BoundedCache(max_entries=10000, max_bytes=512 * 1024, ttl=2)

    def can_moderate(self, conn, actor_id, row, meta=None):
        if row["kind"] != "user" or row["status"] != "sent":
            return False
        meta = meta or self.runtime.access.conversation(conn, actor_id, row["conversation_id"])
        if meta["row"]["kind"] != "group":
            return False
        if meta["role"] == "owner":
            return True
        if meta["role"] != "admin":
            return False
        sender = conn.execute(
            "SELECT role FROM memberships WHERE conversation_id=? AND user_id=? "
            "ORDER BY (left_at IS NULL) DESC,joined_at DESC,id DESC LIMIT 1",
            (row["conversation_id"], row["sender_id"]),
        ).fetchone()
        return bool(sender and sender["role"] == "member")

    def decorate(self, conn, actor_id, row):
        bookmark = conn.execute(
            "SELECT 1 FROM bookmarks WHERE user_id=? AND message_id=?", (actor_id, row["id"])
        ).fetchone()
        can_interact = False
        try:
            self.runtime.access.conversation(conn, actor_id, row["conversation_id"], write=True)
            can_interact = row["status"] == "sent" and row["kind"] == "user"
        except APIError as error:
            if error.status not in (403, 404, 503):
                raise
        visible = row["status"] == "sent" and row["kind"] == "user"
        reactions = []
        if visible:
            for item in conn.execute(
                "SELECT emoji_key,COUNT(*) AS count,MAX(user_id=?) AS mine FROM message_reactions "
                "WHERE message_id=? GROUP BY emoji_key ORDER BY MIN(created_at),emoji_key",
                (actor_id, row["id"]),
            ):
                reactions.append(
                    {
                        "key": emoji_keys()[item["emoji_key"]],
                        "count": item["count"],
                        "mine": bool(item["mine"]),
                    }
                )
        return {
            "bookmarked": bool(bookmark),
            "reactions": reactions,
            "mentionAll": bool(row["mention_all"]) if visible else False,
            "capabilities": {
                "canInteract": can_interact,
                "canRecall": bool(
                    visible
                    and row["sender_id"] == actor_id
                    and now_ms()
                    <= row["created_at"] + self.runtime.policy.get(conn)["recall_seconds"] * 1000
                ),
                "canModerate": self.can_moderate(conn, actor_id, row) if visible else False,
            },
        }

    def get(self, actor, mid):
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            row, _ = self.runtime.access.message(conn, actor.id, mid)
            return {"message": self.runtime.chat.message_view(conn, actor.id, row)}

    def context(self, actor, mid):
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            row, meta = self.runtime.access.message(conn, actor.id, mid)
            before = conn.execute(
                "SELECT * FROM messages WHERE conversation_id=? AND seq>=? AND seq<? "
                "ORDER BY seq DESC LIMIT 25",
                (row["conversation_id"], meta["minSeq"], row["seq"]),
            ).fetchall()
            after = conn.execute(
                "SELECT * FROM messages WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT 25",
                (row["conversation_id"], row["seq"]),
            ).fetchall()
            rows = [*reversed(before), row, *after]
            return {
                "conversation": self.runtime.chat.conversation_view(
                    conn, actor.id, row["conversation_id"]
                ),
                "items": [self.runtime.chat.message_view(conn, actor.id, item) for item in rows],
                "targetId": mid,
                "hasBefore": rows[0]["seq"] > meta["minSeq"],
                "hasAfter": rows[-1]["seq"] < meta["row"]["last_seq"],
            }

    def located(self, conn, actor_id, row, *, saved_at=None):
        result = {"id": row["id"], "available": False, "message": None, "conversation": None}
        if saved_at is not None:
            result["savedAt"] = saved_at
        try:
            _, meta = self.runtime.access.message(conn, actor_id, row["id"])
            if row["status"] != "sent":
                return result
            view = self.runtime.chat.conversation_view(conn, actor_id, row["conversation_id"])
            result.update(
                available=True,
                message=self.runtime.chat.message_view(conn, actor_id, row),
                conversation={
                    "id": view["id"],
                    "title": view["title"],
                    "kind": meta["row"]["kind"],
                },
            )
        except APIError as error:
            if error.status not in (403, 404):
                raise
        return result

    def search(self, actor, query, cid="", after="", limit=50):
        query = query.strip()
        if not 1 <= len(query) <= 200 or len(cid) > 80:
            raise APIError("VALIDATION_ERROR", "请输入1至200字的搜索内容。", 422)
        message_text(query, max_chars=200, max_bytes=1600)
        self.runtime.auth.security.rate("message-search", actor.id, 60, 60)
        boundary, last_id = activity_cursor(after)
        pattern = "%" + query.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%"
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            if cid:
                self.runtime.access.conversation(conn, actor.id, cid)
            deadline = time.monotonic() + 0.25
            conn.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
            try:
                rows = conn.execute(
                    "SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id "
                    "WHERE m.status='sent' AND m.kind='user' AND m.text LIKE ? ESCAPE '!' "
                    "AND (?='' OR m.conversation_id=?) "
                    "AND (?=0 OR m.created_at<? OR(m.created_at=? AND m.id<?)) "
                    "AND ((c.kind='direct' AND (c.low_id=? OR c.high_id=?)) OR "
                    "(c.kind='group' AND c.status<>'dissolved' AND EXISTS(SELECT 1 FROM memberships p "
                    "WHERE p.conversation_id=c.id AND p.user_id=? AND p.left_at IS NULL "
                    "AND m.seq>=p.visible_from_seq))) ORDER BY m.created_at DESC,m.id DESC LIMIT ?",
                    (
                        pattern,
                        cid,
                        cid,
                        boundary,
                        boundary,
                        boundary,
                        last_id,
                        actor.id,
                        actor.id,
                        actor.id,
                        limit + 1,
                    ),
                ).fetchall()
            except sqlite3.OperationalError as error:
                if str(error) == "interrupted":
                    raise APIError(
                        "SEARCH_TOO_BROAD", "搜索范围较大，请缩小关键词或选择具体会话。", 503
                    ) from error
                raise
            finally:
                conn.set_progress_handler(None, 0)
            return {
                "items": [self.located(conn, actor.id, row) for row in rows[:limit]],
                "nextCursor": f"{rows[limit - 1]['created_at']}:{rows[limit - 1]['id']}"
                if len(rows) > limit
                else None,
            }

    def bookmarks(self, actor, after="", limit=50):
        boundary, last_id = activity_cursor(after)
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            rows = conn.execute(
                "SELECT m.*,b.created_at AS saved_at FROM bookmarks b JOIN messages m ON m.id=b.message_id "
                "WHERE b.user_id=? AND (?=0 OR b.created_at<? OR(b.created_at=? AND b.message_id<?)) "
                "ORDER BY b.created_at DESC,b.message_id DESC LIMIT ?",
                (actor.id, boundary, boundary, boundary, last_id, limit + 1),
            ).fetchall()
            return {
                "items": [
                    self.located(conn, actor.id, row, saved_at=row["saved_at"])
                    for row in rows[:limit]
                ],
                "nextCursor": f"{rows[limit - 1]['saved_at']}:{rows[limit - 1]['id']}"
                if len(rows) > limit
                else None,
            }

    def bookmark(self, actor, mid, enabled):
        with self.runtime.db.write() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            if enabled:
                row, _ = self.runtime.access.message(conn, actor.id, mid)
                if row["status"] != "sent" or row["kind"] != "user":
                    raise APIError("RESOURCE_UNAVAILABLE", "这条消息已无法收藏。", 404)
                exists = conn.execute(
                    "SELECT 1 FROM bookmarks WHERE user_id=? AND message_id=?", (actor.id, mid)
                ).fetchone()
                if (
                    not exists
                    and conn.execute(
                        "SELECT COUNT(*) FROM bookmarks WHERE user_id=?", (actor.id,)
                    ).fetchone()[0]
                    >= 10000
                ):
                    raise APIError(
                        "BOOKMARK_LIMIT", "收藏已达到10000条，请先移除不需要的条目。", 409
                    )
                conn.execute(
                    "INSERT OR IGNORE INTO bookmarks VALUES(?,?,?)", (actor.id, mid, now_ms())
                )
            else:
                # Removal must remain possible after group access was revoked.
                conn.execute(
                    "DELETE FROM bookmarks WHERE user_id=? AND message_id=?", (actor.id, mid)
                )
            self.runtime.events.publish(conn, [actor.id], "bookmarks.updated", mid)
        return {"bookmarked": enabled}

    def reaction(self, actor, mid, key, enabled):
        require_emoji(key)
        self.runtime.auth.security.rate("reaction", actor.id, 120, 60)
        with self.runtime.db.write() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            row, _ = self.runtime.access.message(conn, actor.id, mid)
            self.runtime.access.conversation(conn, actor.id, row["conversation_id"], write=True)
            if row["status"] != "sent" or row["kind"] != "user":
                raise APIError("RESOURCE_UNAVAILABLE", "这条消息已无法回应。", 404)
            exists = conn.execute(
                "SELECT 1 FROM message_reactions WHERE message_id=? AND user_id=? AND emoji_key=?",
                (mid, actor.id, key),
            ).fetchone()
            changed = False
            if enabled and not exists:
                own_count = conn.execute(
                    "SELECT COUNT(*) FROM message_reactions WHERE message_id=? AND user_id=?",
                    (mid, actor.id),
                ).fetchone()[0]
                kinds = conn.execute(
                    "SELECT DISTINCT emoji_key FROM message_reactions WHERE message_id=?", (mid,)
                ).fetchall()
                if own_count >= 8 or len(kinds) >= 32 and key not in {item[0] for item in kinds}:
                    raise APIError(
                        "REACTION_LIMIT", "每人每条最多8种回应，每条消息最多32种表情。", 409
                    )
                conn.execute(
                    "INSERT INTO message_reactions VALUES(?,?,?,?)", (mid, actor.id, key, now_ms())
                )
                changed = True
            elif not enabled and exists:
                conn.execute(
                    "DELETE FROM message_reactions WHERE message_id=? AND user_id=? AND emoji_key=?",
                    (mid, actor.id, key),
                )
                changed = True
            if changed:
                self.runtime.events.publish(
                    conn,
                    self.runtime.access.recipients(conn, row["conversation_id"]),
                    "message.updated",
                    mid,
                    row["conversation_id"],
                )
            return {"message": self.runtime.chat.message_view(conn, actor.id, row)}

    def remove(self, actor, mid, *, moderation=False, reason=""):
        if moderation:
            reason = reason.strip()
            message_text(reason, max_chars=500, max_bytes=4000)
        self.runtime.auth.security.rate("message-remove", actor.id, 60, 60)
        with self.runtime.db.write() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            row, meta = self.runtime.access.message(conn, actor.id, mid)
            desired = "moderated" if moderation else "recalled"
            if not moderation and row["sender_id"] != actor.id:
                raise APIError("FORBIDDEN", "只能撤回本人发送的消息。", 403)
            if row["status"] == desired and row["removed_by"] == actor.id:
                return {"message": self.runtime.chat.message_view(conn, actor.id, row)}
            if row["kind"] != "user" or row["status"] != "sent":
                raise APIError("RESOURCE_UNAVAILABLE", "这条消息已无法执行该操作。", 404)
            if moderation:
                if not self.can_moderate(conn, actor.id, row, meta):
                    raise APIError("FORBIDDEN", "当前群角色无权处理该发送者的消息。", 403)
            elif (
                now_ms()
                > row["created_at"] + self.runtime.policy.get(conn)["recall_seconds"] * 1000
            ):
                raise APIError("RECALL_EXPIRED", "这条消息已超过两分钟撤回期限。", 409)
            conn.execute(
                "UPDATE messages SET status=?,removed_at=?,removed_by=?,removed_reason=? WHERE id=?",
                (desired, now_ms(), actor.id, reason if moderation else "sender_recall", mid),
            )
            audit(
                conn,
                actor.id,
                "group.message.moderate" if moderation else "message.recall",
                mid,
                details={"reason": reason, "conversationId": row["conversation_id"]},
            )
            self.runtime.events.publish(
                conn,
                self.runtime.access.recipients(conn, row["conversation_id"]),
                "message.updated",
                mid,
                row["conversation_id"],
            )
            updated = conn.execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone()
            return {"message": self.runtime.chat.message_view(conn, actor.id, updated)}

    def typing(self, actor, cid, active=None):
        with self.runtime.db.read() as conn:
            actor = self.runtime.auth.current_in_transaction(conn, actor)
            self.runtime.access.conversation(conn, actor.id, cid, write=active is not None)
            if active is not None:
                key = cid + ":" + actor.id
                if not active or json.loads(actor.user["preferences"]).get("invisible"):
                    self.typing_cache.delete(key)
                    return {"expiresAt": 0}
                previous = self.typing_cache.get(key)
                if self.typing_rate.get(key):
                    return {"expiresAt": previous["expiresAt"] if previous else 0}
                expiry = now_ms() + 5000
                self.typing_cache.set(key, {"expiresAt": expiry})
                self.typing_rate.set(key, True)
                return {"expiresAt": expiry}
            items = []
            for uid in self.runtime.access.recipients(conn, cid):
                if uid == actor.id:
                    continue
                hint = self.typing_cache.get(cid + ":" + uid)
                if not hint or hint["expiresAt"] <= now_ms():
                    continue
                user = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
                if user["status"] != "active" or json.loads(user["preferences"]).get("invisible"):
                    continue
                try:
                    self.runtime.access.conversation(conn, uid, cid, write=True)
                except APIError as error:
                    if error.status in (403, 404, 503):
                        continue
                    raise
                items.append(user_summary(user) | hint)
            return {"items": items}

    @staticmethod
    def report_view(row):
        return {
            "id": row["id"],
            "targetKind": row["target_kind"],
            "targetId": row["target_id"],
            "category": row["category"],
            "description": row["description"],
            "status": row["status"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "feedback": row["feedback"],
        }

    def report(self, actor, data):
        message_text(data.description, max_chars=1000, max_bytes=8000)
        self.runtime.auth.security.rate("report", actor.id, 20, 3600)
        payload_hash = hashlib.sha256(
            json.dumps(
                data.model_dump(exclude={"clientReportId"}), sort_keys=True, ensure_ascii=False
            ).encode()
        ).hexdigest()
        with self.runtime.db.write() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            old = conn.execute(
                "SELECT * FROM reports WHERE reporter_id=? AND client_report_id=?",
                (actor.id, data.clientReportId),
            ).fetchone()
            if old:
                if old["payload_hash"] != payload_hash:
                    raise APIError("IDEMPOTENCY_CONFLICT", "该举报标识已用于其他内容。", 409)
                return {"report": self.report_view(old), "duplicate": True}
            if data.targetKind == "message":
                self.runtime.access.message(conn, actor.id, data.targetId)
            elif data.targetKind == "group":
                meta = self.runtime.access.conversation(conn, actor.id, data.targetId)
                if meta["row"]["kind"] != "group":
                    raise APIError("RESOURCE_UNAVAILABLE", "举报对象不存在。", 404)
            else:
                target = conn.execute(
                    "SELECT status FROM users WHERE id=?", (data.targetId,)
                ).fetchone()
                if not target or target[0] == "deleted" or data.targetId == actor.id:
                    raise APIError("RESOURCE_UNAVAILABLE", "举报对象不存在。", 404)
            rid, timestamp = identifier("r_"), now_ms()
            conn.execute(
                "INSERT INTO reports(id,reporter_id,client_report_id,payload_hash,target_kind,target_id,category,description,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (
                    rid,
                    actor.id,
                    data.clientReportId,
                    payload_hash,
                    data.targetKind,
                    data.targetId,
                    data.category,
                    data.description,
                    timestamp,
                    timestamp,
                ),
            )
            conn.execute(
                "INSERT INTO report_events(report_id,actor_id,action,reason,created_at) VALUES(?,?,'created',?,?)",
                (rid, actor.id, data.description, timestamp),
            )
            self.runtime.events.publish(conn, [actor.id], "reports.updated", rid)
            for admin in conn.execute(
                "SELECT id FROM users WHERE status='active' AND site_role='super_admin'"
            ):
                self.runtime.events.notify(conn, admin[0], "report.created", rid, actor.id)
            return {
                "report": self.report_view(
                    conn.execute("SELECT * FROM reports WHERE id=?", (rid,)).fetchone()
                ),
                "duplicate": False,
            }

    def reports(self, actor, after="", limit=50):
        boundary, last_id = activity_cursor(after)
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            rows = conn.execute(
                "SELECT * FROM reports WHERE reporter_id=? AND (?=0 OR created_at<? OR(created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?",
                (actor.id, boundary, boundary, boundary, last_id, limit + 1),
            ).fetchall()
            return {
                "items": [self.report_view(row) for row in rows[:limit]],
                "nextCursor": f"{rows[limit - 1]['created_at']}:{rows[limit - 1]['id']}"
                if len(rows) > limit
                else None,
            }
