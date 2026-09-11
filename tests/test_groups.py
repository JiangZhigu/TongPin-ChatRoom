from __future__ import annotations

import asyncio
import secrets
import uuid
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
import pytest_asyncio

from tongpin.asgi import create_application
from tongpin.contracts.base import APIError
from tongpin.contracts.chat import FriendRequestInput, MessageInput
from tongpin.contracts.groups import (
    GroupCommand,
    GroupCreate,
    GroupDissolveInput,
    GroupInviteInput,
    GroupMemberInput,
    GroupRemoveInput,
    GroupSettingsInput,
    GroupTransferInput,
)
from tongpin.infra.db import now_ms

pytestmark = pytest.mark.asyncio
ORIGIN = "http://127.0.0.1:8765"


def key():
    return str(uuid.uuid4())


def identities(runtime, count=5):
    tokens = []
    with runtime.db.write() as conn:
        for index in range(count):
            user = runtime.auth.create_user(
                conn, f"group_actor_{index}", f"群测试{index}", "isolated-unused-password-hash"
            )
            token, _ = runtime.auth.issue_session(conn, user, False, "isolated group test")
            tokens.append(token)
    return [runtime.auth.load(token) for token in tokens], tokens


@pytest_asyncio.fixture
async def groups_app(settings):
    app = create_application(settings)
    await app.runtime.start()
    actors, tokens = identities(app.runtime)
    try:
        yield app, actors, tokens
    finally:
        await app.runtime.stop()


def error(code, action):
    with pytest.raises(APIError) as caught:
        action()
    assert caught.value.code == code


def befriend(rt, one, two):
    request = rt.contacts.request(one, FriendRequestInput(targetUserId=two.id))
    rt.contacts.decide(two, request["request"]["id"], "accept")


def create(rt, owner, friends=None):
    return rt.groups.create(
        owner,
        GroupCreate(
            clientRequestId=key(), name="真实群测试", friendUserIds=[u.id for u in friends or []]
        ),
    )


def link(rt, owner, cid, uses=10):
    return rt.groups.invites.create(
        owner, cid, GroupInviteInput(clientRequestId=key(), maxUses=uses)
    )


def join(rt, owner, user, cid, invitation=None):
    invitation = invitation or link(rt, owner, cid)
    pending = rt.groups.invites.apply(
        user, invitation["invite"]["id"], GroupCommand(clientRequestId=key()), invitation["token"]
    )
    return (
        rt.groups.invites.decide(owner, pending["id"], "approve")
        if pending["status"] == "pending"
        else pending
    )


def member(rt, owner, cid, user):
    return next(
        row for row in rt.groups.members(owner, cid)["items"] if row["user"]["id"] == user.id
    )


def setting(rt, owner, cid, **changes):
    return rt.groups.update(
        owner,
        cid,
        GroupSettingsInput(expectedVersion=rt.groups.get(owner, cid)["version"], **changes),
    )


def text(rt, user, cid, value="group text", **changes):
    conversation = rt.chat.get(user, cid)
    return rt.chat.send(
        user,
        cid,
        MessageInput(
            clientMessageId=key(), text=value, accessKey=conversation["accessKey"], **changes
        ),
    )


def reauth(rt, actor, action):
    # Domain tests isolate the one-use gate; M2 and M5 real-browser flows cover password entry.
    token = secrets.token_urlsafe(32)
    with rt.db.write() as conn:
        conn.execute(
            "INSERT INTO reauth_tokens VALUES(?,?,?,?,NULL)",
            (
                rt.auth.security.digest(token, "reauth"),
                actor.session["id"],
                action,
                now_ms() + 300000,
            ),
        )
    return token


async def test_create_only_owner_direct_invitee_must_consent_and_all_retries_are_idempotent(
    groups_app,
):
    app, (owner, invitee, other, *_), _ = groups_app
    rt = app.runtime
    befriend(rt, owner, invitee)
    command = GroupCreate(clientRequestId=key(), name="有确认的邀请", friendUserIds=[invitee.id])
    created = rt.groups.create(owner, command)
    cid = created["conversation"]["id"]
    assert rt.groups.create(owner, command)["conversation"]["id"] == cid
    assert created["conversation"]["memberCount"] == 1
    error("RESOURCE_UNAVAILABLE", lambda: rt.groups.get(invitee, cid))
    invitation = rt.groups.invites.mine(invitee)["items"][0]
    assert invitation["kind"] == "direct"
    error(
        "RESOURCE_UNAVAILABLE",
        lambda: rt.groups.invites.apply(
            other, invitation["id"], GroupCommand(clientRequestId=key())
        ),
    )
    request = GroupCommand(clientRequestId=key())
    pending = rt.groups.invites.apply(invitee, invitation["id"], request)
    assert pending["status"] == "pending" and not pending["currentMember"]
    assert rt.groups.invites.apply(invitee, invitation["id"], request)["id"] == pending["id"]
    approved = rt.groups.invites.decide(owner, pending["id"], "approve")
    assert approved["status"] == "approved" and approved["currentMember"]
    assert rt.groups.invites.decide(owner, pending["id"], "approve")["status"] == "approved"
    assert rt.groups.get(invitee, cid)["conversation"]["memberCount"] == 2
    with rt.db.read() as conn:
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM memberships WHERE role='owner' AND left_at IS NULL"
            ).fetchone()[0]
            == 1
        )
        assert conn.execute("SELECT COUNT(*) FROM group_invites").fetchone()[0] == 1
        assert conn.execute("SELECT used_count FROM group_invites").fetchone()[0] == 1
    rt.groups.leave(invitee, cid)
    assert not rt.groups.invites.apply(invitee, invitation["id"], request)["currentMember"]
    assert not rt.groups.invites.decide(owner, pending["id"], "approve")["currentMember"]
    error("RESOURCE_UNAVAILABLE", lambda: rt.groups.get(invitee, cid))


async def test_role_matrix_current_version_and_current_membership_are_authoritative(groups_app):
    app, (owner, admin, peer, ordinary, outsider), _ = groups_app
    rt = app.runtime
    cid = create(rt, owner)["conversation"]["id"]
    invitation = link(rt, owner, cid)
    for user in (admin, peer, ordinary):
        join(rt, owner, user, cid, invitation)
    for user in (admin, peer):
        info = member(rt, owner, cid, user)
        rt.groups.member_update(
            owner,
            cid,
            user.id,
            GroupMemberInput(
                expectedVersion=rt.groups.get(owner, cid)["version"],
                periodId=info["periodId"],
                role="admin",
            ),
        )
    info = member(rt, owner, cid, ordinary)
    version = rt.groups.get(owner, cid)["version"]
    error(
        "FORBIDDEN",
        lambda: rt.groups.member_update(
            admin,
            cid,
            ordinary.id,
            GroupMemberInput(expectedVersion=version, periodId=info["periodId"], role="admin"),
        ),
    )
    error(
        "FORBIDDEN",
        lambda: rt.groups.member_update(
            ordinary,
            cid,
            ordinary.id,
            GroupMemberInput(expectedVersion=version, periodId=info["periodId"], role="admin"),
        ),
    )
    error(
        "FORBIDDEN",
        lambda: rt.groups.remove(
            admin,
            cid,
            peer.id,
            GroupRemoveInput(
                expectedVersion=version, periodId=member(rt, owner, cid, peer)["periodId"]
            ),
        ),
    )
    error("RESOURCE_UNAVAILABLE", lambda: rt.groups.get(outsider, cid))
    error("FORBIDDEN", lambda: setting(rt, admin, cid, reviewRequired=False))
    setting(rt, admin, cid, announcement="实际公告", announcementPinned=True)
    error(
        "VERSION_CONFLICT",
        lambda: rt.groups.member_update(
            owner,
            cid,
            ordinary.id,
            GroupMemberInput(expectedVersion=version, periodId=info["periodId"], role="admin"),
        ),
    )
    admin_info = member(rt, owner, cid, admin)
    rt.groups.member_update(
        owner,
        cid,
        admin.id,
        GroupMemberInput(
            expectedVersion=rt.groups.get(owner, cid)["version"],
            periodId=admin_info["periodId"],
            role="member",
        ),
    )
    error(
        "FORBIDDEN",
        lambda: rt.groups.update(
            admin,
            cid,
            GroupSettingsInput(
                expectedVersion=rt.groups.get(owner, cid)["version"], name="old admin page"
            ),
        ),
    )
    rt.groups.leave(ordinary, cid)
    join(rt, owner, ordinary, cid, invitation)
    error(
        "VERSION_CONFLICT",
        lambda: rt.groups.remove(
            owner,
            cid,
            ordinary.id,
            GroupRemoveInput(
                expectedVersion=rt.groups.get(owner, cid)["version"], periodId=info["periodId"]
            ),
        ),
    )


async def test_since_join_leave_rejoin_message_reference_and_incremental_event_visibility(
    groups_app,
):
    app, (owner, visitor, *_), _ = groups_app
    rt = app.runtime
    cid = create(rt, owner)["conversation"]["id"]
    old = text(rt, owner, cid, "before first join")["message"]
    invitation = link(rt, owner, cid)
    join(rt, owner, visitor, cid, invitation)
    first = rt.chat.get(visitor, cid)
    assert old["id"] not in {m["id"] for m in rt.chat.history(visitor, cid)["items"]}
    error(
        "RESOURCE_UNAVAILABLE",
        lambda: text(rt, visitor, cid, "cannot quote", replyToMessageId=old["id"]),
    )
    visible = text(rt, owner, cid, "during first period")["message"]
    cursor = rt.events.snapshot(visitor)["cursor"]
    rt.groups.leave(visitor, cid)
    for action in (
        lambda: rt.chat.history(visitor, cid),
        lambda: rt.chat.get(visitor, cid),
        lambda: text(rt, visitor, cid),
    ):
        error("RESOURCE_UNAVAILABLE", action)
    assert all("message" not in e for e in rt.events.sync(visitor, cursor)["items"])
    between = text(rt, owner, cid, "between periods")["message"]
    join(rt, owner, visitor, cid, invitation)
    current = rt.chat.get(visitor, cid)
    assert current["periodId"] != first["periodId"] and current["accessKey"] != first["accessKey"]
    history = rt.chat.history(visitor, cid)
    forbidden = {old["id"], visible["id"], between["id"]}
    assert not forbidden & {m["id"] for m in history["items"]}
    all_events = rt.events.sync(visitor, "0")["items"]
    assert not forbidden & {e["message"]["id"] for e in all_events if "message" in e}
    assert not any(e["type"] == "access.revoked" for e in all_events if "conversation" in e)
    assert any(e["type"] == "message.unavailable" for e in all_events)
    error("RESOURCE_UNAVAILABLE", lambda: text(rt, visitor, cid, replyToMessageId=visible["id"]))
    assert text(rt, owner, cid, "other members remain")["message"]["text"] == "other members remain"


async def test_last_invite_slot_parallel_reservation_rejection_and_group_capacity(
    groups_app, monkeypatch
):
    app, (owner, one, two, three, *_), _ = groups_app
    rt = app.runtime
    cid = create(rt, owner)["conversation"]["id"]
    invitation = link(rt, owner, cid, 1)

    def apply(user):
        try:
            return rt.groups.invites.apply(
                user,
                invitation["invite"]["id"],
                GroupCommand(clientRequestId=key()),
                invitation["token"],
            )
        except APIError as exc:
            return exc.code

    with ThreadPoolExecutor(max_workers=3) as pool:
        outcomes = list(pool.map(apply, [one, two, three]))
    accepted = [item for item in outcomes if isinstance(item, dict)]
    assert len(accepted) == 1 and outcomes.count("INVITE_EXHAUSTED") == 2
    pending = accepted[0]
    assert rt.groups.invites.list(owner, cid)["items"][0]["reserved"] == 1
    rt.groups.invites.decide(owner, pending["id"], "reject")
    rt.groups.invites.decide(owner, pending["id"], "reject")
    assert rt.groups.invites.list(owner, cid)["items"][0]["reserved"] == 0
    assert apply(two)["status"] == "pending"
    original = rt.policy.get
    monkeypatch.setattr(rt.policy, "get", lambda conn=None: original(conn) | {"group_limit": 2})
    other = link(rt, owner, cid)
    error(
        "GROUP_FULL",
        lambda: rt.groups.invites.apply(
            three, other["invite"]["id"], GroupCommand(clientRequestId=key()), other["token"]
        ),
    )
    still = rt.groups.invites.applications(owner, cid)["items"][0]
    rt.groups.invites.decide(owner, still["id"], "approve")
    assert rt.groups.get(owner, cid)["conversation"]["memberCount"] == 2


async def test_pending_cancellation_revocation_expiry_and_immediate_join(groups_app, monkeypatch):
    app, (owner, one, two, *_), _ = groups_app
    rt = app.runtime
    cid = create(rt, owner)["conversation"]["id"]
    invitation = link(rt, owner, cid, 1)
    assert rt.groups.invites.preview(invitation["token"])["remaining"] == 1
    pending = rt.groups.invites.apply(
        one, invitation["invite"]["id"], GroupCommand(clientRequestId=key()), invitation["token"]
    )
    assert rt.groups.invites.preview(invitation["token"], one)["state"] == "pending"
    assert rt.groups.invites.decide(one, pending["id"], "cancel")["status"] == "cancelled"
    assert rt.groups.invites.decide(one, pending["id"], "cancel")["status"] == "cancelled"
    again = rt.groups.invites.apply(
        two, invitation["invite"]["id"], GroupCommand(clientRequestId=key()), invitation["token"]
    )
    rt.groups.invites.revoke(owner, cid, invitation["invite"]["id"])
    assert rt.groups.invites.applications(two)["items"][0]["status"] == "expired"
    assert rt.groups.invites.decide(owner, again["id"], "approve")["status"] == "expired"
    assert rt.groups.invites.revoke(owner, cid, invitation["invite"]["id"])["reserved"] == 0
    assert rt.groups.invites.preview(invitation["token"])["state"] == "revoked"
    expiring = link(rt, owner, cid)
    last = rt.groups.invites.apply(
        one, expiring["invite"]["id"], GroupCommand(clientRequestId=key()), expiring["token"]
    )
    monkeypatch.setattr(
        "tongpin.domain.group_invites.now_ms", lambda: expiring["invite"]["expiresAt"] + 1
    )
    assert rt.groups.invites.preview(expiring["token"])["state"] == "expired"
    assert rt.groups.invites.applications(one)["items"][0]["status"] == "expired"
    assert rt.groups.expire_job({"payload": {"conversationId": cid}})["expiredTransfers"] == 0
    assert rt.groups.invites.decide(owner, last["id"], "approve")["status"] == "expired"
    monkeypatch.undo()
    setting(rt, owner, cid, reviewRequired=False)
    current = link(rt, owner, cid)
    joined = rt.groups.invites.apply(
        one, current["invite"]["id"], GroupCommand(clientRequestId=key()), current["token"]
    )
    assert joined["status"] == "approved" and joined["currentMember"]
    assert rt.groups.invites.preview(current["token"], one)["state"] == "already_member"


async def test_muting_slow_mode_idempotent_send_and_permission_epochs(groups_app):
    app, (owner, user, *_), _ = groups_app
    rt = app.runtime
    cid = create(rt, owner)["conversation"]["id"]
    join(rt, owner, user, cid)
    setting(rt, owner, cid, slowSeconds=60)
    conversation = rt.chat.get(user, cid)
    command = MessageInput(
        clientMessageId=key(), text="first slow message", accessKey=conversation["accessKey"]
    )
    assert not rt.chat.send(user, cid, command)["duplicate"]
    assert rt.chat.send(user, cid, command)["duplicate"]
    error("SLOW_MODE", lambda: text(rt, user, cid, "second too soon"))
    assert text(rt, owner, cid)["message"]
    setting(rt, owner, cid, everyoneMuted=True)
    error("MUTED", lambda: text(rt, user, cid))
    assert rt.chat.get(user, cid)["canSend"] is False
    assert text(rt, owner, cid)["message"]
    setting(rt, owner, cid, everyoneMuted=False, slowSeconds=0)
    error("STALE_ACCESS", lambda: rt.chat.send(user, cid, command))
    info = member(rt, owner, cid, user)
    rt.groups.member_update(
        owner,
        cid,
        user.id,
        GroupMemberInput(
            expectedVersion=rt.groups.get(owner, cid)["version"],
            periodId=info["periodId"],
            mutedUntil=now_ms() + 100000,
        ),
    )
    error("MUTED", lambda: text(rt, user, cid))
    rt.groups.member_update(
        owner,
        cid,
        user.id,
        GroupMemberInput(
            expectedVersion=rt.groups.get(owner, cid)["version"],
            periodId=info["periodId"],
            mutedUntil=None,
        ),
    )
    assert text(rt, user, cid)["message"]


async def test_transfer_requires_action_reauthentication_acceptance_and_one_owner(
    groups_app, monkeypatch
):
    app, (owner, target, other, *_), _ = groups_app
    rt = app.runtime
    cid = create(rt, owner)["conversation"]["id"]
    invitation = link(rt, owner, cid)
    join(rt, owner, target, cid, invitation)
    join(rt, owner, other, cid, invitation)
    error("OWNER_MUST_TRANSFER", lambda: rt.groups.leave(owner, cid))
    data = GroupTransferInput(
        clientRequestId=key(),
        expectedVersion=rt.groups.get(owner, cid)["version"],
        targetUserId=target.id,
        targetPeriodId=member(rt, owner, cid, target)["periodId"],
        reauthToken=reauth(rt, owner, "group_dissolve:" + cid),
    )
    error("REAUTH_REQUIRED", lambda: rt.groups.start_transfer(owner, cid, data))
    data = data.model_copy(update={"reauthToken": reauth(rt, owner, "group_transfer:" + cid)})
    transfer = rt.groups.start_transfer(owner, cid, data)
    assert rt.groups.start_transfer(owner, cid, data)["id"] == transfer["id"]
    assert rt.groups.get(owner, cid)["conversation"]["role"] == "owner"
    error("FORBIDDEN", lambda: rt.groups.decide_transfer(other, cid, transfer["id"], "accept"))
    original = rt.policy.get
    monkeypatch.setattr(
        rt.policy, "get", lambda conn=None: original(conn) | {"owned_group_limit": 0}
    )
    error(
        "OWNED_GROUP_LIMIT",
        lambda: rt.groups.decide_transfer(target, cid, transfer["id"], "accept"),
    )
    monkeypatch.undo()
    assert rt.groups.decide_transfer(target, cid, transfer["id"], "accept")["status"] == "accepted"
    assert rt.groups.decide_transfer(target, cid, transfer["id"], "accept")["status"] == "accepted"
    assert rt.groups.get(owner, cid)["conversation"]["role"] == "member"
    assert rt.groups.get(target, cid)["conversation"]["role"] == "owner"
    with rt.db.read() as conn:
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM memberships WHERE conversation_id=? AND role='owner' AND left_at IS NULL",
                (cid,),
            ).fetchone()[0]
            == 1
        )
        assert (
            conn.execute("SELECT owner_id FROM conversations WHERE id=?", (cid,)).fetchone()[0]
            == target.id
        )


async def test_transfer_expiry_rejection_cancellation_and_target_rejoin_cannot_change_owner(
    groups_app, monkeypatch
):
    app, (owner, target, *_), _ = groups_app
    rt = app.runtime
    cid = create(rt, owner)["conversation"]["id"]
    invitation = link(rt, owner, cid)
    join(rt, owner, target, cid, invitation)

    def begin():
        return rt.groups.start_transfer(
            owner,
            cid,
            GroupTransferInput(
                clientRequestId=key(),
                expectedVersion=rt.groups.get(owner, cid)["version"],
                targetUserId=target.id,
                targetPeriodId=member(rt, owner, cid, target)["periodId"],
                reauthToken=reauth(rt, owner, "group_transfer:" + cid),
            ),
        )

    rejected = begin()
    assert rt.groups.decide_transfer(target, cid, rejected["id"], "reject")["status"] == "rejected"
    cancelled = begin()
    assert rt.groups.decide_transfer(owner, cid, cancelled["id"], "cancel")["status"] == "cancelled"
    pending = begin()
    rt.groups.leave(target, cid)
    join(rt, owner, target, cid, invitation)
    assert rt.groups.decide_transfer(target, cid, pending["id"], "accept")["status"] == "cancelled"
    expiring = begin()
    monkeypatch.setattr("tongpin.domain.groups.now_ms", lambda: expiring["expiresAt"] + 1)
    assert rt.groups.decide_transfer(target, cid, expiring["id"], "accept")["status"] == "expired"
    assert rt.groups.get(owner, cid)["conversation"]["role"] == "owner"


async def test_dissolution_revokes_all_access_preserves_messages_and_is_audited(groups_app):
    app, (owner, member_user, pending_user, *_), _ = groups_app
    rt = app.runtime
    cid = create(rt, owner)["conversation"]["id"]
    invitation = link(rt, owner, cid)
    join(rt, owner, member_user, cid, invitation)
    pending = rt.groups.invites.apply(
        pending_user,
        invitation["invite"]["id"],
        GroupCommand(clientRequestId=key()),
        invitation["token"],
    )
    before = text(rt, member_user, cid, "preserved under retention")["message"]
    cursor = rt.events.snapshot(member_user)["cursor"]
    credential = reauth(rt, owner, "group_dissolve:" + cid)
    version = rt.groups.get(owner, cid)["version"]
    error(
        "FORBIDDEN",
        lambda: rt.groups.dissolve(
            member_user, cid, GroupDissolveInput(expectedVersion=version, reauthToken=credential)
        ),
    )
    assert rt.groups.dissolve(
        owner, cid, GroupDissolveInput(expectedVersion=version, reauthToken=credential)
    )["dissolved"]
    error("RESOURCE_UNAVAILABLE", lambda: rt.chat.history(member_user, cid))
    assert any(e["type"] == "access.revoked" for e in rt.events.sync(member_user, cursor)["items"])
    assert rt.groups.invites.applications(pending_user)["items"][0]["status"] == "expired"
    assert rt.groups.invites.decide(pending_user, pending["id"], "cancel")["status"] == "expired"
    with rt.db.read() as conn:
        assert (
            conn.execute("SELECT text FROM messages WHERE id=?", (before["id"],)).fetchone()[0]
            == "preserved under retention"
        )
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM audit_events WHERE subject_id=? AND action='group.dissolve'",
                (cid,),
            ).fetchone()[0]
            == 1
        )
        assert not conn.execute(
            "SELECT 1 FROM memberships WHERE conversation_id=? AND left_at IS NULL", (cid,)
        ).fetchone()
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert not conn.execute("PRAGMA foreign_key_check").fetchall()


async def test_group_mutation_event_failure_rolls_back_and_revoked_session_cannot_manage(
    groups_app, monkeypatch
):
    app, (owner, *_), _ = groups_app
    rt = app.runtime

    def fail(*args, **kwargs):
        raise OSError("isolated durable event write failure")

    original = rt.jobs.enqueue_in_transaction
    monkeypatch.setattr(rt.jobs, "enqueue_in_transaction", fail)
    with pytest.raises(OSError):
        create(rt, owner)
    with rt.db.read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM conversations").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM memberships").fetchone()[0] == 0
    monkeypatch.setattr(rt.jobs, "enqueue_in_transaction", original)
    cid = create(rt, owner)["conversation"]["id"]
    with rt.db.write() as conn:
        conn.execute("UPDATE sessions SET revoked_at=? WHERE id=?", (now_ms(), owner.session["id"]))
    error("AUTH_REQUIRED", lambda: rt.groups.get(owner, cid))
    error("AUTH_REQUIRED", lambda: rt.groups.leave(owner, cid))


async def test_invite_http_preview_is_public_nonconsuming_header_only_and_no_raw_token_in_database(
    groups_app, caplog
):
    app, (owner, _user, *_), tokens = groups_app
    rt = app.runtime
    cid = create(rt, owner)["conversation"]["id"]
    command = GroupInviteInput(clientRequestId=key(), maxUses=1)
    invitation = rt.groups.invites.create(owner, cid, command)
    assert rt.groups.invites.create(owner, cid, command)["token"] is None
    path = "/api/v1/group-invites/preview"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=ORIGIN) as client:
        for _ in range(3):
            response = await client.get(path, headers={"X-Group-Invite": invitation["token"]})
            assert response.status_code == 200
            data = response.json()["data"]
            assert data["remaining"] == 1 and data["state"] == "available"
            assert not {"messages", "members", "files"} & set(data)
        assert (await client.get(path)).status_code == 404
        apply_path = "/api/v1/group-invites/" + invitation["invite"]["id"] + "/apply"
        assert (
            await client.post(
                apply_path,
                json={"clientRequestId": key()},
                headers={"Origin": ORIGIN, "X-Group-Invite": invitation["token"]},
            )
        ).status_code in (401, 403)
        headers = {
            "Origin": ORIGIN,
            "Cookie": f"{rt.auth.cookie_name}={tokens[1]}",
            "X-CSRF-Token": rt.auth.security.csrf(tokens[1]),
            "X-Group-Invite": invitation["token"],
        }
        forged = await client.post(
            apply_path, json={"clientRequestId": key(), "role": "owner"}, headers=headers
        )
        assert forged.status_code == 422
        applied = await client.post(apply_path, json={"clientRequestId": key()}, headers=headers)
        assert applied.status_code == 201 and applied.json()["data"]["status"] == "pending"
        assert (await client.get(f"/api/v1/groups/{cid}", headers=headers)).status_code == 404
    with rt.db.read() as conn:
        assert invitation["token"] not in "\n".join(conn.iterdump())
    assert invitation["token"] not in caplog.text


async def test_pending_applications_and_expiry_jobs_survive_real_runtime_restart(settings):
    app = create_application(settings)
    await app.runtime.start()
    try:
        actors, tokens = identities(app.runtime, 2)
        owner, user = actors
        cid = create(app.runtime, owner)["conversation"]["id"]
        invitation = link(app.runtime, owner, cid)
        pending = app.runtime.groups.invites.apply(
            user,
            invitation["invite"]["id"],
            GroupCommand(clientRequestId=key()),
            invitation["token"],
        )
    finally:
        await app.runtime.stop()
    restarted = create_application(settings)
    await restarted.runtime.start()
    try:
        rt = restarted.runtime
        owner, user = [rt.auth.load(token) for token in tokens]
        assert rt.groups.invites.applications(user)["items"][0]["id"] == pending["id"]
        assert rt.groups.invites.list(owner, cid)["items"][0]["reserved"] == 1
        with rt.db.write() as conn:
            conn.execute(
                "UPDATE group_invites SET expires_at=? WHERE id=?",
                (now_ms() - 1, invitation["invite"]["id"]),
            )
            conn.execute(
                "UPDATE jobs SET run_after=? WHERE kind=? AND entity_id=?",
                (now_ms() - 1, "groups.expire", invitation["invite"]["id"]),
            )
        for _ in range(60):
            with rt.db.read() as conn:
                status = conn.execute(
                    "SELECT status FROM group_applications WHERE id=?", (pending["id"],)
                ).fetchone()[0]
            if status == "expired":
                break
            await asyncio.sleep(0.05)
        assert status == "expired"
        assert rt.groups.invites.list(owner, cid)["items"][0]["reserved"] == 0
        assert rt.groups.invites.decide(owner, pending["id"], "approve")["status"] == "expired"
    finally:
        await restarted.runtime.stop()


async def test_old_admin_cannot_approve_after_demotion_and_direct_invite_respects_changed_friendship(groups_app):
    app, (owner, admin, target, direct_target, *_), _ = groups_app
    rt = app.runtime
    cid = create(rt, owner)['conversation']['id']
    invitation = link(rt, owner, cid)
    join(rt, owner, admin, cid, invitation)
    info = member(rt, owner, cid, admin)
    rt.groups.member_update(owner, cid, admin.id, GroupMemberInput(expectedVersion=rt.groups.get(owner, cid)['version'], periodId=info['periodId'], role='admin'))
    pending = rt.groups.invites.apply(target, invitation['invite']['id'], GroupCommand(clientRequestId=key()), invitation['token'])
    rt.groups.member_update(owner, cid, admin.id, GroupMemberInput(expectedVersion=rt.groups.get(owner, cid)['version'], periodId=info['periodId'], role='member'))
    error('FORBIDDEN', lambda: rt.groups.invites.decide(admin, pending['id'], 'approve'))
    assert rt.groups.invites.applications(target)['items'][0]['status'] == 'pending'
    assert rt.groups.invites.decide(owner, pending['id'], 'approve')['currentMember']
    befriend(rt, owner, direct_target)
    direct = rt.groups.invites.create(owner, cid, GroupInviteInput(clientRequestId=key(), kind='direct', targetUserId=direct_target.id, maxUses=1))
    rt.contacts.set_block(direct_target, owner.id, True)
    error('CONTACT_UNAVAILABLE', lambda: rt.groups.invites.apply(direct_target, direct['invite']['id'], GroupCommand(clientRequestId=key())))
    with rt.db.read() as conn:
        assert rt.groups.invites.reserved(conn, cid, direct['invite']['id']) == 0


async def test_full_settings_http_preserves_queued_access_for_metadata_and_noop(groups_app):
    app, (owner, user, *_), tokens = groups_app
    rt = app.runtime
    detail = create(rt, owner)
    cid = detail["conversation"]["id"]
    join(rt, owner, user, cid)
    detail = rt.groups.get(owner, cid)
    old_access = rt.chat.get(user, cid)["accessKey"]
    old_seq = rt.chat.get(user, cid)["lastSeq"]
    headers = {
        "Origin": ORIGIN,
        "Cookie": f"{rt.auth.cookie_name}={tokens[0]}",
        "X-CSRF-Token": rt.auth.security.csrf(tokens[0]),
    }
    payload = detail["settings"] | {
        "expectedVersion": detail["version"],
        "name": "只改群名",
        "description": "只改简介",
    }
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=ORIGIN) as client:
        changed = await client.patch(f"/api/v1/groups/{cid}", json=payload, headers=headers)
        assert changed.status_code == 200, changed.text
        current = changed.json()["data"]
        assert current["version"] == detail["version"] + 1
        assert current["conversation"]["title"] == "只改群名"
        assert rt.chat.get(user, cid)["accessKey"] == old_access
        assert rt.chat.get(user, cid)["lastSeq"] == old_seq
        payload["expectedVersion"] = current["version"]
        noop = await client.patch(f"/api/v1/groups/{cid}", json=payload, headers=headers)
        assert noop.status_code == 200
        assert noop.json()["data"]["version"] == current["version"]
        assert rt.chat.get(user, cid)["accessKey"] == old_access
        assert rt.chat.get(user, cid)["lastSeq"] == old_seq
    queued = MessageInput(clientMessageId=key(), text="排队后只改了群名", accessKey=old_access)
    assert rt.chat.send(user, cid, queued)["message"]["text"] == queued.text
    setting(rt, owner, cid, announcement="真正的新公告")
    assert rt.chat.get(user, cid)["accessKey"] == old_access
    with rt.db.read() as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM messages WHERE conversation_id=? AND text='群公告已更新'",
            (cid,),
        ).fetchone()[0] == 1
        assert conn.execute(
            "SELECT COUNT(*) FROM audit_events WHERE action='group.settings' AND subject_id=?",
            (cid,),
        ).fetchone()[0] == 2
    setting(rt, owner, cid, slowSeconds=60)
    assert rt.chat.get(user, cid)["accessKey"] != old_access
    error("STALE_ACCESS", lambda: rt.chat.send(user, cid, queued))
    before_mute = rt.chat.get(user, cid)["accessKey"]
    setting(rt, owner, cid, everyoneMuted=True)
    assert rt.chat.get(user, cid)["accessKey"] != before_mute
    error("MUTED", lambda: text(rt, user, cid))
    setting(rt, owner, cid, everyoneMuted=False)
    error("STALE_ACCESS", lambda: rt.chat.send(user, cid, queued))


@pytest.mark.parametrize("decision,terminal", [("reject", "rejected"), ("cancel", "cancelled")])
async def test_preview_http_returns_terminal_then_latest_request_and_current_membership(
    groups_app, decision, terminal
):
    app, (owner, user, outsider, *_), tokens = groups_app
    rt = app.runtime
    cid = create(rt, owner)["conversation"]["id"]
    invitation = link(rt, owner, cid)
    iid, token = invitation["invite"]["id"], invitation["token"]
    headers = {"Cookie": f"{rt.auth.cookie_name}={tokens[1]}", "X-Group-Invite": token}
    first_key = GroupCommand(clientRequestId=key())
    pending = rt.groups.invites.apply(user, iid, first_key, token)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=ORIGIN) as client:
        async def preview():
            response = await client.get("/api/v1/group-invites/preview", headers=headers)
            assert response.status_code == 200
            return response.json()["data"]

        assert (await preview())["application"]["id"] == pending["id"]
        rt.groups.invites.decide(owner if decision == "reject" else user, pending["id"], decision)
        ended = await preview()
        assert ended["state"] == "available"
        assert ended["application"]["status"] == terminal
        assert not ended["application"]["currentMember"]
        assert rt.groups.invites.apply(user, iid, first_key, token)["id"] == pending["id"]
        again = rt.groups.invites.apply(user, iid, GroupCommand(clientRequestId=key()), token)
        assert again["id"] != pending["id"]
        assert (await preview())["application"]["id"] == again["id"]
        rt.groups.invites.decide(owner, again["id"], "approve")
        approved = await preview()
        assert approved["state"] == "already_member"
        assert approved["application"]["currentMember"]
        rt.groups.leave(user, cid)
        left = await preview()
        assert left["state"] == "available"
        assert left["application"]["status"] == "approved"
        assert not left["application"]["currentMember"]
        assert rt.groups.invites.preview(token)["application"] is None
        assert rt.groups.invites.preview(token, outsider)["application"] is None


async def test_direct_invite_mine_http_exposes_latest_owned_application_only(groups_app):
    app, (owner, user, outsider, *_), tokens = groups_app
    rt = app.runtime
    befriend(rt, owner, user)
    cid = create(rt, owner, [user])["conversation"]["id"]
    invite = rt.groups.invites.mine(user)["items"][0]
    assert invite["application"] is None
    first = GroupCommand(clientRequestId=key())
    pending = rt.groups.invites.apply(user, invite["id"], first)
    headers = {"Cookie": f"{rt.auth.cookie_name}={tokens[1]}"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=ORIGIN) as client:
        async def current():
            response = await client.get("/api/v1/group-invites/mine", headers=headers)
            assert response.status_code == 200
            return response.json()["data"]["items"][0]

        assert (await current())["application"]["id"] == pending["id"]
        rt.groups.invites.decide(user, pending["id"], "cancel")
        ended = await current()
        assert ended["state"] == "available" and ended["application"]["status"] == "cancelled"
        assert rt.groups.invites.apply(user, invite["id"], first)["id"] == pending["id"]
        second = rt.groups.invites.apply(user, invite["id"], GroupCommand(clientRequestId=key()))
        assert second["id"] != pending["id"]
        rt.groups.invites.decide(owner, second["id"], "reject")
        assert (await current())["application"]["status"] == "rejected"
        third = rt.groups.invites.apply(user, invite["id"], GroupCommand(clientRequestId=key()))
        rt.groups.invites.decide(owner, third["id"], "approve")
        assert (await current())["application"]["currentMember"]
        rt.groups.leave(user, cid)
        assert not (await current())["application"]["currentMember"]
    assert not rt.groups.invites.mine(outsider)["items"]
