from __future__ import annotations

from tongpin.admin.authz import cursor, identity, page, unavailable
from tongpin.contracts.base import APIError
from tongpin.infra.db import now_ms


class SessionsAdmin:
    def sessions(self, actor, *, user_id="", state="active", after="", limit=50):
        if state not in ("active", "revoked", "expired", "all"):
            raise APIError("VALIDATION_ERROR", "会话状态筛选无效。", 422)
        stamp = now_ms()
        clauses, args = ["1=1"], []
        valid = "s.revoked_at IS NULL AND s.expires_at>? AND s.last_seen_at+s.idle_ms>? AND u.status='active' AND u.must_change_password=0"
        if state == "active":
            clauses.append("(" + valid + ")")
            args += [stamp, stamp]
        elif state == "expired":
            clauses.append("s.revoked_at IS NULL AND NOT(" + valid + ")")
            args += [stamp, stamp]
        elif state == "revoked":
            clauses.append("s.revoked_at IS NOT NULL")
        if user_id:
            clauses.append("s.user_id=?")
            args.append(user_id)
        connections = self.runtime.connections_snapshot()
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            where = " AND ".join(clauses)
            source = " FROM sessions s JOIN users u ON u.id=s.user_id WHERE "
            total = conn.execute("SELECT COUNT(*)" + source + where, args).fetchone()[0]
            marker = cursor(after)
            if marker:
                where += " AND s.id>?"
                args += marker
            rows = conn.execute(
                "SELECT s.*,u.status AS user_status,u.must_change_password"
                + source
                + where
                + " ORDER BY s.id LIMIT ?",
                [*args, limit + 1],
            ).fetchall()

            def convert(row):
                return {
                    "id": row["id"],
                    "user": identity(conn, row["user_id"]),
                    "device": row["device"],
                    "createdAt": row["created_at"],
                    "lastSeenAt": row["last_seen_at"],
                    "expiresAt": row["expires_at"],
                    "revokedAt": row["revoked_at"],
                    "active": row["revoked_at"] is None
                    and row["expires_at"] > stamp
                    and row["last_seen_at"] + row["idle_ms"] > stamp
                    and row["user_status"] == "active"
                    and not row["must_change_password"],
                    "connectionCount": sum(
                        value["sessionId"] == row["id"] for _, value in connections
                    ),
                    "current": row["id"] == actor.session["id"],
                }

            return page(rows, total, limit, convert)

    def connections(self, actor, *, user_id="", after="", limit=50):
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            rows = [
                {
                    "id": sid,
                    "userId": item["userId"],
                    "sessionId": item["sessionId"],
                    "connectedAt": item["connectedAt"],
                }
                for sid, item in self.runtime.connections_snapshot()
                if not user_id or item["userId"] == user_id
            ]
        rows.sort(key=lambda row: row["id"])
        total, marker = len(rows), cursor(after)
        if marker:
            rows = [row for row in rows if row["id"] > str(marker[0])]
        return page(rows[: limit + 1], total, limit, lambda row: row)

    def inspect_session(self, conn, sid):
        row = conn.execute(
            "SELECT id,user_id,created_at,expires_at,revoked_at FROM sessions WHERE id=?", (sid,)
        ).fetchone()
        if not row:
            raise unavailable()
        user = identity(conn, row["user_id"])
        return dict(row), f"{user['nickname']}的设备会话", sid

    def apply_session(self, conn, sid):
        row = conn.execute("SELECT user_id FROM sessions WHERE id=?", (sid,)).fetchone()
        if not row:
            raise unavailable()
        conn.execute(
            "UPDATE sessions SET revoked_at=COALESCE(revoked_at,?) WHERE id=?", (now_ms(), sid)
        )
        conn.execute("DELETE FROM reauth_tokens WHERE session_id=?", (sid,))
        self.runtime.events.notify(conn, row["user_id"], "account.restriction", row["user_id"])
        return "该设备会话已撤销，对应连接将立即断开。"
