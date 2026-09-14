"""Protected, local, offline maintenance. No passwords are accepted in argv."""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sqlite3
import sys
import tempfile

from _common import environment

os.environ.update(environment(create_cache=False))

from tongpin.config import Settings
from tongpin.contracts.base import APIError
from tongpin.domain.security import (
    audit,
    clean_text,
    validate_password,
    validate_username,
)
from tongpin.infra.db import now_ms
from tongpin.runtime import Runtime


def prompt_validated(prompt, validator, *, hidden=False):
    while True:
        value = getpass.getpass(prompt) if hidden else input(prompt)
        try:
            return validator(value)
        except APIError as error:
            print("提示：" + " ".join((error.fields or {}).values() or [error.message]))


def prompt_password():
    while True:
        password = prompt_validated("管理员密码（8–128 个字符）：", validate_password, hidden=True)
        if password == getpass.getpass("再次输入密码："):
            return password
        print("提示：两次输入的密码不一致，请重新设置密码。")


def initialize_administrator(runtime):
    def available_username(value):
        username = validate_username(value)
        with runtime.db.read() as conn:
            if conn.execute("SELECT 1 FROM users WHERE username=? COLLATE NOCASE", (username,)).fetchone():
                raise APIError("USERNAME_UNAVAILABLE", "此登录名已使用，请换一个。", 409)
        return username

    with runtime.db.read() as conn:
        exists = conn.execute("SELECT 1 FROM users WHERE site_role='super_admin' LIMIT 1").fetchone()
    if exists:
        print("提示：管理员已存在，无需重复初始化。请使用已有账号登录。")
        return
    print("初始化管理员：只需设置账号和密码；按 Ctrl+C 可取消。")
    username = prompt_validated("管理员账号（字母开头，4–24 位字母、数字或下划线）：", available_username)
    password_hash = runtime.auth.security.passwords.hash(prompt_password())
    while True:
        try:
            with runtime.db.write() as conn:
                if conn.execute("SELECT 1 FROM users WHERE site_role='super_admin' LIMIT 1").fetchone():
                    print("提示：管理员已存在，无需重复初始化。请使用已有账号登录。")
                    return
                user = runtime.auth.create_user(
                    conn, username, username, password_hash, site_role="super_admin"
                )
                audit(conn, user["id"], "admin.initialize", user["id"], reason="本机交互初始化首位管理员")
            break
        except APIError as error:
            if error.code != "USERNAME_UNAVAILABLE":
                raise
            print("提示：此登录名已使用，请换一个；已设置的密码会保留。")
            username = prompt_validated("管理员账号：", available_username)
    print(f"管理员 {username} 初始化成功。可直接使用账号和密码登录管理后台。")
    print("显示名默认使用账号，可在登录后修改。")
    print("忘记密码时请联系管理员；首位管理员可在本机使用 manage recover-admin 重设密码。")


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="同频本地维护；修改数据前请先停止服务。"
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser(
        "init-admin", help="交互创建首位管理员，只需账号和密码；输入有误可重试。"
    )
    sub.add_parser('recover-admin', help='服务停止后，在本机为已有管理员重设密码。')
    policy = sub.add_parser(
        "registration",
        help="Set local registration access. Production changes to open use audited administrator configuration.",
    )
    policy.add_argument("mode", choices=["closed", "invite-only", "open"])
    policy.add_argument("--reason", required=True)
    operator = sub.add_parser('operator', help='Set reviewed operator information offline before production startup; registration remains unchanged.')
    operator.add_argument('--name', required=True)
    operator.add_argument('--contact', required=True)
    operator.add_argument('--terms-version', required=True)
    operator.add_argument('--reason', required=True)
    sub.add_parser("status", help="Read local account and runtime configuration status.")
    args = parser.parse_args(argv)
    runtime = Runtime(Settings.from_env())
    previous_tempdir = tempfile.tempdir
    try:
        runtime.initialize()
        if args.command == "init-admin":
            initialize_administrator(runtime)
        elif args.command == 'recover-admin':
            def existing_administrator(value):
                username = validate_username(value)
                with runtime.db.read() as conn:
                    user = conn.execute("SELECT 1 FROM users WHERE username=? COLLATE NOCASE AND site_role='super_admin' AND status IN('active','banned')", (username,)).fetchone()
                if not user:
                    raise APIError("ADMIN_NOT_FOUND", "未找到可恢复的管理员，请核对账号后重试。", 404)
                return username
            username = prompt_validated('需要恢复的管理员账号：', existing_administrator)
            reason = prompt_validated('恢复原因（5–1000 个字符）：', lambda value: clean_text(value, 5, 1000, 'reason'))
            while input('再次输入管理员账号以确认重设密码：').lower() != username:
                print('提示：账号不一致，请重新确认；按 Ctrl+C 可取消。')
            runtime.admin.recover_local_administrator(username, prompt_password(), reason)
            print('管理员密码已重设并记录操作，旧设备会话已退出。请使用新密码登录。')
        elif args.command == 'operator':
            values = {
                'operator_name': clean_text(args.name, 1, 100, 'name'),
                'operator_contact': clean_text(args.contact, 1, 200, 'contact'),
                'terms_version': clean_text(args.terms_version, 1, 80, 'termsVersion'),
            }
            if values['terms_version'].startswith('development'):
                raise ValueError('Choose a reviewed non-development terms version')
            reason = clean_text(args.reason, 5, 1000, 'reason')
            with runtime.db.write() as conn:
                current = runtime.policy.get(conn)
                previous_version = current.pop('version')
                if previous_version == 0:
                    conn.execute('INSERT OR IGNORE INTO policy_versions VALUES(0,?,NULL,?,?)', (json.dumps(current), 'Initial policy before offline operator configuration', now_ms()))
                current.update(values)
                conn.execute('INSERT INTO policy_versions VALUES(?,?,NULL,?,?)', (previous_version + 1, json.dumps(current), reason, now_ms()))
                audit(conn, None, 'settings.local_operator', reason=reason, details={'version': previous_version + 1})
            print('Operator information saved and audited. Registration policy was not changed.')
        elif args.command == "registration":
            reason = clean_text(args.reason, 5, 1000, "reason")
            if runtime.settings.production and args.mode == "open":
                raise ValueError(
                    "Use the production release precheck and audited administrator configuration before opening registration."
                )
            with runtime.db.write() as conn:
                values = runtime.policy.get(conn)
                version = values.pop("version") + 1
                values["registration_mode"] = args.mode
                conn.execute(
                    "INSERT INTO policy_versions VALUES(?,?,NULL,?,?)",
                    (version, json.dumps(values), reason, now_ms()),
                )
                audit(
                    conn,
                    None,
                    "settings.local_registration",
                    reason=reason,
                    details={"version": version, "mode": args.mode},
                )
            print(f"Registration mode saved: {args.mode}. Start the service to apply it.")
        else:
            with runtime.db.read() as conn:
                print(
                    json.dumps(
                        {
                            "environment": runtime.settings.environment,
                            "registrationMode": runtime.policy.get(conn)["registration_mode"],
                            "users": conn.execute("SELECT COUNT(*) FROM users").fetchone()[0],
                            "administrators": conn.execute(
                                "SELECT COUNT(*) FROM users WHERE site_role='super_admin' AND status='active'"
                            ).fetchone()[0],
                            "schema": runtime.db.health()["schemaVersion"],
                        },
                        indent=2,
                    )
                )
    finally:
        runtime.cache.clear()
        runtime.executor.close()
        runtime.lock.release()
        tempfile.tempdir = previous_tempdir
    return 0


def cli(argv=None):
    try:
        return main(argv)
    except KeyboardInterrupt:
        print("\n已取消本次操作。", file=sys.stderr)
        return 130
    except EOFError:
        print("\n提示：输入已结束，请在终端重新运行命令。", file=sys.stderr)
    except APIError as error:
        print("提示：" + " ".join((error.fields or {}).values() or [error.message]), file=sys.stderr)
    except RuntimeError:
        print("提示：维护暂时无法进行，请先停止使用此数据目录的同频服务，再重试。", file=sys.stderr)
    except (OSError, sqlite3.Error):
        print("提示：数据暂时无法读取或保存，请检查目录权限、磁盘空间及占用情况后重试。", file=sys.stderr)
    except ValueError:
        print("提示：配置或输入不符合要求，请检查后重试。", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(cli())
