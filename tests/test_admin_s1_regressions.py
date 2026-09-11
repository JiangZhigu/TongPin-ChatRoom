from __future__ import annotations

import uuid

import pytest
from test_admin import PASSWORD, claim_admin, execute, fails, preview, reauth
from test_admin import admin_app as admin_app  # noqa: PLC0414 -- shared controlled fixture
from test_groups import create, link

from tongpin.contracts.auth import ReauthInput
from tongpin.contracts.interactions import DeleteAccountInput
from tongpin.infra.db import now_ms

pytestmark = pytest.mark.asyncio


@pytest.mark.parametrize("history", ["preview", "command", "ordinary"])
async def test_due_deletion_with_admin_session_history(admin_app, history):
    app, actors, tokens, factors, _ = admin_app
    rt = app.runtime
    index = 2 if history == "ordinary" else 0
    actor = actors[index]
    if history == "preview":
        preview(rt, actor, "user.mute", [actors[3].id], {"until": now_ms() + 60000})
    elif history == "command":
        execute(admin_app, "user.mute", [actors[3].id], {"until": now_ms() + 60000})
    credentials = rt.auth.reauth(
        actor,
        ReauthInput(
            action="account.delete",
            password=PASSWORD,
            secondFactor=factors[0].pop() if index == 0 else "",
        ),
    )
    rt.lifecycle.deletion_request(
        tokens[index],
        DeleteAccountInput(
            reauthToken=credentials["reauthToken"], confirmation=actor.user["username"]
        ),
    )
    with rt.db.write() as conn:
        conn.execute("UPDATE users SET deletion_at=? WHERE id=?", (now_ms() - 1, actor.id))
    result = rt.lifecycle.cleanup()
    assert result["accountsPurged"] == 1
    fails("AUTH_REQUIRED", lambda: rt.auth.load(tokens[index]))
    with rt.db.read() as conn:
        assert conn.execute(
            "SELECT status,nickname,password_hash FROM users WHERE id=?", (actor.id,)
        ).fetchone()[:] == ("deleted", "已注销用户", "!")
        rows = conn.execute("SELECT * FROM sessions WHERE user_id=?", (actor.id,)).fetchall()
        assert all(
            row["token_hash"] != actor.session["token_hash"]
            and row["device"] == ""
            and row["revoked_at"]
            and row["second_factor_at"] is None
            for row in rows
        )
        assert len(rows) == (1 if history == "command" else 0)
        assert not conn.execute("PRAGMA foreign_key_check").fetchall()
        if history == "command":
            assert (
                conn.execute(
                    "SELECT COUNT(*) FROM admin_commands WHERE actor_id=?", (actor.id,)
                ).fetchone()[0]
                == 1
            )


async def test_same_group_invites_batch_and_external_conflict(admin_app):
    app, actors, _, factors, _ = admin_app
    rt = app.runtime
    cid = create(rt, actors[2])["conversation"]["id"]
    ids = [link(rt, actors[2], cid)["invite"]["id"] for _ in range(4)]
    result, data, _ = execute(admin_app, "group.invite.revoke", ids[:2])
    assert result["status"] == "queued"
    rt.admin.process_command(claim_admin(rt))
    receipt = rt.admin.command(actors[0], data.operationId)
    assert receipt["status"] == "completed" and receipt["succeeded"] == 2 and receipt["failed"] == 0
    with rt.db.read() as conn:
        assert all(
            conn.execute("SELECT revoked_at FROM group_invites WHERE id=?", (iid,)).fetchone()[0]
            for iid in ids[:2]
        )
    pending = preview(rt, actors[0], "group.invite.revoke", ids[2:])
    credential = reauth(rt, actors[0], pending.operationId, factors[0].pop())
    with rt.db.write() as conn:
        conn.execute("UPDATE group_invites SET max_uses=max_uses+1 WHERE id=?", (ids[3],))
    fails("VERSION_CONFLICT", lambda: rt.admin.execute(actors[0], credential, str(uuid.uuid4())))
    with rt.db.read() as conn:
        assert (
            conn.execute(
                "SELECT consumed_at FROM reauth_tokens WHERE digest=?",
                (rt.auth.security.digest(credential.reauthToken, "reauth"),),
            ).fetchone()[0]
            is None
        )
        assert all(
            conn.execute("SELECT revoked_at FROM group_invites WHERE id=?", (iid,)).fetchone()[0]
            is None
            for iid in ids[2:]
        )
