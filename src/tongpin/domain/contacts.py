from __future__ import annotations

from tongpin.contracts.base import APIError
from tongpin.contracts.chat import message_text
from tongpin.domain.access import blocked, friendship, pair, user_summary
from tongpin.domain.chat import activity_cursor, next_activity
from tongpin.domain.security import identifier
from tongpin.infra.db import now_ms


class ContactService:
    def __init__(self, runtime):
        self.runtime = runtime

    def summary(self, conn, actor_id, user):
        result = user_summary(user)
        relation = friendship(conn, actor_id, user["id"])
        pending = conn.execute(
            "SELECT * FROM friend_requests WHERE low_id=? AND high_id=? AND status='pending'",
            pair(actor_id, user["id"]),
        ).fetchone()
        preferences = conn.execute(
            "SELECT notify_online,remark FROM friend_preferences WHERE user_id=? AND friend_id=?",
            (actor_id, user["id"]),
        ).fetchone()
        own_block = conn.execute(
            "SELECT 1 FROM blocks WHERE user_id=? AND target_id=?", (actor_id, user["id"])
        ).fetchone()
        result.update(
            relationship="self"
            if actor_id == user["id"]
            else "friend"
            if relation
            else "outgoing"
            if pending and pending["sender_id"] == actor_id
            else "incoming"
            if pending
            else "none",
            requestId=pending["id"] if pending else None,
            notifyOnline=bool(preferences and preferences[0]),
            remark=preferences["remark"] if preferences else "",
            blocked=bool(own_block),
            online=self.runtime.access.presence(conn, actor_id, user["id"]),
        )
        return result

    def search(self, actor, query, after="", limit=50):
        query = query.strip().lower()
        if not 3 <= len(query) <= 24 or any(
            char not in "abcdefghijklmnopqrstuvwxyz0123456789_" for char in query
        ):
            raise APIError("VALIDATION_ERROR", "请输入至少3位登录名进行查找。", 422)
        self.runtime.auth.security.rate("user-search", actor.id, 60, 60)
        escaped = query.replace("_", "!_") + "%"
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            rows = conn.execute(
                "SELECT * FROM users WHERE status='active' AND username LIKE ? ESCAPE '!' AND id>? ORDER BY id LIMIT ?",
                (escaped, after, limit + 1),
            ).fetchall()
            return {
                "items": [self.summary(conn, actor.id, row) for row in rows[:limit]],
                "nextCursor": rows[limit - 1]["id"] if len(rows) > limit else None,
            }

    def list_in(self, conn, actor_id, after="", limit=50):
        rows = conn.execute(
            "SELECT u.* FROM users u JOIN friendships f ON (f.low_id=? AND f.high_id=u.id) OR (f.high_id=? AND f.low_id=u.id) WHERE u.id>? ORDER BY u.id LIMIT ?",
            (actor_id, actor_id, after, limit + 1),
        ).fetchall()
        return {
            "items": [self.summary(conn, actor_id, row) for row in rows[:limit]],
            "nextCursor": rows[limit - 1]["id"] if len(rows) > limit else None,
        }

    def list(self, actor, after="", limit=50):
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            return self.list_in(conn, actor.id, after, limit)

    def request_view(self, conn, actor_id, row):
        users = {
            uid: user_summary(conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())
            for uid in (row["sender_id"], row["target_id"])
        }
        return {
            "id": row["id"],
            "sender": users[row["sender_id"]],
            "target": users[row["target_id"]],
            "direction": "outgoing" if actor_id == row["sender_id"] else "incoming",
            "note": row["note"],
            "status": row["status"],
            "createdAt": row["created_at"],
        }

    def requests_in(self, conn, actor_id, after="", limit=50):
        boundary, last_id = activity_cursor(after)
        rows = conn.execute(
            "SELECT * FROM friend_requests WHERE (sender_id=? OR target_id=?) AND (?=0 OR created_at<? OR(created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?",
            (actor_id, actor_id, boundary, boundary, boundary, last_id, limit + 1),
        ).fetchall()
        return {
            "items": [self.request_view(conn, actor_id, row) for row in rows[:limit]],
            "nextCursor": next_activity(rows, limit),
        }

    def requests(self, actor, after="", limit=50):
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            return self.requests_in(conn, actor.id, after, limit)

    def _changed(self, conn, one, two):
        self.runtime.events.publish(conn, [one], "contacts.changed", two)
        self.runtime.events.publish(conn, [two], "contacts.changed", one)
        dm = conn.execute(
            "SELECT id FROM conversations WHERE kind='direct' AND low_id=? AND high_id=?",
            pair(one, two),
        ).fetchone()
        if dm:
            self.runtime.events.publish(
                conn, [one, two], "conversation.updated", dm["id"], dm["id"]
            )

    def _accept(self, conn, row):
        for uid in (row["sender_id"], row["target_id"]):
            user = conn.execute("SELECT status FROM users WHERE id=?", (uid,)).fetchone()
            if not user or user[0] != "active":
                raise APIError("CONTACT_UNAVAILABLE", "当前无法完成此好友操作。", 403)
        if blocked(conn, row["sender_id"], row["target_id"]):
            raise APIError("CONTACT_UNAVAILABLE", "当前无法完成此好友操作。", 403)
        conn.execute(
            "INSERT OR IGNORE INTO friendships(low_id,high_id,id,created_at) VALUES(?,?,?,?)",
            (row["low_id"], row["high_id"], identifier("f_"), now_ms()),
        )
        conn.execute(
            "UPDATE friend_requests SET status='accepted',updated_at=? WHERE id=?",
            (now_ms(), row["id"]),
        )
        self.runtime.events.notify(
            conn, row["sender_id"], "friend.accepted", row["id"], row["target_id"]
        )

    def request(self, actor, data):
        self.runtime.auth.security.rate("friend-request", actor.id, 30, 600)
        note = message_text(data.note, max_chars=200, max_bytes=800, allow_empty=True)
        target_id = data.targetUserId
        if target_id == actor.id:
            raise APIError("VALIDATION_ERROR", "不能向自己发送好友申请。", 422)
        with self.runtime.db.write() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            target = conn.execute(
                "SELECT * FROM users WHERE id=? AND status='active'", (target_id,)
            ).fetchone()
            if not target or blocked(conn, actor.id, target_id):
                raise APIError("CONTACT_UNAVAILABLE", "当前无法向此联系人发送申请。", 403)
            if friendship(conn, actor.id, target_id):
                return {"status": "friends", "request": None}
            row = conn.execute(
                "SELECT * FROM friend_requests WHERE low_id=? AND high_id=? AND status='pending'",
                pair(actor.id, target_id),
            ).fetchone()
            if row and row["target_id"] == actor.id:
                self._accept(conn, row)
            elif not row:
                rid = identifier("fr_")
                conn.execute(
                    "INSERT INTO friend_requests VALUES(?,?,?,?,?,?,'pending',?,?)",
                    (
                        rid,
                        actor.id,
                        target_id,
                        *pair(actor.id, target_id),
                        note,
                        now_ms(),
                        now_ms(),
                    ),
                )
                row = conn.execute("SELECT * FROM friend_requests WHERE id=?", (rid,)).fetchone()
                self.runtime.events.notify(conn, target_id, "friend.requested", rid, actor.id)
            self._changed(conn, actor.id, target_id)
            current = conn.execute(
                "SELECT * FROM friend_requests WHERE id=?", (row["id"],)
            ).fetchone()
            return {
                "status": current["status"],
                "request": self.request_view(conn, actor.id, current),
            }

    def decide(self, actor, rid, action):
        expected = {"accept": "accepted", "reject": "rejected", "cancel": "cancelled"}[action]
        with self.runtime.db.write() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            row = conn.execute(
                "SELECT * FROM friend_requests WHERE id=? AND (sender_id=? OR target_id=?)",
                (rid, actor.id, actor.id),
            ).fetchone()
            if not row:
                raise APIError("RESOURCE_UNAVAILABLE", "好友申请不存在。", 404)
            allowed = row["sender_id"] if action == "cancel" else row["target_id"]
            if actor.id != allowed:
                raise APIError("FORBIDDEN", "无权处理此申请。", 403)
            if row["status"] == expected:
                return self.request_view(conn, actor.id, row)
            if row["status"] != "pending":
                raise APIError("STATE_CONFLICT", "此申请已处理，请刷新列表。", 409)
            if action == "accept":
                self._accept(conn, row)
            else:
                conn.execute(
                    "UPDATE friend_requests SET status=?,updated_at=? WHERE id=?",
                    (expected, now_ms(), rid),
                )
            self._changed(conn, row["sender_id"], row["target_id"])
            return self.request_view(
                conn,
                actor.id,
                conn.execute("SELECT * FROM friend_requests WHERE id=?", (rid,)).fetchone(),
            )

    def remove(self, actor, uid):
        with self.runtime.db.write() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            conn.execute(
                "DELETE FROM friendships WHERE low_id=? AND high_id=?", pair(actor.id, uid)
            )
            conn.execute(
                "DELETE FROM friend_preferences WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)",
                (actor.id, uid, uid, actor.id),
            )
            if (
                conn.execute("SELECT 1 FROM users WHERE id=?", (uid,)).fetchone()
                and uid != actor.id
            ):
                self._changed(conn, actor.id, uid)
        return {"removed": True}

    def set_block(self, actor, uid, value):
        with self.runtime.db.write() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            if (
                uid == actor.id
                or not conn.execute("SELECT 1 FROM users WHERE id=?", (uid,)).fetchone()
            ):
                raise APIError("RESOURCE_UNAVAILABLE", "联系人不存在。", 404)
            if value:
                changed = conn.execute(
                    "INSERT OR IGNORE INTO blocks VALUES(?,?,?)", (actor.id, uid, now_ms())
                ).rowcount
                conn.execute(
                    "UPDATE friend_requests SET status='cancelled',updated_at=? WHERE low_id=? AND high_id=? AND status='pending'",
                    (now_ms(), *pair(actor.id, uid)),
                )
            else:
                changed = conn.execute(
                    "DELETE FROM blocks WHERE user_id=? AND target_id=?", (actor.id, uid)
                ).rowcount
            if changed:
                conn.execute(
                    "UPDATE friendships SET version=version+1 WHERE low_id=? AND high_id=?",
                    pair(actor.id, uid),
                )
                self._changed(conn, actor.id, uid)
        return {"blocked": value}

    def blocks(self, actor, after="", limit=50):
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            rows = conn.execute(
                "SELECT u.* FROM users u JOIN blocks b ON b.target_id=u.id WHERE b.user_id=? AND u.id>? ORDER BY u.id LIMIT ?",
                (actor.id, after, limit + 1),
            ).fetchall()
            return {
                "items": [self.summary(conn, actor.id, row) for row in rows[:limit]],
                "nextCursor": rows[limit - 1]["id"] if len(rows) > limit else None,
            }

    def preferences(self, actor, uid, data):
        values = data.model_dump(exclude_unset=True, exclude_none=True)
        if not values:
            raise APIError("VALIDATION_ERROR", "请选择需要修改的好友设置。", 422)
        if "remark" in values:
            values["remark"] = values["remark"].strip()
            message_text(values["remark"], max_chars=80, max_bytes=640, allow_empty=True)
        with self.runtime.db.write() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            if not friendship(conn, actor.id, uid):
                raise APIError("FRIENDSHIP_REQUIRED", "只有好友可以设置备注和上线提醒。", 403)
            conn.execute(
                "INSERT OR IGNORE INTO friend_preferences(user_id,friend_id) VALUES(?,?)",
                (actor.id, uid),
            )
            if "notifyOnline" in values:
                conn.execute("UPDATE friend_preferences SET notify_online=? WHERE user_id=? AND friend_id=?", (int(values["notifyOnline"]), actor.id, uid))
            if "remark" in values:
                conn.execute("UPDATE friend_preferences SET remark=? WHERE user_id=? AND friend_id=?", (values["remark"], actor.id, uid))
            self.runtime.events.publish(conn, [actor.id], "contacts.changed", uid)
            direct = conn.execute("SELECT id FROM conversations WHERE kind='direct' AND low_id=? AND high_id=?", pair(actor.id, uid)).fetchone()
            if direct:
                self.runtime.events.publish(conn, [actor.id], "conversation.updated", direct[0], direct[0])
            row = conn.execute("SELECT notify_online,remark FROM friend_preferences WHERE user_id=? AND friend_id=?", (actor.id, uid)).fetchone()
            return {"notifyOnline": bool(row["notify_online"]), "remark": row["remark"]}
