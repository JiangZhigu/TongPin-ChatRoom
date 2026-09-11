from __future__ import annotations

import sqlite3
import time
from contextlib import closing

import pytest
from test_chat import chat_app as chat_app  # noqa: PLC0414 -- Export the shared pytest fixture.
from test_chat import command, direct


@pytest.mark.asyncio
@pytest.mark.parametrize('fault', ['busy', 'full'])
async def test_sqlite_fault_rolls_back_message_and_same_id_retries_once(chat_app, monkeypatch, fault):
    app, (owner, member, _), _ = chat_app
    runtime = app.runtime
    conversation = direct(runtime, owner, member)
    payload = command(conversation, '隔离空间与写锁检查' * 350)
    original_connect = runtime.db.connect
    with runtime.db.read() as conn:
        assert conn.execute('PRAGMA busy_timeout').fetchone()[0] == 5000
        before = conn.execute('SELECT count(*) FROM messages').fetchone()[0]
        events_before = conn.execute('SELECT count(*) FROM user_events').fetchone()[0]

    def limited_connection():
        conn = original_connect()
        if fault == 'busy':
            # Preserve the real engine error, shorten only the test wait budget.
            conn.execute('PRAGMA busy_timeout=40')
        else:
            # Real SQLITE_FULL via a per-connection page budget; no physical disk fill.
            pages = conn.execute('PRAGMA page_count').fetchone()[0]
            conn.execute(f'PRAGMA max_page_count={pages}')
        return conn

    with closing(sqlite3.connect(runtime.db.path, isolation_level=None)) as competitor:
        if fault == 'busy':
            competitor.execute('BEGIN IMMEDIATE')
        try:
            with monkeypatch.context() as patch:
                patch.setattr(runtime.db, 'connect', limited_connection)
                began = time.monotonic()
                with pytest.raises(sqlite3.OperationalError) as caught:
                    runtime.chat.send(owner, conversation['id'], payload)
                expected = sqlite3.SQLITE_BUSY if fault == 'busy' else sqlite3.SQLITE_FULL
                assert caught.value.sqlite_errorcode & 255 == expected
                assert time.monotonic() - began < 3
        finally:
            competitor.rollback()
    with runtime.db.read() as conn:
        assert conn.execute('SELECT count(*) FROM messages').fetchone()[0] == before
        assert conn.execute('SELECT count(*) FROM user_events').fetchone()[0] == events_before
    first = runtime.chat.send(owner, conversation['id'], payload)
    replay = runtime.chat.send(owner, conversation['id'], payload)
    assert not first['duplicate'] and replay['duplicate']
    assert first['message']['id'] == replay['message']['id']
    with runtime.db.read() as conn:
        assert conn.execute('SELECT count(*) FROM messages WHERE client_message_id=?', (payload.clientMessageId,)).fetchone()[0] == 1
        assert conn.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert not conn.execute('PRAGMA foreign_key_check').fetchall()
