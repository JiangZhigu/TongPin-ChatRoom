from __future__ import annotations

from tongpin.contracts.base import APIError
from tongpin.contracts.chat import sequence
from tongpin.domain.chat import activity_cursor, next_activity
from tongpin.domain.security import identifier
from tongpin.infra.db import now_ms


class EventService:
    def __init__(self, runtime):
        self.runtime = runtime

    def publish(self, conn, recipients, kind, ref, cid=None):
        users = sorted(set(recipients))
        if not users:
            return
        for uid in users:
            conn.execute(
                "INSERT INTO user_events(user_id,kind,entity_ref,conversation_id,created_at) VALUES(?,?,?,?,?)",
                (uid, kind, ref, cid, now_ms()),
            )
        # The notification hint and data change commit together. Delivery may retry.
        self.runtime.jobs.enqueue_in_transaction(conn, "events.dispatch", {"userIds": users})

    def notify(self, conn, user_id, kind, ref, actor_id=None):
        nid = identifier("n_")
        conn.execute(
            "INSERT INTO notifications(id,user_id,kind,entity_ref,actor_id,created_at) VALUES(?,?,?,?,?,?)",
            (nid, user_id, kind, ref, actor_id, now_ms()),
        )
        self.publish(conn, [user_id], "notification.created", nid)

    def user_changed(self, conn, uid):
        friends = conn.execute(
            "SELECT low_id,high_id FROM friendships WHERE low_id=? OR high_id=?", (uid, uid)
        ).fetchall()
        self.publish(conn, [uid], "account.changed", uid)
        for relation in friends:
            other = relation["high_id"] if relation["low_id"] == uid else relation["low_id"]
            self.publish(conn, [other], "contacts.changed", uid)
        rows = conn.execute(
            "SELECT id FROM conversations c WHERE (kind='direct' AND (low_id=? OR high_id=?)) OR (kind='group' AND EXISTS(SELECT 1 FROM memberships m WHERE m.conversation_id=c.id AND m.user_id=? AND m.left_at IS NULL))",
            (uid, uid, uid),
        ).fetchall()
        for row in rows:
            self.publish(
                conn,
                self.runtime.access.recipients(conn, row["id"]),
                "conversation.updated",
                row["id"],
                row["id"],
            )

    @staticmethod
    def high_watermark(conn):
        row = conn.execute("SELECT seq FROM sqlite_sequence WHERE name='user_events'").fetchone()
        return row[0] if row else 0

    def materialize(self, conn, actor, row):
        event = {
            "v": 1,
            "eventId": str(row["id"]),
            "cursor": str(row["id"]),
            "type": row["kind"],
            "entityRef": row["entity_ref"],
            "occurredAt": row["created_at"],
            "conversationId": row["conversation_id"],
        }
        if row["conversation_id"]:
            try:
                event["conversation"] = self.runtime.chat.conversation_view(
                    conn, actor.id, row["conversation_id"]
                )
                if row['kind'] == 'access.revoked':
                    # The recipient has a new valid membership now; an old revocation
                    # is a synchronization hint, not authority to close that new period.
                    event['type'] = 'conversation.updated'
                if row["kind"].startswith("message."):
                    try:
                        message, _ = self.runtime.access.message(conn, actor.id, row["entity_ref"])
                        event["message"] = self.runtime.chat.message_view(conn, actor.id, message)
                    except APIError as error:
                        if error.status not in (403, 404):
                            raise
                        # Rejoining may retain events from an older membership period.
                        # An inaccessible old message must not revoke the current group.
                        event["type"] = "message.unavailable"
            except APIError as error:
                if error.status not in (403, 404):
                    raise
                event["type"] = "access.revoked"
                event.pop("conversation", None)
        return event

    def sync(self, actor, after, limit=100):
        cursor = sequence(after)
        with self.runtime.db.read() as conn:
            actor = self.runtime.auth.current_in_transaction(conn, actor)
            floor = int(
                conn.execute(
                    "SELECT value FROM instance_metadata WHERE key='event_floor'"
                ).fetchone()[0]
            )
            high = self.high_watermark(conn)
            if cursor < floor or cursor > high:
                raise APIError("RESYNC_REQUIRED", "同步记录已更新，请重新获取当前可访问内容。", 410)
            rows = conn.execute(
                "SELECT * FROM user_events WHERE user_id=? AND id>? AND id<=? ORDER BY id LIMIT ?",
                (actor.id, cursor, high, limit + 1),
            ).fetchall()
            more = len(rows) > limit
            page = rows[:limit]
            return {
                "items": [self.materialize(conn, actor, row) for row in page],
                "cursor": str(page[-1]["id"] if more else high),
                "highWatermark": str(high),
                "hasMore": more,
            }

    def snapshot(self, actor):
        with self.runtime.db.read() as conn:
            actor = self.runtime.auth.current_in_transaction(conn, actor)
            # All first pages and this high watermark use one SQLite read snapshot.
            return {
                "cursor": str(self.high_watermark(conn)),
                "contacts": self.runtime.contacts.list_in(conn, actor.id, limit=100),
                "conversations": self.runtime.chat.list_in(conn, actor.id, limit=100),
                "requests": self.runtime.contacts.requests_in(conn, actor.id, limit=100),
                "policy": {
                    "messageCodepoints": 4000,
                    "messageBytes": 16384,
                    "outboxCount": 100,
                    "outboxDays": 7,
                },
            }

    def notifications(self, actor, before="", limit=50):
        boundary, last_id = activity_cursor(before)
        with self.runtime.db.read() as conn:
            actor = self.runtime.auth.current_in_transaction(conn, actor)
            rows = conn.execute(
                "SELECT * FROM notifications WHERE user_id=? AND (?=0 OR created_at<? OR(created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?",
                (actor.id, boundary, boundary, boundary, last_id, limit + 1),
            ).fetchall()
            items = []
            for row in rows[:limit]:
                item = {
                    "id": row["id"],
                    "type": row["kind"],
                    "entityRef": row["entity_ref"],
                    "createdAt": row["created_at"],
                    "readAt": row["read_at"],
                    "text": "状态已更新，请查看相关列表。",
                }
                if row["kind"] in ("friend.requested", "friend.accepted"):
                    request = conn.execute(
                        "SELECT * FROM friend_requests WHERE id=? AND (sender_id=? OR target_id=?)",
                        (row["entity_ref"], actor.id, actor.id),
                    ).fetchone()
                    if request:
                        item["request"] = self.runtime.contacts.request_view(
                            conn, actor.id, request
                        )
                        item["text"] = (
                            "收到新的好友申请"
                            if row["kind"] == "friend.requested"
                            else "好友申请已通过"
                        )
                elif row["kind"] == "message.mentioned":
                    item.update(text="你被提及的消息已不可用", available=False)
                    try:
                        message, _ = self.runtime.access.message(conn, actor.id, row["entity_ref"])
                        if message["status"] == "sent":
                            item.update(text="有人在消息中提及了你", available=True, messageId=message["id"], conversationId=message["conversation_id"])
                    except APIError as error:
                        if error.status not in (403, 404):
                            raise
                elif row["kind"] == "report.updated":
                    report = conn.execute("SELECT id,feedback FROM reports WHERE id=? AND reporter_id=?", (row["entity_ref"], actor.id)).fetchone()
                    if report:
                        item.update(text="你的举报有新的处理结果", reportId=report["id"])
                elif row['kind'] == 'account.restriction':
                    item['text'] = '账号权限或设备会话已由全站管理员更新，请在账号与安全中核对。'
                elif row['kind'] == 'admin.alert':
                    item['text'] = '管理告警已更新。'
                    try:
                        self.runtime.auth.require_admin(actor)
                    except APIError:
                        item['text'] = '此管理通知当前不可访问。'
                    else:
                        alert = conn.execute('SELECT title,status FROM admin_alerts WHERE id=?', (row['entity_ref'],)).fetchone()
                        if alert:
                            item['text'] = alert['title'] + ('（已恢复）' if alert['status'] == 'resolved' else '，请查看运行监控。')
                elif row["kind"] == "report.created":
                    if actor.user["site_role"] == "super_admin":
                        item.update(text="收到新的治理举报，请进入全站后台处理", reportId=row["entity_ref"])
                elif row["kind"].startswith("group."):
                    labels = {
                        "group.invited": "收到群聊邀请，请查看群邀请",
                        "group.application": "收到新的入群申请",
                        "group.application.updated": "入群申请状态已更新",
                        "group.transfer": "收到群主转让，请打开群详情确认",
                        "group.transfer.updated": "群主转让状态已更新",
                    }
                    item["text"] = labels.get(row["kind"], "群聊状态已更新")
                    cid = None
                    if row["kind"] == "group.invited":
                        ref = conn.execute(
                            "SELECT conversation_id FROM group_invites WHERE id=? AND target_id=?",
                            (row["entity_ref"], actor.id),
                        ).fetchone()
                        cid = ref[0] if ref else None
                    elif row["kind"].startswith("group.application"):
                        ref = conn.execute(
                            "SELECT conversation_id,user_id FROM group_applications WHERE id=?",
                            (row["entity_ref"],),
                        ).fetchone()
                        if ref and (
                            ref["user_id"] == actor.id
                            or conn.execute(
                                "SELECT 1 FROM memberships WHERE conversation_id=? AND user_id=? AND left_at IS NULL AND role IN('owner','admin')",
                                (ref["conversation_id"], actor.id),
                            ).fetchone()
                        ):
                            cid = ref["conversation_id"]
                    elif row["kind"].startswith("group.transfer"):
                        if conn.execute(
                            "SELECT 1 FROM memberships WHERE conversation_id=? AND user_id=? AND left_at IS NULL",
                            (row["entity_ref"], actor.id),
                        ).fetchone():
                            cid = row["entity_ref"]
                    if cid:
                        group = conn.execute(
                            "SELECT name FROM conversations WHERE id=?", (cid,)
                        ).fetchone()
                        item.update(conversationId=cid, groupName=group["name"])
                items.append(item)
            unread = conn.execute(
                "SELECT COUNT(*) FROM notifications WHERE user_id=? AND read_at IS NULL",
                (actor.id,),
            ).fetchone()[0]
            return {"items": items, "nextCursor": next_activity(rows, limit), "unreadCount": unread}

    def read_notification(self, actor, nid):
        with self.runtime.db.write() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            row = conn.execute(
                "SELECT 1 FROM notifications WHERE id=? AND user_id=?", (nid, actor.id)
            ).fetchone()
            if not row:
                raise APIError("RESOURCE_UNAVAILABLE", "通知不存在。", 404)
            conn.execute(
                "UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND user_id=?",
                (now_ms(), nid, actor.id),
            )
            self.publish(conn, [actor.id], "notification.updated", nid)
        return {"id": nid, "read": True}
