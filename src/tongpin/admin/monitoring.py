from __future__ import annotations

import math
import os
import time
from pathlib import Path

from tongpin.admin.authz import compact, cursor, page
from tongpin.contracts.base import APIError
from tongpin.domain.security import identifier
from tongpin.infra.db import now_ms

DEFAULT_THRESHOLDS = {
    "cpuPercent": 90,
    "memoryMiB": 1024,
    "diskPercent": 90,
    "httpP95Ms": 2000,
    "dbWaitMs": 1000,
    "failedJobs": 1,
    "pendingJobs": 100,
}
THRESHOLD_RANGES = {
    "cpuPercent": (1, 1000),
    "memoryMiB": (64, 1048576),
    "diskPercent": (1, 99),
    "httpP95Ms": (1, 120000),
    "dbWaitMs": (1, 30000),
    "failedJobs": (1, 10000),
    "pendingJobs": (1, 100000),
}


def validate_thresholds(values):
    if not isinstance(values, dict) or set(values) != set(DEFAULT_THRESHOLDS):
        raise APIError("VALIDATION_ERROR", "请提供所有监控阈值。", 422)
    for key, value in values.items():
        low, high = THRESHOLD_RANGES[key]
        if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
            raise APIError("VALIDATION_ERROR", f"{key}阈值须在{low}到{high}之间。", 422)
    return values


class MonitoringAdmin:
    def overview(self, actor, window="24h"):
        durations = {"1h": 3600000, "24h": 86400000, "7d": 7 * 86400000}
        if window not in durations:
            raise APIError("VALIDATION_ERROR", "统计窗口无效。", 422)
        end = now_ms()
        start = end - durations[window]
        step = 86400000 if window == "7d" else 3600000 if window == "24h" else 5 * 60000
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            scalar = lambda sql, args=(): conn.execute(sql, args).fetchone()[0]
            connections = self.runtime.connections_snapshot()
            values = [
                (
                    "registered",
                    "新注册用户",
                    scalar(
                        "SELECT COUNT(*) FROM users WHERE created_at BETWEEN ? AND ?", (start, end)
                    ),
                    "人",
                    "所选窗口内创建的真实账号",
                    "/admin/users",
                ),
                (
                    "active",
                    "活跃用户",
                    scalar(
                        "SELECT COUNT(DISTINCT user_id) FROM sessions WHERE last_seen_at BETWEEN ? AND ?",
                        (start, end),
                    ),
                    "人",
                    "所选窗口内最近使用过会话的不同用户",
                    "/admin/sessions",
                ),
                (
                    "online",
                    "当前在线用户",
                    len({row["userId"] for _, row in connections}),
                    "人",
                    "当前实际连接按用户去重，包含隐身账号",
                    "/admin/sessions",
                ),
                (
                    "connections",
                    "当前连接",
                    len(connections),
                    "个",
                    "标签页连接数，与用户数和设备会话分别统计",
                    "/admin/sessions",
                ),
                (
                    "sessions",
                    "当前有效设备会话",
                    scalar(
                        "SELECT COUNT(*) FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.revoked_at IS NULL AND s.expires_at>? AND s.last_seen_at+s.idle_ms>? AND u.status='active' AND u.must_change_password=0",
                        (end, end),
                    ),
                    "个",
                    "尚未撤销且未过期的会话",
                    "/admin/sessions",
                ),
                (
                    "direct",
                    "全站私聊会话",
                    scalar("SELECT COUNT(*) FROM conversations WHERE kind='direct'"),
                    "个",
                    "当前数据库总数",
                    "/admin/relations?kind=direct",
                ),
                (
                    "groups",
                    "当前未解散群",
                    scalar(
                        "SELECT COUNT(*) FROM conversations WHERE kind='group' AND status<>'dissolved'"
                    ),
                    "个",
                    "包含冻结群",
                    "/admin/groups",
                ),
                (
                    "messages",
                    "用户消息",
                    scalar(
                        "SELECT COUNT(*) FROM messages WHERE kind='user' AND created_at BETWEEN ? AND ?",
                        (start, end),
                    ),
                    "条",
                    "所选窗口内已持久提交，含后续撤回的消息",
                    "/admin/relations?kind=direct",
                ),
                (
                    "uploads",
                    "收到文件",
                    scalar(
                        "SELECT COUNT(*) FROM attachments WHERE size>0 AND created_at BETWEEN ? AND ?",
                        (start, end),
                    ),
                    "件",
                    "所选窗口内创建且已接收真实字节的文件",
                    "/admin/monitoring",
                ),
                (
                    "uploadBytes",
                    "收到文件字节",
                    scalar(
                        "SELECT COALESCE(SUM(size),0) FROM attachments WHERE created_at BETWEEN ? AND ?",
                        (start, end),
                    ),
                    "B",
                    "不把上传预留当作已收到的文件",
                    "/admin/monitoring",
                ),
            ]
            samples = self.runtime.metrics.history()
            values.append(
                (
                    "sendFailures",
                    "本次运行发送失败",
                    samples[-1].get("messageFailures", 0) if samples else None,
                    "次",
                    "当前进程已观察到的HTTP/WS消息失败；重启后重新计数",
                    "/admin/monitoring",
                )
            )
            trends = []
            for offset in range(start, end, step):
                stop = min(end, offset + step)
                trends.append(
                    {
                        "at": offset,
                        "registrations": scalar(
                            "SELECT COUNT(*) FROM users WHERE created_at>=? AND created_at<?",
                            (offset, stop),
                        ),
                        "messages": scalar(
                            "SELECT COUNT(*) FROM messages WHERE kind='user' AND created_at>=? AND created_at<?",
                            (offset, stop),
                        ),
                        "uploads": scalar(
                            "SELECT COUNT(*) FROM attachments WHERE size>0 AND created_at>=? AND created_at<?",
                            (offset, stop),
                        ),
                    }
                )
            return {
                "window": window,
                "from": start,
                "to": end,
                "generatedAt": end,
                "processStartedAt": int(self.runtime.metrics.started_at * 1000),
                "metrics": [
                    {
                        "key": key,
                        "label": label,
                        "value": value,
                        "unit": unit,
                        "description": description,
                        "href": href,
                    }
                    for key, label, value, unit, description, href in values
                ],
                "trends": trends,
            }

    def storage(self, conn):
        disk = self.runtime.paths.disk_state()

        def size(path):
            try:
                return path.stat().st_size
            except FileNotFoundError:
                return 0

        total, count, deadline = 0, 0, time.monotonic() + 0.1
        # A metadata scan has a strict work budget. Unknown is preferable to a partial total.
        try:
            with os.scandir(self.runtime.paths.uploads) as entries:
                for entry in entries:
                    count += 1
                    if count > 10000 or time.monotonic() > deadline:
                        total = None
                        break
                    if entry.is_file(follow_symlinks=False):
                        total += entry.stat(follow_symlinks=False).st_size
        except OSError:
            total = None
        charged = conn.execute("SELECT COALESCE(SUM(quota_bytes),0) FROM attachments").fetchone()[0]
        return {
            "totalBytes": disk["totalBytes"],
            "freeBytes": disk["freeBytes"],
            "usedPercent": round(
                (disk["totalBytes"] - disk["freeBytes"]) * 100 / disk["totalBytes"], 2
            ),
            "databaseBytes": size(self.runtime.paths.database),
            "walBytes": size(Path(str(self.runtime.paths.database) + "-wal")),
            "attachmentBytes": total,
            "chargedBytes": charged,
        }

    @staticmethod
    def queues(conn):
        result = dict.fromkeys(("pending", "running", "completed", "failed"), 0)
        result.update(
            {
                row["status"]: row["n"]
                for row in conn.execute("SELECT status,COUNT(*) AS n FROM jobs GROUP BY status")
            }
        )
        result["oldestPendingAt"] = conn.execute(
            "SELECT MIN(created_at) FROM jobs WHERE status='pending'"
        ).fetchone()[0]
        return result

    def alerts_in(self, conn, after="", limit=50):
        total = conn.execute("SELECT COUNT(*) FROM admin_alerts").fetchone()[0]
        marker = cursor(after, 2)
        rows = conn.execute(
            "SELECT * FROM admin_alerts"
            + (" WHERE (first_seen_at,id)<(?,?)" if marker else "")
            + " ORDER BY first_seen_at DESC,id DESC LIMIT ?",
            [*(marker or []), limit + 1],
        ).fetchall()
        return page(
            rows,
            total,
            limit,
            lambda row: {
                "id": row["id"],
                "rule": row["rule"],
                "title": row["title"],
                "status": row["status"],
                "value": row["value"],
                "threshold": row["threshold"],
                "firstSeenAt": row["first_seen_at"],
                "lastSeenAt": row["last_seen_at"],
                "resolvedAt": row["resolved_at"],
            },
            key=lambda row: [row["first_seen_at"], row["id"]],
        )

    def alerts(self, actor, after="", limit=50):
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            return self.alerts_in(conn, after, limit)

    def monitoring(self, actor):
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            policy = self.runtime.policy.get(conn)
            samples = self.runtime.metrics.history()
            return {
                "processStartedAt": int(self.runtime.metrics.started_at * 1000),
                "sampledAt": now_ms(),
                "latest": samples[-1] if samples else None,
                "samples": samples,
                "storage": self.storage(conn),
                "queues": self.queues(conn),
                "alerts": self.alerts_in(conn),
                "thresholds": policy.get("monitoring_thresholds", DEFAULT_THRESHOLDS),
                "policyVersion": policy["version"],
            }

    def inspect_monitoring(self, conn):
        policy = self.runtime.policy.get(conn)
        return {"version": policy["version"]}, "本实例监控阈值", "下一次十秒采样时按新阈值判断"

    def apply_monitoring(self, conn, command, parameters):
        values = self.runtime.policy.get(conn)
        version = values.pop("version") + 1
        values["monitoring_thresholds"] = validate_thresholds(parameters["values"])
        conn.execute(
            "INSERT INTO policy_versions VALUES(?,?,?,?,?)",
            (version, compact(values), command["actor_id"], command["reason"], now_ms()),
        )
        return f"监控阈值已保存为策略版本{version}，下次采样使用新值。"

    def sample_alerts(self, sample):
        with self.runtime.db.read() as conn:
            thresholds = self.runtime.policy.get(conn).get(
                "monitoring_thresholds", DEFAULT_THRESHOLDS
            )
            queued = self.queues(conn)
        disk = self.runtime.paths.disk_state()
        values = {
            "cpuPercent": sample["cpuPercent"],
            "memoryMiB": sample["rssBytes"] / 1024**2,
            "diskPercent": (disk["totalBytes"] - disk["freeBytes"]) * 100 / disk["totalBytes"],
            "httpP95Ms": sample["latencyP95Ms"],
            "dbWaitMs": sample["dbWaitP95Ms"],
            "failedJobs": queued["failed"],
            "pendingJobs": queued["pending"],
        }
        titles = {
            "cpuPercent": "进程CPU使用率超过阈值",
            "memoryMiB": "进程内存超过阈值",
            "diskPercent": "磁盘使用率超过阈值",
            "httpP95Ms": "HTTP延迟超过阈值",
            "dbWaitMs": "数据库写等待超过阈值",
            "failedJobs": "存在失败的后台任务",
            "pendingJobs": "后台任务积压超过阈值",
        }
        stamp = now_ms()
        with self.runtime.db.write() as conn:
            for key, value in values.items():
                if value is None:
                    continue
                existing = conn.execute(
                    "SELECT * FROM admin_alerts WHERE rule=? AND status='active'", (key,)
                ).fetchone()
                if value >= thresholds[key]:
                    if existing:
                        conn.execute(
                            "UPDATE admin_alerts SET value=?,threshold=?,last_seen_at=? WHERE id=?",
                            (value, thresholds[key], stamp, existing["id"]),
                        )
                        continue
                    aid = identifier("alert_")
                    conn.execute(
                        "INSERT INTO admin_alerts VALUES(?,?,?,'active',?,?,?,?,NULL)",
                        (aid, key, titles[key], value, thresholds[key], stamp, stamp),
                    )
                elif existing:
                    aid = existing["id"]
                    conn.execute(
                        "UPDATE admin_alerts SET status='resolved',value=?,last_seen_at=?,resolved_at=? WHERE id=?",
                        (value, stamp, stamp, aid),
                    )
                else:
                    continue
                admins = conn.execute(
                    "SELECT id FROM users WHERE site_role='super_admin' AND status='active' AND totp_secret IS NOT NULL AND must_change_password=0 LIMIT 100"
                ).fetchall()
                for user in admins:
                    self.runtime.events.notify(conn, user["id"], "admin.alert", aid)
            conn.execute(
                "DELETE FROM admin_alerts WHERE id IN(SELECT id FROM admin_alerts WHERE status='resolved' ORDER BY first_seen_at DESC,id DESC LIMIT 1000 OFFSET 1000)"
            )
