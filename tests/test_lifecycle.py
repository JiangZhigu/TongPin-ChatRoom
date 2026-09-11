from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import httpx
import pytest
from test_files import image_bytes, upload
from test_groups import befriend, create, join
from test_interactions import ORIGIN, direct, error, send
from test_interactions import rich as rich  # noqa: PLC0414 -- explicit pytest fixture re-export

from tongpin.contracts.auth import ReauthInput, RecoverInput
from tongpin.contracts.interactions import DeleteAccountInput
from tongpin.domain.lifecycle import DAY
from tongpin.infra.db import now_ms

pytestmark = pytest.mark.asyncio
PASSWORD = "Account closure isolated 87!"


def credentials(rt, actor):
    with rt.db.write() as conn:
        conn.execute(
            "UPDATE users SET password_hash=? WHERE id=?",
            (rt.auth.security.passwords.hash(PASSWORD), actor.id),
        )
        codes = rt.auth.security.recovery_codes(conn, actor.id)
    return rt.auth.load_hash(actor.session["token_hash"]), codes


def deletion(rt, actor):
    result = rt.auth.reauth(actor, ReauthInput(action="account.delete", password=PASSWORD))
    return DeleteAccountInput(
        reauthToken=result["reauthToken"], confirmation=actor.user["username"]
    )


def recovery(rt, actor, code):
    flow = "isolated-lifecycle-recovery-" + actor.id
    with patch("tongpin.domain.security.secrets.choice", lambda alphabet: alphabet[0]):
        challenge = rt.auth.security.new_captcha(flow, flow)
    data = RecoverInput(
        username=actor.user["username"],
        recoveryCode=code,
        password=PASSWORD + "New",
        captchaId=challenge["captchaId"],
        captchaAnswer="AAAAAA",
    )
    return rt.auth.recover(data, flow, flow, "isolated lifecycle test")


async def test_delete_real_reauthentication_guards_and_transactional_rollback(rich):
    app, (one, _, _, _), _ = rich
    rt = app.runtime
    one, _ = credentials(rt, one)
    command = deletion(rt, one)
    error(
        "VALIDATION_ERROR",
        lambda: rt.lifecycle.delete_account(
            one, command.model_copy(update={"confirmation": "someone_else"})
        ),
    )
    group = create(rt, one)["conversation"]
    preview = rt.lifecycle.deletion_preview(one)
    assert preview["coolingDays"] == 30 and preview["ownedGroups"][0]["id"] == group["id"]
    error("OWNER_MUST_TRANSFER", lambda: rt.lifecycle.delete_account(one, command))
    with rt.db.write() as conn:
        conn.execute("UPDATE conversations SET status='dissolved' WHERE id=?", (group["id"],))
        conn.execute(
            "UPDATE users SET site_role='super_admin',totp_secret='isolated-existing-factor' WHERE id=?",
            (one.id,),
        )
    error("LAST_ADMINISTRATOR", lambda: rt.lifecycle.delete_account(one, command))
    with rt.db.read() as conn:
        assert (
            conn.execute(
                "SELECT consumed_at FROM reauth_tokens WHERE digest=?",
                (rt.auth.security.digest(command.reauthToken, "reauth"),),
            ).fetchone()[0]
            is None
        )
        assert (
            conn.execute("SELECT status FROM users WHERE id=?", (one.id,)).fetchone()[0] == "active"
        )


async def test_delete_lost_http_response_replays_only_original_cookie_and_consumed_credential(rich):
    app, (one, _, _, _), tokens = rich
    rt = app.runtime
    one, _ = credentials(rt, one)
    command = deletion(rt, one)
    with rt.db.write() as conn:
        other_session, _ = rt.auth.issue_session(conn, one.user, False, "other isolated device")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=ORIGIN, headers={"Origin": ORIGIN}
    ) as client:
        client.cookies.set(rt.auth.cookie_name, tokens[0])
        client.headers["X-CSRF-Token"] = rt.auth.security.csrf(tokens[0])
        first = await client.post("/api/v1/account/delete", json=command.model_dump())
        assert first.status_code == 200, first.text
        # Simulate the UI losing this response; the same cookie is now revoked.
        assert (await client.get("/api/v1/auth/me")).status_code == 401
        repeated = await client.post("/api/v1/account/delete", json=command.model_dump())
        assert repeated.status_code == 200 and repeated.json()["data"] == first.json()["data"]
        invalid = command.model_copy(update={"reauthToken": "wrong-isolated-credential"})
        assert (await client.post("/api/v1/account/delete", json=invalid.model_dump())).json()[
            "error"
        ]["code"] == "DELETION_UNCONFIRMED"
        client.cookies.set(rt.auth.cookie_name, other_session)
        client.headers["X-CSRF-Token"] = rt.auth.security.csrf(other_session)
        assert (
            await client.post("/api/v1/account/delete", json=command.model_dump())
        ).status_code == 403
    with rt.db.read() as conn:
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM sessions WHERE user_id=? AND revoked_at IS NULL", (one.id,)
            ).fetchone()[0]
            == 0
        )
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM audit_events WHERE action='account.delete.request' AND subject_id=?",
                (one.id,),
            ).fetchone()[0]
            == 1
        )
        receipt = conn.execute(
            "SELECT consumed_at,expires_at FROM reauth_tokens WHERE session_id=?",
            (one.session["id"],),
        ).fetchone()
        assert receipt[0] and receipt[1] == first.json()["data"]["recoverBefore"]


async def test_simultaneous_delete_same_receipt_commits_once(rich):
    app, (one, _, _, _), tokens = rich
    rt = app.runtime
    one, _ = credentials(rt, one)
    command = deletion(rt, one)
    with ThreadPoolExecutor(max_workers=2) as pool:
        values = list(
            pool.map(lambda _: rt.lifecycle.deletion_request(tokens[0], command), range(2))
        )
    assert values[0] == values[1] and values[0]["deleted"]


async def test_cooling_recovery_preserves_shared_data_and_revokes_receipt(rich):
    app, (one, two, _, _), tokens = rich
    rt = app.runtime
    one, codes = credentials(rt, one)
    conversation = direct(rt, one, two)
    message, _ = send(rt, one, conversation, "冷静期共同消息保留")
    command = deletion(rt, one)
    rt.lifecycle.deletion_request(tokens[0], command)
    assert rt.lifecycle.cleanup()["accountsPurged"] == 0
    assert recovery(rt, one, codes[0]) == {"recovered": True}
    assert rt.interactions.get(two, message["id"])["message"]["text"] == "冷静期共同消息保留"
    error("AUTH_REQUIRED", lambda: rt.auth.load(tokens[0]))
    error("DELETION_UNCONFIRMED", lambda: rt.lifecycle.deletion_request(tokens[0], command))
    with rt.db.read() as conn:
        row = conn.execute(
            "SELECT status,deletion_at,password_hash FROM users WHERE id=?", (one.id,)
        ).fetchone()
        assert row[0] == "active" and row[1] is None
        assert rt.auth.security.verify_password(row[2], PASSWORD + "New")
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM reauth_tokens WHERE session_id=?", (one.session["id"],)
            ).fetchone()[0]
            == 0
        )
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM user_events WHERE user_id=? AND kind='account.changed'",
                (one.id,),
            ).fetchone()[0]
            >= 2
        )


async def test_due_account_anonymizes_credentials_avatar_and_membership_but_keeps_shared_bytes(
    rich,
):
    app, (one, two, _, _), tokens = rich
    rt = app.runtime
    one, codes = credentials(rt, one)
    befriend(rt, one, two)
    group = create(rt, two, [one])["conversation"]
    join(rt, two, one, group["id"])
    conversation = rt.chat.direct(one, two.id)
    shared_bytes = image_bytes()
    shared = upload(rt, one, conversation, shared_bytes, "shared.png")
    message, _ = send(rt, one, conversation, "共享历史保留", attachmentIds=[shared["id"]])
    avatar = upload(rt, one, None, image_bytes(), "avatar.png", purpose="user_avatar")
    rt.files.set_avatar(one, avatar["id"])
    command = deletion(rt, one)
    rt.lifecycle.deletion_request(tokens[0], command)
    with rt.db.write() as conn:
        conn.execute("UPDATE users SET deletion_at=? WHERE id=?", (now_ms() - 1, one.id))
    error("RECOVERY_FAILED", lambda: recovery(rt, one, codes[0]))
    result = rt.lifecycle.cleanup()
    assert result["accountsPurged"] == 1 and result["membershipsClosed"] == 1
    assert rt.files.cleanup()["removed"] == 1
    path, _, _ = rt.files.content(two, shared["id"], "content")
    assert path.read_bytes() == shared_bytes
    assert rt.interactions.get(two, message["id"])["message"]["sender"]["nickname"] == "已注销用户"
    with rt.db.read() as conn:
        row = conn.execute("SELECT * FROM users WHERE id=?", (one.id,)).fetchone()
        assert row["status"] == "deleted" and row["password_hash"] == "!"
        assert row["bio"] == "" and row["avatar_id"] is None and row["totp_secret"] is None
        assert row["preferences"] == "{}" and row["username"] == one.user["username"]
        for table in [
            "sessions",
            "recovery_codes",
            "bookmarks",
            "friend_preferences",
            "notifications",
        ]:
            assert (
                conn.execute(f"SELECT COUNT(*) FROM {table} WHERE user_id=?", (one.id,)).fetchone()[
                    0
                ]
                == 0
            )
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM memberships WHERE user_id=? AND left_at IS NULL", (one.id,)
            ).fetchone()[0]
            == 0
        )
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert not conn.execute("PRAGMA foreign_key_check").fetchall()


async def test_removed_retention_unbinds_atomically_and_deletes_real_file_after_deadline(rich):
    app, (one, two, _, _), _ = rich
    rt = app.runtime
    conversation = direct(rt, one, two)
    file = upload(rt, one, conversation, image_bytes(), "retained.png")
    message, payload = send(rt, one, conversation, "待清理原文", attachmentIds=[file["id"]])
    path, _, _ = rt.files.content(two, file["id"], "content")
    rt.interactions.bookmark(two, message["id"], True)
    rt.interactions.remove(one, message["id"])
    assert rt.lifecycle.cleanup()["messagesPurged"] == 0 and path.is_file()
    with rt.db.write() as conn:
        conn.execute(
            "UPDATE messages SET removed_at=? WHERE id=?", (now_ms() - 31 * DAY, message["id"])
        )
        before = dict(
            conn.execute(
                "SELECT id,seq,payload_hash FROM messages WHERE id=?", (message["id"],)
            ).fetchone()
        )
    assert rt.lifecycle.cleanup()["messagesPurged"] == 1
    error("RESOURCE_UNAVAILABLE", lambda: rt.files.content(one, file["id"], "content"))
    error("RESOURCE_UNAVAILABLE", lambda: rt.files.content(two, file["id"], "content"))
    assert path.is_file()  # Physical GC is a separate durable bounded job.
    assert rt.files.cleanup()["removed"] == 1 and not path.exists()
    with rt.db.read() as conn:
        row = conn.execute("SELECT * FROM messages WHERE id=?", (message["id"],)).fetchone()
        assert {field: row[field] for field in before} == before
        assert row["status"] == "purged" and row["text"] == "" and row["reply_id"] is None
        assert conn.execute(
            "SELECT state,message_id,quota_bytes FROM attachments WHERE id=?", (file["id"],)
        ).fetchone()[:] == ("expired", None, 0)
    assert rt.interactions.bookmarks(two)["items"][0]["available"] is False
    assert rt.chat.send(one, conversation["id"], payload)["duplicate"] is True


async def test_backup_hold_and_bounded_event_audit_cleanup_preserve_resume_floor(rich):
    app, (one, _, _, _), _ = rich
    rt = app.runtime
    old = now_ms() - 181 * DAY
    with rt.db.write() as conn:
        conn.executemany(
            "INSERT INTO user_events(user_id,kind,entity_ref,created_at) VALUES(?,'account.changed',?,?)",
            [(one.id, one.id, old)] * 1005,
        )
        conn.executemany(
            "INSERT INTO audit_events(action,result,created_at) VALUES('isolated-old','success',?)",
            [(old,)] * 1005,
        )
        conn.execute(
            "INSERT INTO instance_metadata(key,value) VALUES('backup_active','1') ON CONFLICT(key) DO UPDATE SET value='1'"
        )
        first_boundary = conn.execute(
            "SELECT id FROM user_events WHERE created_at=? ORDER BY id LIMIT 1 OFFSET 999", (old,)
        ).fetchone()[0]
    held = rt.lifecycle.cleanup()
    assert held["heldByBackup"] and held["eventsPurged"] == 0
    with rt.db.write() as conn:
        conn.execute("UPDATE instance_metadata SET value='0' WHERE key='backup_active'")
    first = rt.lifecycle.cleanup()
    assert first["eventsPurged"] == first["auditPurged"] == 1000
    with rt.db.read() as conn:
        assert (
            int(
                conn.execute(
                    "SELECT value FROM instance_metadata WHERE key='event_floor'"
                ).fetchone()[0]
            )
            == first_boundary
        )
        assert (
            conn.execute(
                "SELECT MIN(run_after) FROM jobs WHERE kind='retention.cleanup' AND status='pending'"
            ).fetchone()[0]
            < now_ms() + 1500
        )
    second = rt.lifecycle.cleanup()
    assert second["eventsPurged"] == second["auditPurged"] == 5
    with rt.db.read() as conn:
        last = json.loads(
            conn.execute(
                "SELECT value FROM instance_metadata WHERE key='retention_last'"
            ).fetchone()[0]
        )
        assert last["eventsPurged"] == 5


async def test_many_group_memberships_are_closed_over_durable_bounded_batches(rich):
    app, (one, two, three, _), _ = rich
    rt = app.runtime
    # Isolated bulk fixture uses real creation/join paths and two legal owners.
    for owner in [two, three]:
        befriend(rt, owner, one)
        for _ in range(11):
            group = create(rt, owner, [one])["conversation"]
            join(rt, owner, one, group["id"])
    with rt.db.write() as conn:
        conn.execute(
            "UPDATE users SET status='deleting',deletion_at=? WHERE id=?", (now_ms() - 1, one.id)
        )
        conn.execute("UPDATE sessions SET revoked_at=? WHERE user_id=?", (now_ms(), one.id))
    first = rt.lifecycle.cleanup()
    assert first["membershipsClosed"] == 20 and first["accountsPurged"] == 0
    with rt.db.read() as conn:
        assert (
            conn.execute("SELECT status FROM users WHERE id=?", (one.id,)).fetchone()[0]
            == "deleting"
        )
    second = rt.lifecycle.cleanup()
    assert second["membershipsClosed"] == 2 and second["accountsPurged"] == 1
