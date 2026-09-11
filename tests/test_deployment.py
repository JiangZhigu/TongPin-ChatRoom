from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
import build_receipt
import deploy
import release
import release_precheck

from tongpin.infra.db import Database
from tongpin.infra.runtime_lock import RuntimeLock


def args(**kwargs):
    return SimpleNamespace(env_file=None, **kwargs)


def bundle(path, entries):
    rows = [{'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()} for name, data in entries.items()]
    with zipfile.ZipFile(path, 'w') as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
        archive.writestr(release.MANIFEST, json.dumps({'format': 1, 'commit': 'isolated-fixture', 'files': rows}))
    return deploy.digest(path)


def test_stage_verifies_full_bundle_before_creating_new_directory(tmp_path):
    archive = tmp_path/'release.zip'
    checksum = bundle(archive, {'README.md': b'fixture', 'src/example.py': b'pass\n'})
    destination = tmp_path/'new release'
    with pytest.raises(ValueError, match='SHA-256'):
        release.stage(args(bundle=str(archive), sha256='0'*64, destination=str(destination)))
    assert not destination.exists()
    result = release.stage(args(bundle=str(archive), sha256=checksum, destination=str(destination)))
    assert result['files'] == 2 and (destination/'src/example.py').read_bytes() == b'pass\n'
    assert release.verify_staged(destination)['files'] == 2
    (destination/'src/example.py').write_text('changed')
    with pytest.raises(ValueError, match='differs'):
        release.verify_staged(destination)
    with pytest.raises(ValueError, match='exists'):
        release.stage(args(bundle=str(archive), sha256=checksum, destination=str(destination)))


@pytest.mark.parametrize('name', ['../escape', 'src/../../escape', 'src/CON.txt', 'src/code.py.', 'src/.env', 'src\\escape.py'])
def test_stage_rejects_unsafe_entries_without_touching_target(tmp_path, name):
    archive = tmp_path/'bad.zip'
    checksum = bundle(archive, {name: b'unsafe'})
    destination = tmp_path/'absent'
    # Windows ZipInfo normalizes backslashes before validation; in that case the
    # unchanged manifest still rejects the different entry set before extraction.
    with pytest.raises(ValueError, match='Unsafe|entry sets differ'):
        release.stage(args(bundle=str(archive), sha256=checksum, destination=str(destination)))
    assert not destination.exists()


def test_stage_rejects_manifest_mismatch_and_case_collision(tmp_path):
    archive = tmp_path/'bad-content.zip'
    with zipfile.ZipFile(archive, 'w') as output:
        output.writestr('README.md', b'changed')
        output.writestr(release.MANIFEST, json.dumps({'format': 1, 'files': [{'path': 'README.md', 'bytes': 7, 'sha256': '0'*64}]}))
    with pytest.raises(ValueError, match='verification failed'):
        release.stage(args(bundle=str(archive), sha256=deploy.digest(archive), destination=str(tmp_path/'new')))
    second = tmp_path/'collision.zip'
    checksum = bundle(second, {'src/A.py': b'a', 'src/a.py': b'b'})
    with pytest.raises(ValueError, match='Unsafe'):
        release.stage(args(bundle=str(second), sha256=checksum, destination=str(tmp_path/'new')))
    assert not (tmp_path/'new').exists()


def test_build_receipt_rejects_changed_source_and_output(tmp_path):
    frontend = tmp_path/'apps/web'
    (frontend/'src').mkdir(parents=True)
    (frontend/'dist').mkdir()
    (frontend/'src/main.ts').write_text('const v = 1')
    (frontend/'package.json').write_text('{}')
    (frontend/'dist/index.html').write_text('<main>built</main>')
    (tmp_path/'package.json').write_text('{}')
    (tmp_path/'package-lock.json').write_text('{}')
    build_receipt.write(build_receipt.inputs(tmp_path), tmp_path)
    build_receipt.verify(tmp_path)
    (frontend/'dist/index.html').write_text('<main>changed</main>')
    with pytest.raises(ValueError, match='differs'):
        build_receipt.verify(tmp_path)
    before = build_receipt.inputs(tmp_path)
    (frontend/'src/main.ts').write_text('const v = 2')
    with pytest.raises(ValueError, match='changed during build'):
        build_receipt.write(before, tmp_path)


def test_upgrade_snapshot_preserves_bytes_and_refuses_nested_backup(tmp_path):
    data = tmp_path/'persistent'
    (data/'data').mkdir(parents=True)
    (data/'private-uploads').mkdir()
    (data/'backups').mkdir()
    (data/'data/tongpin.sqlite3').write_bytes(b'isolated database bytes')
    (data/'private-uploads/file.bin').write_bytes(b'attachment')
    (data/'development.key').write_text('isolated-development-key')
    (data/'backups/do-not-copy').write_text('retained archive')
    with pytest.raises(ValueError, match='separate'):
        deploy.snapshot_data(data, data/'snapshots')
    target = deploy.snapshot_data(data, tmp_path/'snapshots')
    manifest = json.loads((target/'snapshot.json').read_text())
    assert len(manifest['files']) == 3
    for row in manifest['files']:
        assert deploy.digest(data/row['path']) == deploy.digest(target/row['path']) == row['sha256']
    assert not (target/'backups').exists()
    assert (data/'backups/do-not-copy').read_text() == 'retained archive'


def test_activation_and_code_rollback_keep_current_data_and_refuse_running_instance(tmp_path, monkeypatch):
    old, new = tmp_path/'old', tmp_path/'new'
    for candidate in (old, new):
        shutil.copytree(ROOT/'src/tongpin/migrations', candidate/'src/tongpin/migrations')
    data = tmp_path/'persistent'
    (data/'data').mkdir(parents=True)
    db = Database(data/'data/tongpin.sqlite3')
    db.migrate()
    state_file = tmp_path/'control/active.json'
    backup = tmp_path/'snapshots'
    monkeypatch.setattr(deploy, 'release_checks', lambda path: {'release': str(path), 'fixture': 'dependency probe omitted in this pointer-only unit test'})
    monkeypatch.setattr(deploy, 'local_python', lambda path: sys.executable)
    # Candidate versions share the current real migration files; the separate
    # local release drill verifies installed candidate interpreters and entry points.
    monkeypatch.setattr(deploy, 'call', lambda *unused, **kw: db.migrate())
    first = args(state=str(state_file), release=str(old), data_dir=str(data), backup_dir=str(backup))
    deploy.activate(first)
    assert json.loads(state_file.read_text())['activeRelease'] == str(old)
    held = RuntimeLock(data/'instance.lock')
    held.acquire()
    next_release = args(state=str(state_file), release=str(new), data_dir=str(data), backup_dir=str(backup))
    try:
        with pytest.raises(RuntimeError, match='another Tongpin'):
            deploy.activate(next_release)
    finally:
        held.release()
    deploy.activate(next_release)
    with db.write() as conn:
        conn.execute("INSERT INTO instance_metadata VALUES('post-upgrade','must remain')")
    deploy.activate(args(state=str(state_file), backup_dir=str(backup)), rollback=True)
    assert json.loads(state_file.read_text())['activeRelease'] == str(old)
    with db.read() as conn:
        assert conn.execute("SELECT value FROM instance_metadata WHERE key='post-upgrade'").fetchone()[0] == 'must remain'
    (new/'src/tongpin/migrations/0011_future.sql').write_text('CREATE TABLE future_only(value TEXT);\n')
    Database(db.path, new/'src/tongpin/migrations').migrate()
    with pytest.raises(ValueError, match='newer schema'):
        deploy.schema_compatible(old, db.path, allow_new=False)


def test_offline_operator_command_is_audited_without_opening_registration(tmp_path):
    env = os.environ | {'TONGPIN_ENV': 'test', 'TONGPIN_HOST': '127.0.0.1', 'TONGPIN_PORT': '8765', 'TONGPIN_ORIGINS': 'http://127.0.0.1:8765', 'TONGPIN_DATA_DIR': str(tmp_path/'data'), 'TONGPIN_SECRET': 'isolated-operator-script-secret-'*3}
    result = subprocess.run([sys.executable, str(ROOT/'scripts/manage.py'), 'operator', '--name', '隔离运营者', '--contact', 'local test only', '--terms-version', 'isolated-reviewed-1', '--reason', 'isolated operator preparation'], cwd=tmp_path, env=env, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr
    with sqlite3.connect(tmp_path/'data/data/tongpin.sqlite3') as conn:
        rows = conn.execute('SELECT version,values_json FROM policy_versions ORDER BY version').fetchall()
        assert [row[0] for row in rows] == [0, 1]
        policy = json.loads(rows[-1][1])
        assert policy['operator_name'] == '隔离运营者' and policy['registration_mode'] == 'closed'
        assert conn.execute("SELECT count(*) FROM audit_events WHERE action='settings.local_operator'").fetchone()[0] == 1


def test_platform_wrapper_doctor_from_external_directory(tmp_path):
    if os.name == 'nt':
        command = ['cmd.exe', '/d', '/c', str(ROOT/'tongpin.cmd'), 'doctor']
    else:
        command = ['sh', str(ROOT/'tongpin.sh'), 'doctor']
    result = subprocess.run(command, cwd=tmp_path, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr
    document = json.loads(result.stdout)
    assert Path(document['project']).resolve() == ROOT.resolve()
    assert document['required']['python'] == '3.12.13'


def test_production_precheck_is_read_only_and_requires_operator_second_factor(tmp_path, monkeypatch):
    from tongpin.config import Settings
    from tongpin.runtime import Runtime
    settings = Settings(data_root=tmp_path/'persistent', environment='production',
                        origins=('https://isolated.invalid',), secret='isolated-precheck-secret-'*3)
    settings.validate()
    runtime = Runtime(settings)
    try:
        runtime.initialize()
        monkeypatch.setattr(release_precheck.Settings, 'from_env', lambda: settings)
        before = deploy.digest(runtime.paths.database)
        denied = release_precheck.check()
        assert not denied['ready'] and deploy.digest(runtime.paths.database) == before
        failed = {row['check'] for row in denied['checks'] if not row['passed']}
        assert {'administrator', 'operator', 'terms'} <= failed
        with runtime.db.write() as conn:
            runtime.auth.create_user(conn, 'precheck_admin', '隔离管理员', 'unused-test-hash',
                                     site_role='super_admin', totp_secret=runtime.auth.security.fernet.encrypt(b'isolated-second-factor').decode())
            policy = dict(runtime.policy.get())
            policy.update(operator_name='隔离运营者', operator_contact='isolated test only', terms_version='reviewed-isolated-1')
            conn.execute('INSERT INTO policy_versions VALUES(1,?,NULL,?,0)', (json.dumps(policy), 'isolated precheck fixture'))
        before = deploy.digest(runtime.paths.database)
        ready = release_precheck.check()
        assert ready['ready'], ready['checks']
        assert ready['readOnly'] and deploy.digest(runtime.paths.database) == before
    finally:
        asyncio.run(runtime.stop())
