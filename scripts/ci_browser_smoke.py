"""Isolated real-server browser/WS check; never reads an operator data directory."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from contextlib import closing
from pathlib import Path

import psutil
from websockets.asyncio.client import connect

from tongpin.config import Settings
from tongpin.contracts.chat import FriendRequestInput
from tongpin.contracts.groups import GroupCreate
from tongpin.runtime import Runtime

ROOT = Path(__file__).resolve().parents[1]


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


async def seed(settings):
    runtime = Runtime(settings)
    await runtime.start()
    try:
        rows = []
        with runtime.db.write() as conn:
            for index in range(2):
                user = runtime.auth.create_user(conn, f'ci_actor_{index}', f'跨平台检查 {index}', 'isolated-unused-password-hash')
                token, result = runtime.auth.issue_session(conn, user, False, 'isolated CI fixture')
                rows.append({'session': token, 'csrf': result['csrfToken'], 'userId': user['id']})
        owner, member = [runtime.auth.load(row['session']) for row in rows]
        request = runtime.contacts.request(owner, FriendRequestInput(targetUserId=member.id))
        runtime.contacts.decide(member, request['request']['id'], 'accept')
        group = runtime.groups.create(owner, GroupCreate(clientRequestId=str(uuid.uuid4()), name='CI 真实群聊', friendUserIds=[member.id]))['conversation']
        with runtime.db.write() as conn:
            runtime.groups.add_member(conn, group['id'], member.id)
        return {'baseUrl': settings.origins[0], 'cookieName': 'tp_session', 'owner': rows[0], 'member': rows[1],
                'group': {'id': group['id'], 'title': group['title'], 'accessKey': group['accessKey']},
                'messageText': '跨平台真实消息 ' + uuid.uuid4().hex,
                'taskTitle': '跨平台持久待办 ' + uuid.uuid4().hex}
    finally:
        await runtime.stop()


def http(fixture, path, *, actor=None, payload=None):
    headers = {'Origin': fixture['baseUrl']}
    if actor:
        headers.update(Cookie='tp_session=' + actor['session'], **{'X-CSRF-Token': actor['csrf']})
    if payload is not None:
        headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(fixture['baseUrl'] + path, data=json.dumps(payload).encode() if payload is not None else None, headers=headers)
    # CI loopback traffic does not depend on inherited proxy settings.
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=10) as response:
        return json.load(response)


async def wire(fixture):
    actor = fixture['owner']
    ticket = http(fixture, '/api/v1/auth/ws-ticket', actor=actor, payload={})['data']['ticket']
    endpoint = fixture['baseUrl'].replace('http:', 'ws:') + '/socket.io/?EIO=4&transport=websocket'
    async with connect(endpoint, origin=fixture['baseUrl'], additional_headers={'Cookie': 'tp_session=' + actor['session']}, proxy=None) as connection:
        assert connection.response.status_code == 101
        assert (await asyncio.wait_for(connection.recv(), 10)).startswith('0')
        await connection.send('40' + json.dumps({'ticket': ticket}))
        async def receive(prefix):
            async with asyncio.timeout(15):
                while True:
                    frame = await connection.recv()
                    if frame == '2':
                        await connection.send('3')
                    elif frame.startswith(prefix):
                        return frame
        await receive('40')
        command = {'v': 1, 'requestId': 'ci-wire', 'conversationId': fixture['group']['id'],
                   'clientMessageId': str(uuid.uuid4()), 'actorContext': actor['userId'],
                   'accessKey': fixture['group']['accessKey'], 'text': fixture['messageText']}
        await connection.send('421' + json.dumps(['message.send', command]))
        ack = json.loads((await receive('431'))[3:])[0]
        assert ack['ok'] and not ack['data']['duplicate'], 'Real WebSocket ACK failed'
    history = http(fixture, '/api/v1/conversations/' + fixture['group']['id'] + '/messages', actor=fixture['member'])['data']
    assert any(row['text'] == fixture['messageText'] for row in history['items'])
    return {'webSocketHandshake': 101, 'committedAck': True, 'receiverHttpHistory': True}


def stop(process):
    try:
        parent = psutil.Process(process.pid)
        children = parent.children(recursive=True)
    except psutil.NoSuchProcess:
        children = []
    for child in reversed(children):
        try:
            child.terminate()
        except psutil.NoSuchProcess:
            pass
    if process.poll() is None:
        process.terminate()
    try:
        process.wait(timeout=35)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)
    _, remaining = psutil.wait_procs(children, timeout=5)
    for child in remaining:
        child.kill()
    psutil.wait_procs(remaining, timeout=5)
    return process.poll() is not None and not any(child.is_running() for child in children)


def browser_failure(work, fixture, code):
    summary = {'browserExitCode': code}
    try:
        report = json.loads((work / 'observed-browser.json').read_text(encoding='utf-8'))
        for key in ('status', 'failure', 'diagnostics', 'errors', 'authResponses', 'assets'):
            summary[key] = report.get(key)
        summary['failedStep'] = next((item['name'] for item in report.get('steps', []) if item['status'] == 'failed'), None)
    except (OSError, ValueError, TypeError, KeyError) as error:
        summary['reportReadError'] = type(error).__name__
        try:
            summary['browserLogTail'] = (work / 'browser-process.log').read_text(encoding='utf-8', errors='replace')[-6000:]
        except OSError:
            summary['browserLogTail'] = '[unavailable]'
    text = json.dumps(summary, ensure_ascii=True)
    for role in ('owner', 'member'):
        for key in ('session', 'csrf'):
            secret = fixture[role].get(key)
            if secret:
                text = text.replace(secret, '[redacted]')
    print(text, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work-dir', type=Path, help='New isolated directory; refuses an existing target')
    parser.add_argument('--wire-only', action='store_true', help='Container HTTP + real WS check without Node/browser')
    options = parser.parse_args()
    work = options.work_dir or ROOT / '.codex/artifacts/ci' / uuid.uuid4().hex
    work = work.absolute()
    if work.exists():
        raise ValueError('CI work directory must be new')
    work.mkdir(parents=True, mode=0o700)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    secret = secrets.token_urlsafe(48)
    settings = Settings(data_root=work / 'persistent', environment='test', host='127.0.0.1', port=port, origins=(origin,), secret=secret)
    fixture = asyncio.run(seed(settings))
    fixture_path = work / 'private-fixture.json'
    write(fixture_path, fixture)
    fixture_path.chmod(0o600)
    environment = {key: value for key, value in os.environ.items() if not key.startswith('TONGPIN_')}
    environment.update(TONGPIN_ENV='test', TONGPIN_HOST='127.0.0.1', TONGPIN_PORT=str(port), TONGPIN_ORIGINS=origin,
                       TONGPIN_DATA_DIR=str(settings.data_root), TONGPIN_SECRET=secret,
                       TONGPIN_FEATURE_TASKS='1', TONGPIN_FEATURE_TASKS_ENHANCED='1', PYTHONUTF8='1')
    result = {'passed': False, 'browser': not options.wire_only, 'platform': sys.platform, 'python': sys.version.split()[0], 'sqlite': sqlite3.sqlite_version}
    process = None
    try:
        with (work / 'server.log').open('w', encoding='utf-8') as stream:
            process = subprocess.Popen([sys.executable, '-m', 'tongpin'], cwd=ROOT, env=environment, stdout=stream, stderr=stream,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            for _ in range(200):
                if process.poll() is not None:
                    raise RuntimeError('Isolated service exited before readiness; see server.log')
                try:
                    http(fixture, '/health/ready')
                    break
                except (urllib.error.URLError, TimeoutError):
                    time.sleep(0.1)
            else:
                raise RuntimeError('Isolated service did not become ready')
            if options.wire_only:
                result['wire'] = asyncio.run(wire(fixture))
            else:
                node = shutil.which('node')
                if not node:
                    raise RuntimeError('Node.js is required for the browser check')
                environment.update(TONGPIN_CI_FIXTURE=str(fixture_path), TONGPIN_CI_OUTPUT=str(work))
                with (work / 'browser-process.log').open('w', encoding='utf-8') as browser_stream:
                    check_process = subprocess.Popen([node, str(ROOT / 'scripts/ci_browser_smoke.mjs')], cwd=ROOT, env=environment,
                                                     stdout=browser_stream, stderr=subprocess.STDOUT,
                                                     creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
                    try:
                        code = check_process.wait(timeout=240)
                    finally:
                        if check_process.poll() is None:
                            stop(check_process)
                result['browserExitCode'] = code
                if code:
                    browser_failure(work, fixture, code)
                    raise RuntimeError('Browser assertions failed; see observed-browser.json and browser-process.log')
            with closing(sqlite3.connect(settings.data_root / 'data/tongpin.sqlite3')) as conn:
                count = conn.execute('SELECT count(*) FROM messages WHERE text=?', (fixture['messageText'],)).fetchone()[0]
                assert count == 1, 'UI/WS send must persist exactly once'
                result['persistedMessages'] = count
                if not options.wire_only:
                    count = conn.execute('SELECT count(*) FROM todo_tasks WHERE title=? AND owner_id=?', (fixture['taskTitle'], fixture['owner']['userId'])).fetchone()[0]
                    assert count == 1, 'UI task creation must persist exactly once for the owner'
                    result['persistedTasks'] = count
                assert conn.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
                assert not conn.execute('PRAGMA foreign_key_check').fetchall()
                result['integrity'] = 'ok'
            result['passed'] = True
    finally:
        result['processStopped'] = stop(process) if process is not None else True
        fixture_path.unlink(missing_ok=True)
        write(work / 'observed.json', result)
        print(json.dumps(result))
        print('Evidence: ' + str(work))
    return 0 if result['passed'] and result['processStopped'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
