from __future__ import annotations

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import httpx
import pytest
import test_auth
from test_auth import (
    ORIGIN,
    PASSWORD,
    captcha,
    register,
    registration_mode,
    seed_admin,
)

from tongpin.asgi import create_application
from tongpin.contracts.auth import LoginInput
from tongpin.contracts.base import APIError
from tongpin.infra.db import now_ms

client = test_auth.client
running_app = test_auth.running_app


async def attempt(client, username='friend_one', password=PASSWORD, **extra):
    bootstrap = (await client.get('/api/v1/auth/bootstrap')).json()['data']
    client.headers['X-CSRF-Token'] = bootstrap['csrfToken']
    response = await client.post('/api/v1/auth/login', json={
        'username': username, 'password': password, **extra,
    })
    if response.is_success:
        client.headers['X-CSRF-Token'] = response.json()['data']['csrfToken']
    return response


def failure_row(runtime, username='friend_one', ip='127.0.0.1'):
    security = runtime.auth.security
    with security.login_attempt(username, ip) as key, runtime.db.read() as conn:
        row = conn.execute('SELECT * FROM rate_buckets WHERE key=?', (key,)).fetchone()
    return dict(row) if row else None


async def trigger(client, username='friend_one'):
    for number in range(1, 6):
        response = await attempt(client, username, 'wrong password')
        assert response.status_code == 401
        assert response.json()['error']['code'] == (
            'LOGIN_FAILED' if number < 5 else 'LOGIN_CAPTCHA_REQUIRED'
        )


@pytest.mark.asyncio
async def test_default_open_registration_and_first_login_without_captcha(client, running_app):
    bootstrap = (await client.get('/api/v1/auth/bootstrap')).json()['data']
    assert bootstrap['registrationMode'] == 'open'
    created = await register(client)
    assert created.status_code == 201 and len(created.json()['data']['recoveryCodes']) == 8
    result = await attempt(client)
    assert result.status_code == 200, result.text
    assert (await client.get('/api/v1/auth/me')).json()['data']['user']['username'] == 'friend_one'
    assert failure_row(running_app.runtime) is None
    with running_app.runtime.db.read() as conn:
        assert conn.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 1


@pytest.mark.asyncio
async def test_five_failures_gate_password_check_and_success_clears_challenge(client, running_app):
    assert (await register(client)).status_code == 201
    await trigger(client)
    security = running_app.runtime.auth.security
    assert failure_row(running_app.runtime)['attempts'] == 5
    with patch.object(security, 'verify_password', wraps=security.verify_password) as verify:
        blocked = await attempt(client)
        assert blocked.json()['error']['code'] == 'LOGIN_CAPTCHA_REQUIRED'
        verify.assert_not_called()
        image = await captcha(client)
        bad_image = await attempt(client, **(image | {'captchaAnswer': 'WRONG'}))
        assert bad_image.json()['error']['code'] == 'CAPTCHA_INVALID'
        verify.assert_not_called()
    assert failure_row(running_app.runtime)['attempts'] == 5
    admitted = await attempt(client, **await captcha(client))
    assert admitted.status_code == 200, admitted.text
    assert failure_row(running_app.runtime) is None
    assert (await attempt(client)).status_code == 200


@pytest.mark.asyncio
async def test_success_before_threshold_resets_the_consecutive_sequence(client, running_app):
    assert (await register(client)).status_code == 201
    for _ in range(4):
        assert (await attempt(client, password='wrong')).json()['error']['code'] == 'LOGIN_FAILED'
    assert failure_row(running_app.runtime)['attempts'] == 4
    assert (await attempt(client)).status_code == 200
    assert failure_row(running_app.runtime) is None
    for _ in range(4):
        assert (await attempt(client, password='wrong')).json()['error']['code'] == 'LOGIN_FAILED'
    assert (await attempt(client, password='wrong')).json()['error']['code'] == 'LOGIN_CAPTCHA_REQUIRED'


@pytest.mark.asyncio
async def test_refresh_new_flow_and_username_case_cannot_bypass_challenge(client, running_app):
    assert (await register(client)).status_code == 201
    await trigger(client)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=running_app), base_url=ORIGIN,
                                headers={'Origin': ORIGIN}) as fresh:
        result = await attempt(fresh, username='FRIEND_ONE')
        assert result.json()['error']['code'] == 'LOGIN_CAPTCHA_REQUIRED'
        assert (await attempt(fresh, username='FRIEND_ONE', **await captcha(fresh))).status_code == 200
    assert failure_row(running_app.runtime) is None


@pytest.mark.asyncio
async def test_other_source_and_other_account_do_not_inherit_pair_failures(client, running_app):
    assert (await register(client)).status_code == 201
    assert (await register(client, username='friend_two')).status_code == 201
    await trigger(client)
    assert (await attempt(client, username='friend_two')).status_code == 200
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=running_app, client=('198.51.100.7', 12345)),
        base_url=ORIGIN, headers={'Origin': ORIGIN},
    ) as other:
        assert (await attempt(other)).status_code == 200
    assert failure_row(running_app.runtime)['attempts'] == 5


@pytest.mark.asyncio
async def test_quiet_period_expiry_allows_password_login_again(client, running_app):
    assert (await register(client)).status_code == 201
    await trigger(client)
    row = failure_row(running_app.runtime)
    with patch('tongpin.domain.security.now_ms', return_value=row['expires_at'] + 1):
        assert (await attempt(client)).status_code == 200
    assert failure_row(running_app.runtime) is None


@pytest.mark.asyncio
async def test_full_runtime_restart_retains_required_challenge(client, running_app, settings):
    assert (await register(client)).status_code == 201
    await trigger(client)
    await running_app.runtime.stop()
    restarted = create_application(settings)
    await restarted.runtime.start()
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=restarted), base_url=ORIGIN,
                                    headers={'Origin': ORIGIN}) as fresh:
            assert (await attempt(fresh)).json()['error']['code'] == 'LOGIN_CAPTCHA_REQUIRED'
            assert (await attempt(fresh, **await captcha(fresh))).status_code == 200
        assert failure_row(restarted.runtime) is None
    finally:
        await restarted.runtime.stop()


@pytest.mark.asyncio
async def test_concurrent_wrong_passwords_cannot_overrun_five_ungated_checks(running_app):
    service = running_app.runtime.auth
    calls = []
    original = service.security.verify_password

    def verify(*args):
        calls.append(1)
        return original(*args)

    def login(number):
        try:
            service.login(LoginInput(username='unknown_user', password='wrong'),
                          'independent-flow-' + str(number), '203.0.113.4', 'isolated concurrency')
        except APIError as error:
            return error.code
        return 'unexpected success'

    def execute():
        with ThreadPoolExecutor(max_workers=10) as executor:
            return list(executor.map(login, range(10)))

    with patch.object(service.security, 'verify_password', side_effect=verify):
        results = await asyncio.to_thread(execute)
    assert len(calls) == 5
    assert results.count('LOGIN_FAILED') == 4
    assert results.count('LOGIN_CAPTCHA_REQUIRED') == 6
    assert failure_row(running_app.runtime, 'unknown_user', '203.0.113.4')['attempts'] == 5
    assert len(service.security._login_locks) == 64


@pytest.mark.asyncio
async def test_second_factor_still_required_and_only_complete_login_resets(client, running_app):
    _, _, _, factors = seed_admin(running_app.runtime)
    initial = await attempt(client, username='site_admin', admin=True)
    assert initial.json()['error']['code'] == 'SECOND_FACTOR_REQUIRED'
    assert failure_row(running_app.runtime, 'site_admin') is None
    invalid = await attempt(client, username='site_admin', admin=True, secondFactor='invalid-factor')
    assert invalid.json()['error']['code'] == 'SECOND_FACTOR_INVALID'
    assert failure_row(running_app.runtime, 'site_admin') is None
    await trigger(client, 'site_admin')
    factor = await attempt(client, username='site_admin', admin=True, **await captcha(client))
    assert factor.json()['error']['code'] == 'SECOND_FACTOR_REQUIRED'
    assert failure_row(running_app.runtime, 'site_admin')['attempts'] == 5
    complete = await attempt(client, username='site_admin', admin=True,
                             secondFactor=factors[0], **await captcha(client))
    assert complete.status_code == 200
    assert failure_row(running_app.runtime, 'site_admin') is None
    assert (await client.get('/api/v1/admin/auth')).status_code == 200


@pytest.mark.asyncio
async def test_register_recover_and_saved_policy_keep_their_protection(client, running_app):
    # Making CAPTCHA optional on LoginInput must not relax the other contracts.
    without_captcha = await client.post('/api/v1/auth/register', json={
        'username': 'friend_one', 'nickname': '新用户', 'password': PASSWORD,
        'termsVersion': 'development-1', 'acceptTerms': True,
    })
    assert without_captcha.status_code == 422
    recovered = await client.post('/api/v1/auth/recover', json={
        'username': 'friend_one', 'recoveryCode': 'not-a-code', 'password': PASSWORD,
    })
    assert recovered.status_code == 422
    registration_mode(running_app.runtime, 'closed')
    assert (await register(client)).json()['error']['code'] == 'REGISTRATION_CLOSED'
    registration_mode(running_app.runtime, 'invite-only')
    assert (await register(client)).json()['error']['code'] == 'SITE_INVITE_INVALID'
    with running_app.runtime.db.read() as conn:
        assert conn.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 0
        assert json.loads(conn.execute('SELECT values_json FROM policy_versions ORDER BY version DESC LIMIT 1').fetchone()[0])['registration_mode'] == 'invite-only'


@pytest.mark.asyncio
async def test_expired_counter_slots_are_reclaimed_and_new_slots_are_bounded(running_app):
    runtime = running_app.runtime
    security = runtime.auth.security
    now = now_ms()
    with runtime.db.write() as conn:
        conn.executemany('INSERT INTO rate_buckets VALUES(?,?,?,?)',
                         [(f'isolated-{i}', now, 1, now + 60000) for i in range(20000)])
        with pytest.raises(APIError) as error:
            security.record_login_failure(conn, 'new-slot')
        assert error.value.code == 'TEMPORARY_UNAVAILABLE'
        conn.execute("UPDATE rate_buckets SET expires_at=? WHERE key='isolated-0'", (now - 1,))
        assert security.record_login_failure(conn, 'new-slot') is False
        assert conn.execute('SELECT COUNT(*) FROM rate_buckets').fetchone()[0] == 20000
