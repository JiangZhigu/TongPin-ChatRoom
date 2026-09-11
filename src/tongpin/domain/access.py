from __future__ import annotations

import json

from tongpin.contracts.base import APIError
from tongpin.infra.db import now_ms


def user_summary(row):
    return {
        "id": row["id"],
        "username": row["username"],
        "nickname": "已注销用户" if row["status"] == "deleted" else row["nickname"],
        "avatarUrl": "/api/v1/users/" + row["id"] + "/avatar?v=" + row["avatar_id"] if row["avatar_id"] and row["status"] == "active" else None,
    }


def pair(one, two):
    return tuple(sorted((one, two)))


def friendship(conn, one, two):
    return conn.execute(
        "SELECT * FROM friendships WHERE low_id=? AND high_id=?", pair(one, two)
    ).fetchone()


def blocked(conn, one, two):
    return (
        conn.execute(
            "SELECT 1 FROM blocks WHERE (user_id=? AND target_id=?) OR (user_id=? AND target_id=?) LIMIT 1",
            (one, two, two, one),
        ).fetchone()
        is not None
    )


class AccessPolicy:
    def __init__(self, runtime):
        self.runtime = runtime

    def direct_write(self, conn, actor_id, other_id):
        relation = friendship(conn, actor_id, other_id)
        other = conn.execute("SELECT status FROM users WHERE id=?", (other_id,)).fetchone()
        if not relation:
            raise APIError(
                "FRIENDSHIP_REQUIRED", "成为好友后才能发送新消息，已有历史仍可查看。", 403
            )
        if not other or other["status"] != "active" or blocked(conn, actor_id, other_id):
            raise APIError("CONTACT_UNAVAILABLE", "当前无法向此联系人发送消息。", 403)
        return relation

    def conversation(self, conn, actor_id, cid, *, write=False):
        row = conn.execute("SELECT * FROM conversations WHERE id=?", (cid,)).fetchone()
        if not row:
            raise APIError("RESOURCE_UNAVAILABLE", "会话不存在或已无法访问。", 404)
        meta = {
            "row": row,
            "minSeq": 1,
            "role": "member",
            "periodId": None,
            "accessKey": "unavailable",
        }
        if row["kind"] == "direct":
            if actor_id not in (row["low_id"], row["high_id"]):
                raise APIError("RESOURCE_UNAVAILABLE", "会话不存在或已无法访问。", 404)
            other_id = row["high_id"] if actor_id == row["low_id"] else row["low_id"]
            relation = (
                self.direct_write(conn, actor_id, other_id)
                if write
                else friendship(conn, actor_id, other_id)
            )
            if relation:
                meta["accessKey"] = relation["id"] + ":" + str(relation["version"])
        else:
            membership = conn.execute(
                "SELECT * FROM memberships WHERE conversation_id=? AND user_id=? AND left_at IS NULL",
                (cid, actor_id),
            ).fetchone()
            if not membership or row["status"] == "dissolved":
                raise APIError("RESOURCE_UNAVAILABLE", "会话不存在或已无法访问。", 404)
            meta.update(
                minSeq=membership["visible_from_seq"],
                role=membership["role"],
                periodId=membership["id"],
                membership=membership,
            )
            meta["accessKey"] = (
                f"{membership['id']}:{membership['write_version']}:{row['write_version']}"
            )
            if write and (
                (membership["muted_until"] or 0) > now_ms()
                or row["everyone_muted"]
                and membership["role"] == "member"
            ):
                raise APIError("MUTED", "当前处于禁言状态，草稿将为你保留。", 403)
        if write:
            user = conn.execute("SELECT muted_until,mute_reason FROM users WHERE id=?", (actor_id,)).fetchone()
            if (user["muted_until"] or 0) > now_ms():
                raise APIError("MUTED", "账号当前被限制发送消息。" + ("原因：" + user['mute_reason'] if user['mute_reason'] else ''), 403)
            if row["status"] != "active":
                raise APIError("CONVERSATION_FROZEN", "会话当前已暂停发送。", 403)
            if self.runtime.policy.get(conn)["maintenance"]:
                raise APIError("MAINTENANCE", "服务维护中，暂时无法发送。", 503)
        return meta

    def message(self, conn, actor_id, mid):
        row = conn.execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone()
        if not row:
            raise APIError("RESOURCE_UNAVAILABLE", "消息不存在或已无法访问。", 404)
        meta = self.conversation(conn, actor_id, row["conversation_id"])
        if row["seq"] < meta["minSeq"]:
            raise APIError("RESOURCE_UNAVAILABLE", "消息不存在或已无法访问。", 404)
        return row, meta

    def recipients(self, conn, cid):
        row = conn.execute("SELECT * FROM conversations WHERE id=?", (cid,)).fetchone()
        if row["kind"] == "direct":
            return [row["low_id"], row["high_id"]]
        return [
            item[0]
            for item in conn.execute(
                "SELECT user_id FROM memberships WHERE conversation_id=? AND left_at IS NULL",
                (cid,),
            )
        ]

    def presence(self, conn, viewer, target):
        if viewer == target:
            return self.runtime.is_connected(target)
        if not friendship(conn, viewer, target) or blocked(conn, viewer, target):
            return False
        user = conn.execute("SELECT status,preferences FROM users WHERE id=?", (target,)).fetchone()
        return bool(
            user
            and user["status"] == "active"
            and not json.loads(user["preferences"]).get("invisible")
            and self.runtime.is_connected(target)
        )
