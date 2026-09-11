from __future__ import annotations

import sqlite3
import zipfile
from dataclasses import replace

from tongpin.admin.artifacts import (
    artifact_error,
    backup_file_entries,
    checksum,
    extract_entry,
    verify_database,
)
from tongpin.domain.auth import AuthService
from tongpin.domain.security import audit
from tongpin.infra.db import now_ms


def upsert_row(conn, table, row, keys=("id",)):
    columns = list(row)
    update = [column for column in columns if column not in keys]
    conn.execute(
        "INSERT INTO "
        + table
        + "("
        + ",".join(columns)
        + ") VALUES("
        + ",".join("?" for _ in columns)
        + ") ON CONFLICT("
        + ",".join(keys)
        + ") DO UPDATE SET "
        + ",".join(column + "=excluded." + column for column in update),
        [row[column] for column in columns],
    )


def apply_current_authority(clone, authority_path, check):
    """Apply a coherent current snapshot before any restored account can log in."""
    source = sqlite3.connect(authority_path.as_uri() + "?mode=ro", uri=True)
    source.row_factory = sqlite3.Row
    result = {
        "accountsCurrent": 0,
        "membershipsCurrent": 0,
        "messagesRestricted": 0,
        "filesRestricted": 0,
    }
    try:
        with clone.db.write() as conn:
            check()
            identity = conn.execute(
                "SELECT value FROM instance_metadata WHERE key='instance_id'"
            ).fetchone()
            authoritative_identity = source.execute(
                "SELECT value FROM instance_metadata WHERE key='instance_id'"
            ).fetchone()
            if (
                not identity
                or not authoritative_identity
                or identity[0] != authoritative_identity[0]
            ):
                raise artifact_error(
                    "当前权限来源与备份实例不一致，不能启用恢复数据。", "RESTORE_AUTHORITY_MISMATCH"
                )
            for old_user in conn.execute("SELECT id FROM users").fetchall():
                check()
                if not source.execute("SELECT 1 FROM users WHERE id=?", (old_user[0],)).fetchone():
                    raise artifact_error(
                        "当前权限来源缺少旧账号状态，不能恢复该快照。",
                        "RESTORE_AUTHORITY_INCOMPLETE",
                    )
            for row in source.execute("SELECT * FROM users"):
                check()
                user = dict(row)
                if (
                    user["avatar_id"]
                    and not conn.execute(
                        "SELECT 1 FROM attachments WHERE id=?", (user["avatar_id"],)
                    ).fetchone()
                ):
                    user["avatar_id"] = None
                upsert_row(conn, "users", user)
                result["accountsCurrent"] += 1
            # Password/factor recovery codes retain their CURRENT consumed state.
            conn.execute("DELETE FROM recovery_codes")
            for row in source.execute("SELECT * FROM recovery_codes"):
                check()
                upsert_row(conn, "recovery_codes", dict(row))
            conn.execute("DELETE FROM reset_credentials")
            conn.execute("DELETE FROM reauth_tokens")
            conn.execute(
                "UPDATE sessions SET revoked_at=COALESCE(revoked_at,?),second_factor_at=NULL",
                (now_ms(),),
            )
            for table, keys in (
                ("friendships", ("low_id", "high_id")),
                ("blocks", ("user_id", "target_id")),
            ):
                conn.execute("DELETE FROM " + table)
                for row in source.execute("SELECT * FROM " + table):
                    check()
                    upsert_row(conn, table, dict(row), keys)
            conn.execute(
                "UPDATE friend_requests SET status='cancelled',updated_at=? WHERE status='pending'",
                (now_ms(),),
            )
            for current in source.execute("SELECT * FROM conversations"):
                check()
                if not conn.execute(
                    "SELECT 1 FROM conversations WHERE id=?", (current["id"],)
                ).fetchone():
                    continue
                fields = [
                    "status",
                    "owner_id",
                    "role_version",
                    "slow_seconds",
                    "review_required",
                    "invite_role",
                    "dissolved_at",
                    "admin_governance_version",
                    "everyone_muted",
                    "write_version",
                ]
                # The snapshot's message sequence remains truthful; only current
                # access and governance attributes come from the authority source.
                conn.execute(
                    "UPDATE conversations SET "
                    + ",".join(field + "=?" for field in fields)
                    + " WHERE id=?",
                    [*[current[field] for field in fields], current["id"]],
                )
            # Preserve historical periods referenced by transfer receipts. End old
            # active periods before applying current ones, keeping unique owners.
            conn.execute(
                "UPDATE memberships SET left_at=?,left_reason='restore_revalidated' WHERE left_at IS NULL",
                (now_ms(),),
            )
            for row in source.execute("SELECT * FROM memberships ORDER BY left_at IS NULL,id"):
                check()
                if conn.execute(
                    "SELECT 1 FROM conversations WHERE id=?", (row["conversation_id"],)
                ).fetchone():
                    upsert_row(conn, "memberships", dict(row))
                    result["membershipsCurrent"] += 1
            for row in conn.execute("SELECT id,status FROM messages").fetchall():
                check()
                current = source.execute(
                    "SELECT * FROM messages WHERE id=?", (row["id"],)
                ).fetchone()
                if current and current["status"] in ("recalled", "moderated", "purged"):
                    conn.execute(
                        "UPDATE messages SET status=?,text=CASE WHEN ?='purged' THEN '' ELSE text END,removed_at=?,removed_by=?,removed_reason=?,moderation_kind=? WHERE id=?",
                        (
                            current["status"],
                            current["status"],
                            current["removed_at"],
                            current["removed_by"],
                            current["removed_reason"],
                            current["moderation_kind"],
                            row["id"],
                        ),
                    )
                    result["messagesRestricted"] += 1
                elif current is None and row["status"] != "purged":
                    conn.execute(
                        "UPDATE messages SET status='purged',text='',removed_at=?,removed_reason=NULL WHERE id=?",
                        (now_ms(), row["id"]),
                    )
                    result["messagesRestricted"] += 1
            for row in conn.execute("SELECT * FROM attachments").fetchall():
                check()
                current = source.execute(
                    "SELECT * FROM attachments WHERE id=?", (row["id"],)
                ).fetchone()
                if current and current["expected_sha256"] == row["expected_sha256"]:
                    fields = ["governance", "governance_reason", "scan_status"]
                    conn.execute(
                        "UPDATE attachments SET "
                        + ",".join(field + "=?" for field in fields)
                        + " WHERE id=?",
                        [*[current[field] for field in fields], row["id"]],
                    )
                revoked = (
                    not current
                    or current["expected_sha256"] != row["expected_sha256"]
                    or current["state"] != "ready"
                )
                message = (
                    conn.execute(
                        "SELECT status FROM messages WHERE id=?", (row["message_id"],)
                    ).fetchone()
                    if row["message_id"]
                    else None
                )
                if revoked or message and message[0] == "purged":
                    conn.execute(
                        "UPDATE attachments SET state='expired',governance='revoked',message_id=NULL,avatar_bound=0,expires_at=?,error_code='RESTORE_ACCESS_REVOKED' WHERE id=?",
                        (now_ms(), row["id"]),
                    )
                    result["filesRestricted"] += 1
            conn.execute(
                "UPDATE users SET avatar_hidden=1 WHERE avatar_id IN(SELECT id FROM attachments WHERE state<>'ready' OR governance<>'available')"
            )
            conn.execute(
                "UPDATE conversations SET avatar_hidden=1 WHERE avatar_id IN(SELECT id FROM attachments WHERE state<>'ready' OR governance<>'available')"
            )
            current_policy = source.execute(
                "SELECT * FROM policy_versions ORDER BY version DESC LIMIT 1"
            ).fetchone()
            if current_policy:
                next_version = conn.execute(
                    "SELECT COALESCE(MAX(version),0)+1 FROM policy_versions"
                ).fetchone()[0]
                conn.execute(
                    "INSERT INTO policy_versions VALUES(?,?,NULL,?,?)",
                    (
                        next_version,
                        current_policy["values_json"],
                        "恢复前应用当前实例策略",
                        now_ms(),
                    ),
                )
            conn.execute("UPDATE site_invites SET revoked_at=COALESCE(revoked_at,?)", (now_ms(),))
            conn.execute("UPDATE group_invites SET revoked_at=COALESCE(revoked_at,?)", (now_ms(),))
            conn.execute(
                "UPDATE group_applications SET status='expired',updated_at=? WHERE status='pending'",
                (now_ms(),),
            )
            conn.execute(
                "UPDATE group_transfers SET status='cancelled',updated_at=? WHERE status='pending'",
                (now_ms(),),
            )
            conn.execute(
                "UPDATE administrator_invitations SET status='cancelled',version=version+1 WHERE status='pending'"
            )
            conn.execute("DELETE FROM administrator_enrollments")
            conn.execute("DELETE FROM admin_previews")
            conn.execute(
                "UPDATE admin_command_items SET status='cancelled',code='RESTORE_INVALIDATED',message='恢复时撤销未完成授权。' WHERE status='pending'"
            )
            for row in conn.execute(
                "SELECT id FROM admin_commands WHERE status IN('queued','running')"
            ).fetchall():
                clone.admin.finish_command(conn, row[0])
            conn.execute(
                "UPDATE admin_operations SET status=CASE WHEN status IN('queued','running') THEN 'cancelled' ELSE status END,storage_key=NULL,expires_at=?,updated_at=?",
                (now_ms(), now_ms()),
            )
            conn.execute(
                "UPDATE announcements SET status='withdrawn',withdrawn_at=?,version=version+1 WHERE status<>'withdrawn'",
                (now_ms(),),
            )
            conn.execute(
                "UPDATE jobs SET status='cancelled',lease_until=NULL,completed_at=? WHERE status IN('pending','running')",
                (now_ms(),),
            )
            conn.execute(
                "INSERT INTO instance_metadata(key,value) VALUES('backup_active','0') ON CONFLICT(key) DO UPDATE SET value='0'"
            )
            conn.execute("DELETE FROM user_events")
            conn.execute(
                "UPDATE instance_metadata SET value=(SELECT CAST(COALESCE(seq,0) AS TEXT) FROM sqlite_sequence WHERE name='user_events') WHERE key='event_floor' AND EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='user_events')"
            )
            conn.execute(
                "UPDATE conversation_preferences SET read_seq=MIN(read_seq,(SELECT last_seq FROM conversations WHERE id=conversation_id))"
            )
            # Terminal states no longer enter the ordinary expiry selectors.
            # Reapply the same erasure to old snapshot relations before success.
            for row in conn.execute("SELECT id FROM messages WHERE status='purged'").fetchall():
                check()
                clone.lifecycle.purge_message_in(conn, row[0], now_ms())
            for row in conn.execute("SELECT id FROM users WHERE status='deleted'").fetchall():
                check()
                clone.lifecycle.purge_account_in(conn, row[0], now_ms())
            audit(
                conn,
                None,
                "admin.restore.authority_replay",
                reason="隔离恢复前重放当前权限、凭据消费及删除规则",
                details=result,
            )
        return result
    finally:
        source.close()


def isolated_restore(runtime, archive_path, manifest, target, authority_path, check):
    from tongpin.runtime import Runtime

    if target.exists():
        raise artifact_error("隔离恢复目录必须是全新的。")
    clone = Runtime(replace(runtime.settings, data_root=target, secret=runtime.secret))
    try:
        clone.paths.prepare()
        with zipfile.ZipFile(archive_path) as archive:
            extract_entry(archive, "database.sqlite3", clone.paths.database, check)
            for row in manifest["files"]:
                if row["name"].startswith("files/"):
                    extract_entry(archive, row["name"], clone.files.path(row["name"][6:]), check)
        check()
        verify_database(runtime, clone.paths.database)
        clone.db.migrate()
        clone.auth = AuthService(clone)
        replay = apply_current_authority(clone, authority_path, check)
        cleanup = {"messagesPurged": 0, "accountsPurged": 0, "filesRemoved": 0, "bytesReleased": 0}
        for _ in range(1000):
            check()
            result = clone.lifecycle.cleanup()
            files = clone.files.cleanup()
            cleanup["messagesPurged"] += result["messagesPurged"]
            cleanup["accountsPurged"] += result["accountsPurged"]
            cleanup["filesRemoved"] += files.get("filesRemoved", 0)
            cleanup["bytesReleased"] += files.get("bytesReleased", 0)
            if not result.get("morePending") and files["removed"] < 100:
                break
        else:
            raise artifact_error("到期重放超出本次演练预算，未标记为恢复完成。", "RESTORE_LIMIT")
        check()
        checked = verify_database(runtime, clone.paths.database)
        with clone.db.read() as conn:
            required = backup_file_entries(clone, conn)
        manifest_rows = {row["name"]: row for row in manifest["files"]}
        for entry in required:
            check()
            signed = manifest_rows.get(entry["name"])
            if not signed or checksum(entry["path"], check) != signed["sha256"]:
                raise artifact_error(
                    "恢复后仍可用的文件与签名清单不一致。", "RESTORE_FILE_MISMATCH"
                )
        return {
            "isolatedOnly": True,
            "activationAllowed": False,
            "authorityCapturedAt": int(authority_path.stat().st_mtime * 1000),
            "checks": checked,
            "filesVerifiedAfterReplay": len(required),
            "replayed": replay,
            "cleanup": cleanup,
            "directory": target.name,
        }
    finally:
        clone.cache.clear()
        clone.executor.close()
