from __future__ import annotations

import importlib
import json
import sqlite3
from pathlib import Path

import httpx
import pytest

from tongpin.asgi import create_application
from tongpin.contracts.base import APIError
from tongpin.runtime import Runtime

PASSWORD = "Abc9!xyz"


@pytest.fixture
def manager(monkeypatch, settings):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1] / "scripts"))
    module = importlib.import_module("manage")
    monkeypatch.setattr(module.Settings, "from_env", lambda: settings)
    return module


def answers(monkeypatch, manager, plain, passwords):
    prompts = []
    plain, passwords = iter(plain), iter(passwords)

    def read(prompt, values):
        prompts.append(prompt)
        value = next(values)
        if isinstance(value, BaseException):
            raise value
        return value

    monkeypatch.setattr("builtins.input", lambda prompt: read(prompt, plain))
    monkeypatch.setattr(manager.getpass, "getpass", lambda prompt: read(prompt, passwords))
    return prompts


def rows(settings, query):
    with sqlite3.connect(settings.data_root / "data/tongpin.sqlite3") as conn:
        conn.row_factory = sqlite3.Row
        return [dict(row) for row in conn.execute(query)]


def test_init_retries_invalid_account_weak_password_and_confirmation(manager, monkeypatch, settings, capsys):
    prompts = answers(monkeypatch, manager, ["jzg", "1admin", "Admin_Test"],
                      ["short", "aaaaaaaa", PASSWORD, "different", PASSWORD, PASSWORD])
    assert manager.cli(["init-admin"]) == 0
    output = capsys.readouterr()
    assert "4–24" in output.out and "8–128" in output.out
    assert "不常见" in output.out and "两次输入的密码不一致" in output.out
    assert "初始化成功" in output.out and not output.err
    assert not any(word in output.out for word in ("Traceback", "otpauth", PASSWORD, "恢复码"))
    assert len(prompts) == 9
    user = rows(settings, "SELECT * FROM users")[0]
    assert user["username"] == user["nickname"] == "admin_test"
    assert user["site_role"] == "super_admin" and user["totp_secret"] is None
    assert user["password_hash"].startswith("$argon2id$")
    assert rows(settings, "SELECT * FROM recovery_codes") == []
    assert len(rows(settings, "SELECT * FROM audit_events WHERE action='admin.initialize'")) == 1


@pytest.mark.parametrize("cancel,status", [(KeyboardInterrupt(), 130), (EOFError(), 1)])
def test_init_cancel_does_not_create_account_and_releases_lock(manager, monkeypatch, settings, capsys, cancel, status):
    answers(monkeypatch, manager, ["admin_test"], [PASSWORD, cancel])
    assert manager.cli(["init-admin"]) == status
    assert "Traceback" not in capsys.readouterr().err
    assert rows(settings, "SELECT * FROM users") == []
    answers(monkeypatch, manager, ["admin_test"], [PASSWORD, PASSWORD])
    assert manager.cli(["init-admin"]) == 0


def test_init_existing_admin_is_informational_and_keeps_password(manager, monkeypatch, settings, capsys):
    answers(monkeypatch, manager, ["admin_test"], [PASSWORD, PASSWORD])
    assert manager.cli(["init-admin"]) == 0
    before = rows(settings, "SELECT * FROM users")
    answers(monkeypatch, manager, [], [])
    assert manager.cli(["init-admin"]) == 0
    assert "管理员已存在" in capsys.readouterr().out
    assert rows(settings, "SELECT * FROM users") == before


def test_init_duplicate_ordinary_username_retries_before_password(manager, monkeypatch, settings, capsys):
    runtime = Runtime(settings)
    runtime.initialize()
    try:
        with runtime.db.write() as conn:
            runtime.auth.create_user(conn, "used_name", "已有用户", runtime.auth.security.passwords.hash(PASSWORD))
    finally:
        runtime.cache.clear()
        runtime.executor.close()
        runtime.lock.release()
    prompts = answers(monkeypatch, manager, ["USED_NAME", "admin_test"], [PASSWORD, PASSWORD])
    assert manager.cli(["init-admin"]) == 0
    assert "此登录名已使用" in capsys.readouterr().out
    assert len(prompts) == 4
    assert [row["username"] for row in rows(settings, "SELECT username FROM users ORDER BY username")] == ["admin_test", "used_name"]


def test_init_storage_failure_rolls_back_and_reports_chinese(manager, monkeypatch, settings, capsys):
    answers(monkeypatch, manager, ["admin_test"], [PASSWORD, PASSWORD])
    def fail_audit(*args, **kwargs):
        raise sqlite3.OperationalError("isolated write failure")
    monkeypatch.setattr(manager, "audit", fail_audit)
    assert manager.cli(["init-admin"]) == 1
    assert "数据暂时无法读取或保存" in capsys.readouterr().err
    assert rows(settings, "SELECT * FROM users") == []


def test_init_locked_directory_does_not_prompt_or_crash(manager, monkeypatch, settings, capsys):
    runtime = Runtime(settings)
    runtime.initialize()
    try:
        answers(monkeypatch, manager, [], [])
        assert manager.cli(["init-admin"]) == 1
        output = capsys.readouterr().err
        assert "请先停止" in output and "Traceback" not in output
    finally:
        runtime.cache.clear()
        runtime.executor.close()
        runtime.lock.release()


@pytest.mark.asyncio
async def test_initialized_admin_can_login_reauth_and_is_protected_as_last_admin(manager, monkeypatch, settings):
    answers(monkeypatch, manager, ["admin_test"], [PASSWORD, PASSWORD])
    assert manager.cli(["init-admin"]) == 0
    app = create_application(settings)
    await app.runtime.start()
    try:
        origin = "http://127.0.0.1:8765"
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=origin, headers={"Origin": origin}) as client:
            bootstrap = (await client.get("/api/v1/auth/bootstrap")).json()["data"]
            client.headers["X-CSRF-Token"] = bootstrap["csrfToken"]
            login = await client.post("/api/v1/auth/login", json={"username": "admin_test", "password": PASSWORD, "admin": True})
            assert login.status_code == 200, login.text
            data = login.json()["data"]
            assert "recoveryCodes" not in data
            client.headers["X-CSRF-Token"] = data["csrfToken"]
            assert (await client.get("/api/v1/account/navigation")).json()["data"]["admin"] == {"href": "/admin"}
            assert (await client.get("/api/v1/admin/auth")).json()["data"]["secondFactorRequired"] is False
            result = await client.post("/api/v1/auth/reauth", json={"password": PASSWORD, "action": "account.delete"})
            assert result.status_code == 200, result.text
            actor = app.runtime.auth.load(client.cookies.get("tp_session"))
            assert app.runtime.lifecycle.deletion_preview(actor)["lastAdministrator"] is True
            from tongpin.admin.authz import last_admin_guard
            with app.runtime.db.read() as conn:
                with pytest.raises(APIError) as caught:
                    last_admin_guard(conn, actor.user)
                assert caught.value.code == "LAST_ADMIN"
                assert app.runtime.admin.administrator_view(conn, actor.user)["usable"] is True
                assert PASSWORD not in json.dumps([dict(row) for row in conn.execute("SELECT * FROM audit_events")])
    finally:
        await app.runtime.stop()
