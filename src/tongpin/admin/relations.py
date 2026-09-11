from __future__ import annotations

from tongpin.admin.authz import conflict, cursor, identity, page, unavailable
from tongpin.contracts.base import APIError
from tongpin.infra.db import now_ms


class RelationsAdmin:
    def relations(self, actor, *, kind="friendship", query="", status="", after="", limit=50):
        definitions = {
            "friendship": ("friendships", "id", "low_id", "high_id"),
            "request": ("friend_requests", "id", "sender_id", "target_id"),
            "block": ("blocks", "user_id||':'||target_id", "user_id", "target_id"),
            "direct": ("conversations", "id", "low_id", "high_id"),
        }
        if (
            kind not in definitions
            or len(query) > 80
            or status
            not in (
                "",
                "active",
                "frozen",
                "pending",
                "accepted",
                "rejected",
                "cancelled",
                "blocked",
            )
        ):
            raise APIError("VALIDATION_ERROR", "关系筛选无效。", 422)
        table, id_field, one, two = definitions[kind]
        where, args = ["kind='direct'"] if kind == "direct" else ["1=1"], []
        if status:
            if kind in ("request", "direct"):
                where.append("status=?")
                args.append(status)
            elif status != ("active" if kind == "friendship" else "blocked"):
                where.append("0=1")
        if query:
            where.append(
                f"EXISTS(SELECT 1 FROM users u WHERE u.id IN({table}.{one},{table}.{two}) AND (instr(lower(u.username),lower(?))>0 OR instr(u.nickname,?)>0))"
            )
            args += [query, query]
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            clause = " AND ".join(where)
            total = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE {clause}", args).fetchone()[0]
            marker = cursor(after)
            if marker:
                clause += f" AND ({id_field})>?"
                args += marker
            rows = conn.execute(
                f"SELECT *,({id_field}) AS row_id FROM {table} WHERE {clause} ORDER BY row_id LIMIT ?",
                [*args, limit + 1],
            ).fetchall()

            def convert(row):
                dm = conn.execute(
                    "SELECT id FROM conversations WHERE kind='direct' AND low_id=? AND high_id=?",
                    sorted([row[one], row[two]]),
                ).fetchone()
                return {
                    "id": row["row_id"],
                    "kind": kind,
                    "users": [identity(conn, row[one]), identity(conn, row[two])],
                    "status": row["status"]
                    if kind in ("request", "direct")
                    else ("active" if kind == "friendship" else "blocked"),
                    "createdAt": row["created_at"],
                    "updatedAt": row["updated_at"]
                    if kind in ("request", "direct")
                    else row["created_at"],
                    "conversationId": dm[0] if dm else None,
                    "version": row["version"]
                    if kind == "friendship"
                    else row["write_version"]
                    if kind == "direct"
                    else 1,
                }

            return page(rows, total, limit, convert, key=lambda row: [row["row_id"]])

    def inspect_relation(self, conn, action, target):
        table = "friendships" if action == "relationship.remove" else "friend_requests"
        row = conn.execute(f"SELECT * FROM {table} WHERE id=?", (target,)).fetchone()
        if not row:
            raise unavailable()
        if action == "friend_request.cancel" and row["status"] != "pending":
            raise conflict("申请已处理，不能再次撤销。")
        one = identity(conn, row["low_id"])
        two = identity(conn, row["high_id"])
        snapshot = {key: value for key, value in dict(row).items() if key != "note"}
        return (
            snapshot,
            one["nickname"] + " ↔ " + two["nickname"],
            "好友关系" if action == "relationship.remove" else "待处理好友申请",
        )

    def apply_relation(self, conn, action, target):
        row, _, _ = self.inspect_relation(conn, action, target)
        if action == "relationship.remove":
            conn.execute("DELETE FROM friendships WHERE id=?", (target,))
            conn.execute(
                "DELETE FROM friend_preferences WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)",
                (row["low_id"], row["high_id"], row["high_id"], row["low_id"]),
            )
        else:
            conn.execute(
                "UPDATE friend_requests SET status='cancelled',updated_at=? WHERE id=?",
                (now_ms(), target),
            )
        self.runtime.contacts._changed(conn, row["low_id"], row["high_id"])
        return "关系状态已更新；双方发送权限和上线提醒按当前关系重新判断。"
