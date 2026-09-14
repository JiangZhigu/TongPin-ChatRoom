from __future__ import annotations

import base64
import hashlib
import json

from tongpin.contracts.base import APIError
from tongpin.infra.db import now_ms


def unavailable():
    return APIError("RESOURCE_UNAVAILABLE", "目标不存在或当前不可管理。", 404)


def conflict(message="目标在预览后已发生变化，请刷新并重新预览。"):
    return APIError("VERSION_CONFLICT", message, 409)


def compact(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def fingerprint(value):
    return hashlib.sha256(compact(value).encode()).hexdigest()


def identity(conn, uid):
    row = conn.execute(
        "SELECT id,username,nickname,status FROM users WHERE id=?", (uid,)
    ).fetchone()
    if not row:
        raise unavailable()
    return {
        "id": row["id"],
        "username": row["username"],
        "nickname": "已注销用户" if row["status"] == "deleted" else row["nickname"],
    }


def page(rows, total, limit, convert, *, key=lambda r: [r["id"]]):
    selected = rows[:limit]
    cursor = (
        base64.urlsafe_b64encode(compact(key(selected[-1])).encode()).decode().rstrip("=")
        if len(rows) > limit
        else None
    )
    return {"items": [convert(row) for row in selected], "nextCursor": cursor, "total": total}


def cursor(value, count=1):
    if not value:
        return None
    try:
        if len(value) > 512:
            raise ValueError
        data = json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))
        if (
            not isinstance(data, list)
            or len(data) != count
            or any(type(item) not in (str, int) or len(str(item)) > 160 for item in data)
            or any(type(item) is int and not 0 <= item <= 2**63 - 1 for item in data)
        ):
            raise ValueError
        return data
    except (ValueError, TypeError, UnicodeError) as error:
        raise APIError("VALIDATION_ERROR", "分页位置无效，请重新打开列表。", 422) from error


def bounded_limit(value):
    try:
        result = int(value)
    except (ValueError, TypeError) as error:
        raise APIError("VALIDATION_ERROR", "每页数量无效。", 422) from error
    if not 1 <= result <= 100:
        raise APIError("VALIDATION_ERROR", "每页最多100项。", 422)
    return result


def last_admin_guard(conn, target):
    if (
        target["site_role"] != "super_admin"
        or target["status"] != "active"
        or target["must_change_password"]
    ):
        return
    remaining = conn.execute(
        "SELECT COUNT(*) FROM users WHERE id<>? AND site_role='super_admin' AND status='active' AND must_change_password=0",
        (target["id"],),
    ).fetchone()[0]
    if not remaining:
        raise APIError("LAST_ADMIN", "必须保留至少一个可用超级管理员。", 409)


def mute_until(parameters):
    value = parameters.get("until")
    if type(value) is not int or not now_ms() < value <= now_ms() + 30 * 86400000:
        raise APIError("VALIDATION_ERROR", "禁言到期时间须在未来30天内。", 422)
    return value
