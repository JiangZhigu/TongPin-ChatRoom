from __future__ import annotations

import json

from tongpin.contracts.base import APIError
from tongpin.contracts.chat import MessageInput
from tongpin.contracts.tasks import TaskCreate
from tongpin.tasks.policy import canonical, unavailable

NEUTRAL_CARD = "待办卡片（请使用支持待办的客户端查看）"


class TaskSharing:
    def share_access(self, conn, actor, row, data):
        self.write_allowed(conn, actor.id, row["group_id"])
        if row["deleted_at"] is not None:
            raise unavailable()
        destination = self.runtime.access.conversation(
            conn, actor.id, data.destinationConversationId, write=True
        )
        if data.mode == "snapshot":
            self.require(row["scope"] == "personal" and row["owner_id"] == actor.id)
        else:
            self.require(row["scope"] == "group")
            if destination["row"]["kind"] == "group":
                self.require(destination["row"]["id"] == row["group_id"])
            else:
                other = (
                    destination["row"]["high_id"]
                    if destination["row"]["low_id"] == actor.id
                    else destination["row"]["low_id"]
                )
                self.group_meta(conn, other, row["group_id"])
        return destination

    def share(self, actor, task_id, data, key, etag):
        self.runtime.auth.security.rate("message-send", actor.id, 120, 60)
        with self.runtime.db.write() as conn:
            actor = self.current(conn, actor)
            row, _, _, _ = self.task_access(conn, actor.id, task_id)
            destination = self.share_access(conn, actor, row, data)
            old, digest = self.key_lookup(
                conn, actor.id, key, "share:" + task_id, data.model_dump()
            )
            if old:
                message, _ = self.runtime.access.message(conn, actor.id, old["result_ref"])
                return {
                    "messageId": message["id"],
                    "conversationId": message["conversation_id"],
                    "duplicate": True,
                }
            self.check_version(self.view_in(conn, actor.id, task_id), etag)
            result = self.runtime.chat.send_in(
                conn,
                actor,
                data.destinationConversationId,
                MessageInput(
                    clientMessageId=key,
                    text=NEUTRAL_CARD,
                    accessKey=destination["accessKey"],
                    actorContext=actor.id,
                ),
            )
            mid = result["message"]["id"]
            snapshot = None
            if data.mode == "snapshot":
                snapshot = {
                    "title": row["title"],
                    "priority": row["priority"],
                    "dueOn": row["due_on"],
                    "dueTimezone": row["due_timezone"],
                }
                if data.includeDescription:
                    snapshot["description"] = row["description"]
            conn.execute(
                "INSERT INTO todo_message_cards(message_id,kind,task_id,snapshot_json) VALUES(?,?,?,?)",
                (
                    mid,
                    data.mode,
                    task_id if data.mode == "live" else None,
                    canonical(snapshot) if snapshot is not None else None,
                ),
            )
            self.key_store(conn, actor.id, key, digest, "message", mid)
            result = {
                "messageId": mid,
                "conversationId": data.destinationConversationId,
                "duplicate": False,
            }
        return result

    def card_in(self, conn, actor_id, message_id):
        message, _ = self.runtime.access.message(conn, actor_id, message_id)
        if message["status"] != "sent" or not self.runtime.settings.feature_tasks:
            return {"kind": "unavailable"}
        row = conn.execute(
            "SELECT * FROM todo_message_cards WHERE message_id=?", (message_id,)
        ).fetchone()
        if not row:
            return {"kind": "unavailable"}
        if row["kind"] == "snapshot":
            return {"kind": "snapshot", "snapshot": json.loads(row["snapshot_json"])}
        try:
            task = self.view_in(conn, actor_id, row["task_id"])
            if task["deletedAt"] is not None:
                return {"kind": "unavailable"}
            return {"kind": "live", "task": task}
        except APIError as error:
            if error.status not in (403, 404):
                raise
            return {"kind": "unavailable"}

    def card(self, actor, message_id):
        with self.runtime.db.read() as conn:
            actor = self.runtime.auth.current_in_transaction(conn, actor)
            return self.card_in(conn, actor.id, message_id)

    def copy_to_group(self, actor, task_id, data, key, etag):
        self.runtime.auth.security.rate("task-write", actor.id, 120, 60)
        with self.runtime.db.write() as conn:
            actor = self.current(conn, actor)
            row, _, _, _ = self.task_access(conn, actor.id, task_id)
            self.require(row["scope"] == "personal" and row["owner_id"] == actor.id)
            self.write_allowed(conn, actor.id)
            if row["deleted_at"] is not None:
                raise unavailable()
            payload = TaskCreate.model_validate(
                {
                    key: value
                    for key, value in data.model_dump().items()
                    if key != "acknowledgeShared"
                }
                | {"scope": "group"}
            )
            self.require_creation(conn, actor, payload)
            old, digest = self.key_lookup(conn, actor.id, key, "copy:" + task_id, data.model_dump())
            if old:
                return self.replay_task(conn, actor.id, old)
            self.check_version(self.view_in(conn, actor.id, task_id), etag)
            tid = self.create_in(conn, actor, payload)
            self.key_store(conn, actor.id, key, digest, "task", tid)
            result = {"task": self.view_in(conn, actor.id, tid), "duplicate": False}
        return result
