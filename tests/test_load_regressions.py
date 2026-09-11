from __future__ import annotations

import asyncio
import threading

import pytest

from tongpin.infra.db import now_ms
from tongpin.infra.executors import BlockingExecutor, CapacityExceeded
from tongpin.jobs.repository import JobRepository
from tongpin.jobs.runner import JobRunner
from tongpin.runtime import Runtime


@pytest.mark.asyncio
async def test_pending_hints_coalesce_but_claimed_hints_never_hide_new_events(settings):
    runtime = Runtime(settings)
    runtime.initialize()
    runtime.db.keep_open()
    try:
        with runtime.db.write() as conn:
            users = [runtime.auth.create_user(conn, f'load_hint_{i}', f'提示{i}', 'unused') for i in range(2)]
            ids = [user['id'] for user in users]
            for i in range(8):
                runtime.events.publish(conn, ids, 'account.changed', users[i % 2]['id'])
        with runtime.db.read() as conn:
            assert conn.execute("SELECT count(*) FROM jobs WHERE kind='events.dispatch' AND status='pending'").fetchone()[0] == 1
            assert conn.execute('SELECT count(*) FROM user_events').fetchone()[0] == 16
        first = runtime.jobs.claim(kinds=('events.dispatch',))
        assert first and first['payload']['userIds'] == sorted(ids)
        with runtime.db.write() as conn:
            runtime.events.publish(conn, ids, 'account.changed', ids[0])
        second = runtime.jobs.claim(kinds=('events.dispatch',))
        assert second and first['id'] != second['id']
        runtime.jobs.fail(first['id'], 'ISOLATED_DELIVERY_FAILURE', 1)
        with runtime.db.write() as conn:
            runtime.events.publish(conn, ids, 'account.changed', ids[1])
        third = runtime.jobs.claim(kinds=('events.dispatch',))
        assert third and third['id'] not in (first['id'], second['id'])
        with runtime.db.read() as conn:
            assert conn.execute('SELECT count(*) FROM user_events').fetchone()[0] == 20
        runtime.jobs.complete(second['id'])
        runtime.jobs.complete(third['id'])
    finally:
        await runtime.stop()


@pytest.mark.asyncio
async def test_async_hint_handler_can_authorize_with_single_worker_and_retry_timeout(database):
    jobs = JobRepository(database)
    executor = BlockingExecutor(workers=1, backlog=0)
    runner = JobRunner(jobs, executor, kinds=('isolated.async',), async_timeout=.05)
    completed = asyncio.Event()
    cancelled = asyncio.Event()

    async def handler(job):
        if job['payload'].get('timeout'):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        value = await executor.run(lambda: 42)
        completed.set()
        return {'authorizedValue': value}

    runner.handlers['isolated.async'] = handler
    good = jobs.enqueue('isolated.async')
    timed = jobs.enqueue('isolated.async', {'timeout': True})
    runner.start()
    try:
        await asyncio.wait_for(completed.wait(), 5)
        await asyncio.wait_for(cancelled.wait(), 5)
        for _ in range(100):
            with database.read() as conn:
                row = conn.execute('SELECT * FROM jobs WHERE id=?', (timed,)).fetchone()
                done = conn.execute('SELECT * FROM jobs WHERE id=?', (good,)).fetchone()
            if row['last_error_code']:
                break
            await asyncio.sleep(.01)
        assert done['status'] == 'completed' and '42' in done['result_json']
        assert row['status'] == 'pending' and row['last_error_code'] == 'JOB_EXECUTION_FAILED'
        assert row['attempts'] == 1 and row['lease_until'] is None
        assert executor.stats()['rejected'] == 0
    finally:
        await runner.stop()
        executor.close()


@pytest.mark.asyncio
async def test_hint_dispatch_rechecks_revoked_connection_without_disclosing_payload(settings):
    runtime = Runtime(settings)
    runtime.initialize()
    emitted, disconnected = [], []

    class Transport:
        async def emit(self, event, payload, to):
            emitted.append((event, payload, to))

        async def disconnect(self, sid):
            disconnected.append(sid)

    runtime.transport = Transport()
    try:
        with runtime.db.write() as conn:
            user = runtime.auth.create_user(conn, 'hint_authority', '提示身份', 'unused')
            token, _ = runtime.auth.issue_session(conn, user, False, 'isolated')
        actor = runtime.auth.load(token)
        runtime.connections['isolated-sid'] = {'userId': user['id'], 'tokenHash': actor.session['token_hash']}
        await runtime._dispatch_job({'payload': {'userIds': [user['id']]}})
        assert emitted == [('sync.available', {}, 'isolated-sid')]
        emitted.clear()
        with runtime.db.write() as conn:
            conn.execute('UPDATE sessions SET revoked_at=? WHERE id=?', (now_ms(), actor.session['id']))
        await runtime._dispatch_job({'payload': {'userIds': [user['id']]}})
        assert not emitted and disconnected == ['isolated-sid']
    finally:
        await runtime.stop()


@pytest.mark.asyncio
async def test_runtime_idle_anchor_keeps_full_durability_and_closes_before_unlock(settings, tmp_path):
    runtime = Runtime(settings)
    await runtime.start()
    assert runtime.db._anchor is not None and not runtime.db._anchor.in_transaction
    with runtime.db.read() as conn:
        assert conn.execute('PRAGMA synchronous').fetchone()[0] == 2
        assert conn.execute('PRAGMA journal_mode').fetchone()[0] == 'wal'
    with runtime.db.write() as conn:
        conn.execute("INSERT INTO instance_metadata VALUES('anchor-proof','committed')")
    snapshot = tmp_path/'anchor-backup.sqlite3'
    runtime.db.backup(snapshot)
    await runtime.stop()
    assert runtime.db._anchor is None
    original = runtime.paths.database
    moved = original.with_name('stopped.sqlite3')
    original.rename(moved)
    moved.rename(original)


@pytest.mark.asyncio
async def test_executor_capacity_rejection_is_counted_without_unbounded_queue():
    executor = BlockingExecutor(workers=1, backlog=0)
    entered, release = threading.Event(), threading.Event()

    def blocked():
        entered.set()
        assert release.wait(5)

    running = asyncio.create_task(executor.run(blocked))
    try:
        while not entered.is_set():
            await asyncio.sleep(.001)
        with pytest.raises(CapacityExceeded):
            await executor.run(lambda: None)
        assert executor.stats() == {'inflight': 1, 'capacity': 1, 'rejected': 1, 'closed': False}
    finally:
        release.set()
        await running
        executor.close()
