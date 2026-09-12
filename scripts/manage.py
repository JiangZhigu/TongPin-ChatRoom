"""Protected, local, offline maintenance. No passwords are accepted in argv."""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys

import pyotp
from _common import environment

os.environ.update(environment(create_cache=False))

from tongpin.config import Settings
from tongpin.domain.security import (
    audit,
    clean_text,
    validate_password,
    validate_username,
)
from tongpin.infra.db import now_ms
from tongpin.runtime import Runtime


def main():
    parser = argparse.ArgumentParser(
        description="Tongpin local maintenance; stop the service before modifying its data directory."
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser(
        "init-admin", help="Interactively create the first administrator; no default credentials."
    )
    sub.add_parser('recover-admin', help='Offline host-only interactive recovery of an existing administrator; reasons, new password and verified authenticator required.')
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
    args = parser.parse_args()
    runtime = Runtime(Settings.from_env())
    try:
        runtime.initialize()
        if args.command == "init-admin":
            with runtime.db.read() as conn:
                if conn.execute(
                    "SELECT 1 FROM users WHERE site_role='super_admin' LIMIT 1"
                ).fetchone():
                    raise ValueError(
                        "An administrator already exists. Use the audited admin management workflow."
                    )
            username = validate_username(input("Administrator username: "))
            nickname = clean_text(input("Display name: "), 1, 32, "nickname")
            password = validate_password(getpass.getpass("Password (15-128 characters): "))
            if password != getpass.getpass("Repeat password: "):
                raise ValueError("Passwords do not match")
            secret = pyotp.random_base32()
            print("Add this secret to your authenticator in a private environment:")
            print(secret)
            print(pyotp.TOTP(secret).provisioning_uri(name=username, issuer_name="Tongpin"))
            code = getpass.getpass("Current authenticator code: ")
            if not pyotp.TOTP(secret).verify(code, valid_window=1):
                raise ValueError("Authenticator verification failed; no account was created")
            password_hash = runtime.auth.security.passwords.hash(password)
            encrypted = runtime.auth.security.fernet.encrypt(secret.encode()).decode()
            with runtime.db.write() as conn:
                if conn.execute(
                    "SELECT 1 FROM users WHERE site_role='super_admin' LIMIT 1"
                ).fetchone():
                    raise ValueError("An administrator already exists")
                user = runtime.auth.create_user(
                    conn,
                    username,
                    nickname,
                    password_hash,
                    site_role="super_admin",
                    totp_secret=encrypted,
                )
                recovery = runtime.auth.security.recovery_codes(conn, user["id"])
                factors = runtime.auth.security.recovery_codes(conn, user["id"], "second_factor")
                audit(
                    conn,
                    user["id"],
                    "admin.initialize",
                    user["id"],
                    reason="Local interactive first administrator setup",
                )
            print("Save these password recovery codes offline. They are displayed only once:")
            print("\n".join(recovery))
            print("Save these separate second-factor recovery codes offline:")
            print("\n".join(factors))
            print("Administrator initialized. Close this private console after saving the codes.")
        elif args.command == 'recover-admin':
            username = validate_username(input('Existing administrator username: '))
            reason = clean_text(input('Reason and identity verification performed (5-1000 characters): '), 5, 1000, 'reason')
            if input('Repeat the administrator username to confirm host recovery: ') != username:
                raise ValueError('Confirmation did not match; no account was changed')
            password = validate_password(getpass.getpass('New password (15-128 characters): '))
            if password != getpass.getpass('Repeat new password: '):
                raise ValueError('Passwords do not match')
            secret = pyotp.random_base32()
            print('Add this NEW secret in a private environment. The previous factor will be revoked:')
            print(secret)
            print(pyotp.TOTP(secret).provisioning_uri(name=username, issuer_name='Tongpin'))
            code = getpass.getpass('Current code from the NEW authenticator: ')
            result = runtime.admin.recover_local_administrator(username, password, secret, code, reason)
            print('Save the new password recovery codes offline:')
            print('\n'.join(result['recoveryCodes']))
            print('Save these separate new second-factor recovery codes offline:')
            print('\n'.join(result['secondFactorRecoveryCodes']))
            print('Recovery committed and audited. Old device sessions and recovery credentials are invalid.')
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
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, RuntimeError) as error:
        print(f"Maintenance stopped: {error}", file=sys.stderr)
        sys.exit(1)
