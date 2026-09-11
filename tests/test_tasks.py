from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

import httpx
import pytest
import pytest_asyncio
from pydantic import ValidationError
from test_groups import befriend, identities, key
from test_groups import create as create_group

from tongpin.asgi import create_application
from tongpin.contracts.base import APIError, InputModel
from tongpin.contracts.chat import MessageInput
from tongpin.contracts.tasks import (
    CheckCreate,
    CheckPatch,
    GroupTaskSettings,
    ReminderInput,
    TaskComment,
    TaskCopy,
    TaskCreate,
    TaskLabelInput,
    TaskMarks,
    TaskPatch,
    TaskPreferences,
    TaskReportInput,
    TaskShare,
)
from tongpin.infra.db import now_ms

pytestmark = pytest.mark.asyncio
ORIGIN = "http://127.0.0.1:8765"


@pytest_asyncio.fixture
async def tasks_app(settings):
    app = create_application(settings)
    await app.runtime.start()
    actors, tokens = identities(app.runtime)
    try:
        yield app, actors, tokens
    finally:
        await app.runtime.stop()


def error(code, fn):
    with pytest.raises(APIError) as caught:
        fn()
    assert caught.value.code == code
    return caught.value


def personal(rt, actor, **values):
    return rt.tasks.create(
        actor, TaskCreate(scope="personal", title="我的私密待办", **values), key()
    )["task"]


def group(rt, owner, *others):
    for user in others:
        befriend(rt, owner, user)
    gid = create_group(rt, owner)["conversation"]["id"]
    with rt.db.write() as conn:
        for user in others:
            rt.groups.add_member(conn, gid, user.id)
    return gid


def change(rt, actor, task, action, data=None, mutation_key=None, **options):
    return rt.tasks.mutate(
        actor,
        task["id"],
        action,
        data or InputModel(),
        mutation_key or key(),
        task["etag"],
        **options,
    )["task"]


async def test_personal_isolation_conditions_and_durable_command_keys(tasks_app):
    app, (a, b, *_), _ = tasks_app
    rt = app.runtime
    data = TaskCreate(
        scope="personal", title="  私密中文 🧪  ", description="private body", dueOn="2030-02-28"
    )
    create_key = key()
    result = rt.tasks.create(a, data, create_key)
    task = result["task"]
    assert task["title"] == "私密中文 🧪" and task["assignee"]["id"] == a.id
    assert task["etag"].startswith('"') and task["version"] == 1
    assert rt.tasks.create(a, data, create_key)["duplicate"]
    error(
        "IDEMPOTENCY_CONFLICT",
        lambda: rt.tasks.create(a, data.model_copy(update={"title": "changed"}), create_key),
    )
    error("TASK_UNAVAILABLE", lambda: rt.tasks.get(b, task["id"]))
    error(
        "TASK_UNAVAILABLE",
        lambda: rt.tasks.mutate(b, task["id"], "patch", TaskPatch(title="steal"), key(), "bad"),
    )
    assert rt.tasks.list(b, {"view": "personal", "q": "private"})["total"] == 0
    error(
        "PRECONDITION_REQUIRED",
        lambda: rt.tasks.mutate(a, task["id"], "patch", TaskPatch(status="doing"), key(), None),
    )
    update_key = key()
    latest = change(rt, a, task, "patch", TaskPatch(status="doing"), update_key)
    replay = rt.tasks.mutate(
        a, task["id"], "patch", TaskPatch(status="doing"), update_key, task["etag"]
    )
    assert replay["duplicate"] and replay["task"]["version"] == latest["version"]
    error("VERSION_CONFLICT", lambda: change(rt, a, task, "patch", TaskPatch(description="stale")))
    with rt.db.read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM todo_tasks").fetchone()[0] == 1
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM todo_mutation_keys WHERE user_id=?", (a.id,)
            ).fetchone()[0]
            == 2
        )


async def test_group_assignment_content_permissions_and_competing_claim(tasks_app):
    app, (owner, a, b, outsider, *_), _ = tasks_app
    rt = app.runtime
    gid = group(rt, owner, a, b)
    error(
        "FORBIDDEN",
        lambda: rt.tasks.create(
            a, TaskCreate(scope="group", groupId=gid, title="bad assign", assigneeId=b.id), key()
        ),
    )
    task = rt.tasks.create(a, TaskCreate(scope="group", groupId=gid, title="抢单"), key())["task"]
    b_view = rt.tasks.get(b, task["id"])
    assert b_view["capabilities"]["claim"] and not b_view["capabilities"]["edit"]
    error("TASK_UNAVAILABLE", lambda: rt.tasks.get(outsider, task["id"]))

    def compete(actor, dto):
        try:
            return change(rt, actor, dto, "claim")
        except APIError as exc:
            return exc.code

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda pair: compete(*pair), [(a, task), (b, b_view)]))
    assert sum(isinstance(item, dict) for item in results) == 1
    assert [item for item in results if isinstance(item, str)] == ["VERSION_CONFLICT"]
    assigned = rt.tasks.get(owner, task["id"])
    assigned = change(rt, owner, assigned, "patch", TaskPatch(assigneeId=b.id))
    bv = rt.tasks.get(b, task["id"])
    change(rt, b, bv, "patch", TaskPatch(status="doing"))
    error(
        "FORBIDDEN",
        lambda: change(rt, b, rt.tasks.get(b, task["id"]), "patch", TaskPatch(title="overreach")),
    )
    assert rt.tasks.list(b, {"view": "mine"})["total"] == 1
    error(
        "FORBIDDEN",
        lambda: change(rt, a, rt.tasks.get(a, task["id"]), "patch", TaskPatch(assigneeId=None)),
    )


async def test_membership_rejoin_same_millisecond_discussion_and_source(tasks_app):
    app, (owner, a, *_), _ = tasks_app
    rt = app.runtime
    gid = group(rt, owner, a)
    with rt.db.read() as conn:
        access = rt.access.conversation(conn, owner.id, gid)
    message = rt.chat.send(
        owner,
        gid,
        MessageInput(clientMessageId=key(), accessKey=access["accessKey"], text="before rejoin"),
    )["message"]
    task = rt.tasks.create(
        owner,
        TaskCreate(
            scope="group",
            groupId=gid,
            title="摘要仍可见",
            sourceMessageId=message["id"],
            assigneeId=a.id,
        ),
        key(),
    )["task"]
    task = change(rt, owner, task, "comment.create", TaskComment(text="old discussion"))
    assert len(rt.tasks.comments(a, task["id"])["items"]) == 1
    with rt.db.write() as conn:
        old_stamp = conn.execute("SELECT MAX(created_at) FROM todo_comments").fetchone()[0]
        rt.groups.remove_in(conn, gid, a.id, "removed")
    error("TASK_UNAVAILABLE", lambda: rt.tasks.get(a, task["id"]))
    with rt.db.write() as conn:
        period = rt.groups.add_member(conn, gid, a.id)
        # Deliberately make timestamps equal: per-period sequence floor must still hide old rows.
        conn.execute("UPDATE memberships SET joined_at=? WHERE id=?", (old_stamp, period))
    rejoined = rt.tasks.get(a, task["id"])
    assert rejoined["title"] == task["title"] and rejoined["assignee"] is None
    assert rejoined["source"] == {"available": False}
    assert rt.tasks.comments(a, task["id"])["items"] == []
    assert rt.tasks.activities(a, task["id"])["items"] == []
    new = change(rt, a, rejoined, "comment.create", TaskComment(text="new discussion"))
    assert [item["text"] for item in rt.tasks.comments(a, task["id"])["items"]] == [
        "new discussion"
    ]
    assert new["capabilities"]["claim"]


async def test_checks_soft_delete_recycle_and_key_tombstones(tasks_app):
    app, (a, b, *_), _ = tasks_app
    rt = app.runtime
    task = personal(rt, a)
    task = change(rt, a, task, "check.create", CheckCreate(text="尚未完成"))
    error("INCOMPLETE_CHECKS", lambda: change(rt, a, task, "patch", TaskPatch(status="done")))
    task = change(rt, a, task, "patch", TaskPatch(status="done", confirmIncomplete=True))
    assert task["checkItems"][0]["done"] is False
    task = change(
        rt, a, task, "check.patch", CheckPatch(done=True), item_id=task["checkItems"][0]["id"]
    )
    deletion_key = key()
    removed = change(rt, a, task, "remove", mutation_key=deletion_key)
    assert rt.tasks.list(a, {"view": "personal", "status": "all"})["total"] == 0
    assert rt.tasks.list(a, {"view": "personal", "deleted": "only", "status": "all"})["total"] == 1
    error("TASK_UNAVAILABLE", lambda: rt.tasks.get(b, task["id"]))
    assert rt.tasks.mutate(a, task["id"], "remove", InputModel(), deletion_key, task["etag"])[
        "duplicate"
    ]
    restored = change(rt, a, removed, "restore")
    assert restored["deletedAt"] is None
    removed = change(rt, a, restored, "remove")
    with rt.db.write() as conn:
        conn.execute(
            "UPDATE todo_tasks SET deleted_at=? WHERE id=?", (now_ms() - 31 * 86400000, task["id"])
        )
        rt.tasks.cleanup_in(conn, now_ms())
        assert conn.execute(
            "SELECT 1 FROM todo_mutation_keys WHERE key=?", (deletion_key,)
        ).fetchone()
    error("TASK_UNAVAILABLE", lambda: rt.tasks.get(a, task["id"]))


async def test_live_snapshot_copy_and_atomic_failed_share(tasks_app, monkeypatch):
    app, (owner, a, b, *_), _ = tasks_app
    rt = app.runtime
    gid = group(rt, owner, a)
    other_gid = group(rt, b)
    dm = rt.chat.direct(owner, a.id)["id"]
    private = personal(rt, owner, description="original private description")
    snap_key = key()
    share = TaskShare(destinationConversationId=dm, mode="snapshot", includeDescription=False)
    snap = rt.tasks.share(owner, private["id"], share, snap_key, private["etag"])
    assert rt.tasks.share(owner, private["id"], share, snap_key, private["etag"])["duplicate"]
    card = rt.tasks.card(a, snap["messageId"])
    assert card == {
        "kind": "snapshot",
        "snapshot": {
            "title": private["title"],
            "priority": "normal",
            "dueOn": None,
            "dueTimezone": "Asia/Shanghai",
        },
    }
    assert private["id"] not in json.dumps(card)
    copy = rt.tasks.create(
        a,
        TaskCreate(scope="personal", title="确认保存的副本", snapshotMessageId=snap["messageId"]),
        key(),
    )["task"]
    assert copy["id"] != private["id"] and copy["source"] is None
    changed = change(rt, owner, private, "patch", TaskPatch(title="changed original"))
    assert rt.tasks.card(a, snap["messageId"]) == card
    group_copy = rt.tasks.copy_to_group(
        owner,
        changed["id"],
        TaskCopy(groupId=gid, acknowledgeShared=True, title="explicit copy"),
        key(),
        changed["etag"],
    )["task"]
    assert group_copy["id"] != private["id"] and group_copy["source"] is None
    live = rt.tasks.share(
        owner,
        group_copy["id"],
        TaskShare(destinationConversationId=dm, mode="live"),
        key(),
        group_copy["etag"],
    )
    assert rt.tasks.card(a, live["messageId"])["task"]["id"] == group_copy["id"]
    error(
        "RESOURCE_UNAVAILABLE",
        lambda: rt.tasks.share(
            owner,
            group_copy["id"],
            TaskShare(destinationConversationId=other_gid, mode="live"),
            key(),
            group_copy["etag"],
        ),
    )
    with rt.db.write() as conn:
        rt.groups.remove_in(conn, gid, a.id, "removed")
    assert rt.tasks.card(a, live["messageId"]) == {"kind": "unavailable"}
    before = None
    with rt.db.read() as conn:
        before = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
    original = rt.tasks.key_store

    def fail_store(*args):
        raise RuntimeError("isolated failure before transaction commit")

    monkeypatch.setattr(rt.tasks, "key_store", fail_store)
    with pytest.raises(RuntimeError):
        rt.tasks.share(owner, changed["id"], share, key(), changed["etag"])
    monkeypatch.setattr(rt.tasks, "key_store", original)
    with rt.db.read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == before


async def test_personal_labels_preferences_group_policy_mute_and_reports(tasks_app):
    app, (owner, a, *_), _ = tasks_app
    rt = app.runtime
    label = rt.tasks.label(owner, TaskLabelInput(kind="tag", name="工作"), key())
    task = personal(rt, owner, tagIds=[label["id"]])
    assert rt.tasks.list(owner, {"tagId": label["id"]})["total"] == 1
    error("VALIDATION_ERROR", lambda: personal(rt, a, tagIds=[label["id"]]))
    task = change(rt, owner, task, "marks", TaskMarks(followed=True, bookmarked=True))
    assert rt.tasks.list(owner, {"view": "followed"})["total"] == 1
    rt.tasks.set_preferences(
        owner, TaskPreferences(comments=False, timezone="America/New_York"), key()
    )
    assert not rt.tasks.meta(owner)["preferences"]["comments"]
    report = rt.tasks.report(
        owner,
        task["id"],
        TaskReportInput(category="other", description="本人提交具体对象"),
        key(),
        task["etag"],
    )
    change(rt, owner, rt.tasks.get(owner, task["id"]), "remove")
    with rt.db.write() as conn:
        conn.execute(
            "UPDATE todo_tasks SET deleted_at=? WHERE id=?", (now_ms() - 31 * 86400000, task["id"])
        )
        assert rt.tasks.cleanup_in(conn, now_ms())["tasksPurged"] == 0
        assert conn.execute("SELECT id FROM todo_reports WHERE id=?", (report["id"],)).fetchone()
    gid = group(rt, owner, a)
    settings = rt.tasks.group_settings(owner, gid)
    rt.tasks.group_settings(
        owner, gid, GroupTaskSettings(createPolicy="managers"), key(), settings["etag"]
    )
    assert not rt.tasks.group_settings(a, gid)["canCreate"]
    error(
        "FORBIDDEN",
        lambda: rt.tasks.create(
            a, TaskCreate(scope="group", groupId=gid, title="no creation"), key()
        ),
    )
    with rt.db.write() as conn:
        conn.execute("UPDATE users SET muted_until=? WHERE id=?", (now_ms() + 10000, a.id))
    error("MUTED", lambda: personal(rt, a))


async def test_persistent_reminder_generation_receipt_and_timezone(tasks_app):
    from datetime import UTC, date, datetime

    from tongpin.tasks.timezones import due_bounds, local_instant

    app, (a, *_), _ = tasks_app
    rt = app.runtime
    start, end = due_bounds("2027-03-14", "America/New_York")
    assert end - start == 23 * 3600000
    instant = local_instant(date(2027, 3, 14), "02:30", "America/New_York")
    assert datetime.fromtimestamp(instant / 1000, UTC).hour == 7
    fold = local_instant(date(2027, 11, 7), "01:30", "America/New_York")
    assert datetime.fromtimestamp(fold / 1000, UTC).hour == 5
    task = personal(rt, a, dueOn="2030-03-01", dueTimezone="America/New_York")
    with rt.db.read() as conn:
        jobs = conn.execute("SELECT * FROM jobs WHERE kind='tasks.remind'").fetchall()
        assert len(jobs) == 1
        payload = json.loads(jobs[0]["payload_json"])
    assert rt.tasks.remind({"payload": payload})["delivered"]
    assert not rt.tasks.remind({"payload": payload})["delivered"]
    task = change(rt, a, task, "patch", TaskPatch(dueOn="2030-04-01"))
    assert not rt.tasks.remind({"payload": payload})["delivered"]
    task = change(rt, a, task, "reminder", ReminderInput(rule="none"))
    with rt.db.read() as conn:
        assert (
            conn.execute("SELECT COUNT(*) FROM notifications WHERE kind='task.due'").fetchone()[0]
            == 1
        )
    with pytest.raises(ValidationError):
        TaskCreate(scope="personal", title="x", dueOn="2030-02-30")
    with pytest.raises(ValidationError):
        TaskCreate(scope="personal", title="x", dueTimezone="Not/AZone")


async def test_http_actor_context_etag_schema_and_feature_off(tasks_app):
    app, (a, b, *_), tokens = tasks_app
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url=ORIGIN) as client:
        client.cookies.set(app.runtime.auth.cookie_name, tokens[0])
        boot = (await client.get("/api/v1/auth/bootstrap")).json()["data"]
        headers = {
            "Origin": ORIGIN,
            "X-CSRF-Token": boot["csrfToken"],
            "X-Actor-Context": a.id,
            "Idempotency-Key": key(),
        }
        response = await client.post(
            "/api/v1/tasks", headers=headers, json={"scope": "personal", "title": "真实HTTP"}
        )
        assert response.status_code == 201, response.text
        task = response.json()["data"]["task"]
        assert response.headers["etag"] == task["etag"]
        response = await client.patch(
            "/api/v1/tasks/" + task["id"],
            headers=headers | {"Idempotency-Key": key()},
            json={"status": "done"},
        )
        assert response.status_code == 428
        response = await client.get(
            "/api/v1/tasks/" + task["id"], headers={"X-Actor-Context": b.id}
        )
        assert response.status_code == 401
        response = await client.post(
            "/api/v1/tasks",
            headers=headers | {"Idempotency-Key": key()},
            json={"scope": "personal", "title": "x", "ownerId": b.id},
        )
        assert response.status_code == 422
        response = await client.get("/api/v1/tasks", params={"view": "personal", "limit": "0"})
        assert response.status_code == 422
        app.runtime.settings = replace(app.runtime.settings, feature_tasks=False)
        response = await client.get("/api/v1/tasks/" + task["id"])
        assert response.status_code == 503
        response = await client.get("/api/v1/tasks/meta")
        assert response.json()["data"]["enabled"] is False
        assert (await client.get("/api/v1/conversations")).status_code == 200
    with app.runtime.db.read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM todo_tasks").fetchone()[0] == 1
