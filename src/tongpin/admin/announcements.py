from __future__ import annotations

from datetime import UTC, datetime

from tongpin.admin.authz import conflict, cursor, identity, page, unavailable
from tongpin.admin.sensitive import query_budget
from tongpin.contracts.base import APIError
from tongpin.domain.security import audit
from tongpin.infra.db import now_ms

STATUSES = {"scheduled", "sending", "published", "withdrawn", "failed"}
MAX_RECIPIENTS = 10000


class AnnouncementsAdmin:
    @staticmethod
    def announcement_view(conn, row):
        return {
            "id": row["id"],
            "kind": row["kind"],
            "title": row["title"],
            "body": row["body"],
            "audience": row["audience"],
            "groupId": row["group_id"],
            "creator": identity(conn, row["creator_id"]),
            "status": row["status"],
            "recipientCount": row["recipient_count"],
            "deliveredCount": row["delivered_count"],
            "publishAt": row["publish_at"],
            "publishedAt": row["published_at"],
            "withdrawnAt": row["withdrawn_at"],
            "createdAt": row["created_at"],
            "errorCode": row["error_code"],
            "version": row["version"],
            "jobId": row["job_id"],
        }

    def announcements(self, actor, *, status="", after="", limit=50):
        if status and status not in STATUSES:
            raise APIError("VALIDATION_ERROR", "公告状态筛选无效。", 422)
        position = cursor(after, 2)
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            conditions, args = (["status=?"], [status]) if status else ([], [])
            where = " AND ".join(conditions) or "1=1"
            total = conn.execute(
                "SELECT COUNT(*) FROM announcements WHERE " + where, args
            ).fetchone()[0]
            if position:
                conditions.append("(created_at<? OR(created_at=? AND id<?))")
                args.extend([position[0], *position])
            rows = conn.execute(
                "SELECT * FROM announcements WHERE "
                + (" AND ".join(conditions) or "1=1")
                + " ORDER BY created_at DESC,id DESC LIMIT ?",
                [*args, limit + 1],
            ).fetchall()
            return page(
                rows,
                total,
                limit,
                lambda row: self.announcement_view(conn, row),
                key=lambda row: [row["created_at"], row["id"]],
            )

    def announcement(self, actor, aid):
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            row = conn.execute("SELECT * FROM announcements WHERE id=?", (aid,)).fetchone()
            if not row:
                raise unavailable()
            return self.announcement_view(conn, row)

    def announcement_audience(self, conn, parameters):
        audience = parameters["audience"]
        with query_budget(conn):
            if audience == "users":
                ids = parameters["userIds"]
                rows = conn.execute(
                    "SELECT id FROM users WHERE status='active' AND id IN ("
                    + ",".join("?" for _ in ids)
                    + ") ORDER BY id",
                    ids,
                ).fetchall()
                if len(rows) != len(ids):
                    raise conflict("所选账号不存在或已停止使用，请重新核对名单。")
            elif audience == "group":
                group = conn.execute(
                    "SELECT id FROM conversations WHERE id=? AND kind='group' AND status<>'dissolved'",
                    (parameters["groupId"],),
                ).fetchone()
                if not group:
                    raise unavailable()
                rows = conn.execute(
                    "SELECT u.id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.conversation_id=? AND m.left_at IS NULL AND u.status='active' ORDER BY u.id LIMIT ?",
                    (group[0], MAX_RECIPIENTS + 1),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT id FROM users WHERE status='active' ORDER BY id LIMIT ?",
                    (MAX_RECIPIENTS + 1,),
                ).fetchall()
        if not rows or len(rows) > MAX_RECIPIENTS:
            raise APIError(
                "AUDIENCE_LIMIT", "本次发送须有1至10000个有效接收账号，请缩小范围。", 422
            )
        return [row["id"] for row in rows]

    def inspect_announcement(self, conn, action, target, parameters):
        if action == "announcement.create":
            publish_at = parameters["publishAt"]
            if publish_at is not None and not now_ms() < publish_at <= now_ms() + 30 * 86400000:
                raise APIError(
                    "VALIDATION_ERROR", "定时发布须在未来30天内；立即发送请选择立即。", 422
                )
            audience = self.announcement_audience(conn, parameters)
            when = (
                datetime.fromtimestamp(publish_at / 1000, UTC).isoformat()
                if publish_at
                else "提交后立即开始"
            )
            return (
                {"recipients": audience},
                "系统公告与通知",
                f"系统身份；{len(audience)}个接收账号；{when}；分批发送，不伪造用户消息。",
            )
        row = conn.execute("SELECT * FROM announcements WHERE id=?", (target,)).fetchone()
        if not row:
            raise unavailable()
        if row["status"] == "withdrawn":
            raise conflict("此公告已经撤回。")
        return (
            {"id": target, "version": row["version"], "status": row["status"]},
            row["title"],
            "停止未发送部分；已收到者重新读取时只显示撤回提示。",
        )

    def apply_announcement(self, conn, command, target, parameters):
        if command["action"] == "announcement.create":
            recipients = self.announcement_audience(conn, parameters)
            stamp = now_ms()
            when = parameters["publishAt"] or stamp
            aid = command["id"]
            job = self.runtime.jobs.enqueue_in_transaction(
                conn,
                "announcements.publish",
                {"announcementId": aid},
                entity_id=aid,
                dedupe_key="announcement:" + aid,
                run_after=when,
            )
            conn.execute(
                "INSERT INTO announcements(id,kind,title,body,audience,group_id,creator_id,status,recipient_count,publish_at,created_at,job_id) VALUES(?,?,?,?,?,?,?,'scheduled',?,?,?,?)",
                (
                    aid,
                    parameters["kind"],
                    parameters["title"],
                    parameters["body"],
                    parameters["audience"],
                    parameters["groupId"] or None,
                    command["actor_id"],
                    len(recipients),
                    when,
                    stamp,
                    job,
                ),
            )
            conn.executemany(
                "INSERT INTO announcement_recipients(announcement_id,user_id) VALUES(?,?)",
                [(aid, uid) for uid in recipients],
            )
            return f"已创建发送任务，接收名单{len(recipients)}人。实际发送进度请查看公告记录。"
        conn.execute(
            "UPDATE announcements SET status='withdrawn',withdrawn_at=?,version=version+1 WHERE id=?",
            (now_ms(), target),
        )
        # Recipients refresh through their existing notification references. Chunk
        # the durable hints rather than constructing an unbounded socket payload.
        recipients = [
            row[0]
            for row in conn.execute(
                "SELECT user_id FROM announcement_recipients WHERE announcement_id=? AND delivered_at IS NOT NULL",
                (target,),
            )
        ]
        for start in range(0, len(recipients), 100):
            self.runtime.events.publish(
                conn, recipients[start : start + 100], "notification.updated", target
            )
        conn.execute(
            "UPDATE jobs SET status='cancelled',completed_at=?,lease_until=NULL WHERE id=(SELECT job_id FROM announcements WHERE id=?) AND status='pending'",
            (now_ms(), target),
        )
        return "公告已撤回，未发送部分已停止，已发送通知将显示撤回状态。"

    def publish_announcement(self, job):
        aid = job["payload"]["announcementId"]
        with self.runtime.db.write() as conn:
            row = conn.execute("SELECT * FROM announcements WHERE id=?", (aid,)).fetchone()
            if not row or row["status"] in ("withdrawn", "failed", "published"):
                return {"finished": True}
            creator = conn.execute(
                "SELECT * FROM users WHERE id=?", (row["creator_id"],)
            ).fetchone()
            if (
                not creator
                or creator["status"] != "active"
                or creator["site_role"] != "super_admin"
                or creator["must_change_password"]
            ):
                conn.execute(
                    "UPDATE announcements SET status='failed',error_code='ADMIN_AUTH_CHANGED',version=version+1 WHERE id=?",
                    (aid,),
                )
                audit(
                    conn,
                    row["creator_id"],
                    "admin.announcement.stop",
                    aid,
                    result="cancelled",
                    details={"jobId": job["id"], "code": "ADMIN_AUTH_CHANGED"},
                )
                return {"finished": True, "code": "ADMIN_AUTH_CHANGED"}
            if row["publish_at"] > now_ms():
                conn.execute(
                    "UPDATE jobs SET status='pending',lease_until=NULL,run_after=? WHERE id=? AND status='running'",
                    (row["publish_at"], job["id"]),
                )
                return {"scheduled": True}
            recipients = conn.execute(
                "SELECT r.user_id,u.status FROM announcement_recipients r JOIN users u ON u.id=r.user_id WHERE r.announcement_id=? AND r.delivered_at IS NULL ORDER BY r.user_id LIMIT 100",
                (aid,),
            ).fetchall()
            count = 0
            for recipient in recipients:
                if recipient["status"] == "active":
                    self.runtime.events.notify(conn, recipient["user_id"], "system.notice", aid)
                    count += 1
                conn.execute(
                    "UPDATE announcement_recipients SET delivered_at=? WHERE announcement_id=? AND user_id=?",
                    (
                        now_ms() if recipient["status"] == "active" else -1,
                        aid,
                        recipient["user_id"],
                    ),
                )
            more = conn.execute(
                "SELECT 1 FROM announcement_recipients WHERE announcement_id=? AND delivered_at IS NULL LIMIT 1",
                (aid,),
            ).fetchone()
            conn.execute(
                "UPDATE announcements SET status=?,delivered_count=delivered_count+?,published_at=COALESCE(published_at,?),version=version+1 WHERE id=?",
                ("sending" if more else "published", count, now_ms(), aid),
            )
            if more:
                conn.execute(
                    "UPDATE jobs SET status='pending',attempts=0,lease_until=NULL,run_after=? WHERE id=? AND status='running'",
                    (now_ms() + 100, job["id"]),
                )
            else:
                audit(
                    conn,
                    row["creator_id"],
                    "admin.announcement.publish",
                    aid,
                    details={
                        "jobId": job["id"],
                        "deliveredCount": row["delivered_count"] + count,
                        "recipientCount": row["recipient_count"],
                    },
                )
            return {"finished": not bool(more), "sentThisBatch": count}

    @staticmethod
    def fail_announcement(conn, job, code):
        aid = job["entity_id"]
        row = conn.execute(
            "SELECT * FROM announcements WHERE id=? AND status IN('scheduled','sending')", (aid,)
        ).fetchone()
        if row:
            conn.execute(
                "UPDATE announcements SET status='failed',error_code=?,version=version+1 WHERE id=?",
                (code, aid),
            )
            audit(
                conn,
                row["creator_id"],
                "admin.announcement.fail",
                aid,
                result="failed",
                details={"jobId": job["id"], "code": code},
            )

    def system_notice(self, actor, aid):
        with self.runtime.db.read() as conn:
            actor = self.runtime.auth.current_in_transaction(conn, actor)
            return self.system_notice_in(conn, actor.id, aid)

    @staticmethod
    def system_notice_in(conn, uid, aid):
        row = conn.execute(
            "SELECT a.* FROM announcements a JOIN announcement_recipients r ON r.announcement_id=a.id WHERE a.id=? AND r.user_id=? AND r.delivered_at>0",
            (aid, uid),
        ).fetchone()
        if not row:
            raise unavailable()
        withdrawn = row["status"] == "withdrawn"
        return {
            "id": aid,
            "kind": row["kind"],
            "title": "系统公告已撤回" if withdrawn else row["title"],
            "body": "" if withdrawn else row["body"],
            "status": "withdrawn" if withdrawn else "published",
            "publishedAt": row["published_at"],
        }
