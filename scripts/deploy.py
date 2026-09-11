"""Local release operations. No global packages, automatic service stop or data rewind."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from contextlib import closing, contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def safe_path(value):
    path = Path(value).expanduser().absolute()
    for part in (path, *path.parents):
        if part.is_symlink() or (hasattr(part, 'is_junction') and part.is_junction()):
            raise ValueError('Paths cannot traverse a symlink or junction: ' + str(part))
    return path.resolve()


def dedicated(value):
    path = safe_path(value)
    if path == Path(path.anchor) or path == ROOT:
        raise ValueError('Choose a dedicated directory, not a drive root or the project root')
    return path


def write_json(path, value):
    path = safe_path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, name = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if Path(name).exists():
            Path(name).unlink()


def config_env(filename=None, release=ROOT):
    env = os.environ.copy()
    path = safe_path(filename) if filename else release / '.env'
    if filename and not path.is_file():
        raise ValueError('The specified environment file does not exist')
    if path.is_file():
        for line in path.read_text(encoding='utf-8-sig').splitlines():
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if '=' not in line:
                raise ValueError('Environment file contains a line without =')
            key, value = line.split('=', 1)
            key, value = key.strip(), value.strip()
            if not key.startswith('TONGPIN_'):
                raise ValueError('Only TONGPIN_ variables belong in the environment file')
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            env.setdefault(key, value)
    env['PYTHONUTF8'] = '1'
    return env


def local_python(release):
    path = release / ('.venv/Scripts/python.exe' if os.name == 'nt' else '.venv/bin/python')
    if not path.is_file():
        raise ValueError('Release .venv is missing; run its install command first')
    return str(path)


def call(command, *, release=ROOT, env=None, capture=False):
    return subprocess.run(command, cwd=release, env=env, check=True, text=True,
                          capture_output=capture, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)


def doctor():
    os_release = {}
    path = Path('/etc/os-release')
    if path.is_file():
        for line in path.read_text().splitlines():
            if '=' in line:
                key, value = line.split('=', 1)
                if key in ('ID', 'ID_LIKE', 'VERSION_ID'):
                    os_release[key] = value.strip('"')
    commands = {name: shutil.which(name) for name in ('uv', 'node', 'npm', 'docker', 'systemctl', 'launchctl', 'apt-get', 'dnf', 'yum', 'zypper', 'pacman', 'apk', 'brew', 'winget')}
    return {'platform': platform.platform(), 'python': platform.python_version(), 'sqlite': sqlite3.sqlite_version,
            'linux': os_release, 'commands': commands, 'project': str(ROOT),
            'required': {'python': '3.12.13', 'node': '24.15.x (source builds)', 'npm': '11.12.x', 'uv': '0.11.27 or compatible'},
            'next': 'Use the detected package manager or approved official binaries for exact runtimes; distro packages may be older. With an existing bootstrap Python and uv, install --download-python permits project-local Python download. Without systemd/launchd, use the foreground run entry under an approved supervisor. No sudo, global package, Docker or service installation is performed here.'}


def install(options):
    uv = os.environ.get('TONGPIN_UV') or shutil.which('uv')
    if not uv:
        raise ValueError('uv is missing; install uv or set TONGPIN_UV to an existing executable')
    env = config_env(options.env_file)
    cache = ROOT / '.codex/cache'
    cache.mkdir(parents=True, exist_ok=True)
    env.update(UV_CACHE_DIR=str(cache / 'uv'), UV_PYTHON_INSTALL_DIR=str(ROOT / '.codex/python'),
               npm_config_cache=str(cache / 'npm'), UV_LINK_MODE='copy')
    args = [uv, 'sync', '--locked', '--python', (ROOT / '.python-version').read_text().strip()]
    args += ['--group', 'dev'] if options.dev else ['--no-dev']
    if not options.download_python:
        args.append('--no-python-downloads')
    call(args, env=env)
    if options.build:
        sys.path.insert(0, str(ROOT / 'scripts'))
        from _common import npm
        call(npm('ci', '--ignore-scripts', '--no-audit', '--no-fund'), env=env)
        call([local_python(ROOT), str(ROOT / 'scripts/build.py')], env=env)
    elif not (ROOT / 'apps/web/dist/index.html').is_file():
        raise ValueError('Python installed. This source checkout needs install --build (Node/npm), or a verified release bundle containing apps/web/dist')
    return {'installed': True, 'developmentDependencies': options.dev, 'frontendBuilt': options.build, 'dataModified': False}


def schema_rows(database):
    if not database.is_file():
        return {}
    with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as conn:
        present = conn.execute("SELECT 1 FROM sqlite_master WHERE name='schema_migrations'").fetchone()
        return dict(conn.execute('SELECT version,checksum FROM schema_migrations')) if present else {}


def schema_compatible(release, database, *, allow_new):
    known = {int(path.name.split('_', 1)[0]): digest(path) for path in (release / 'src/tongpin/migrations').glob('[0-9]*.sql')}
    if not known:
        raise ValueError('Release has no migrations')
    recorded = schema_rows(database)
    if any(version not in known or known[version] != checksum for version, checksum in recorded.items()):
        raise ValueError('Release cannot read this database: newer schema or migration checksum mismatch; data was not rewound')
    if not allow_new and set(known) != set(recorded):
        raise ValueError('Rollback must use exactly the current compatible schema')
    return {'current': max(recorded, default=0), 'candidate': max(known), 'pending': sorted(set(known) - set(recorded))}


@contextmanager
def lock_data(data):
    from tongpin.infra.runtime_lock import RuntimeLock
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = RuntimeLock(data / 'instance.lock')
    lock.acquire()
    try:
        yield
    finally:
        lock.release()


def snapshot_data(data, backup_root):
    backup_root = dedicated(backup_root)
    if backup_root == data or data in backup_root.parents or backup_root in data.parents:
        raise ValueError('Upgrade snapshot directory must be separate from the live data directory')
    target = backup_root / ('upgrade-' + time.strftime('%Y%m%d-%H%M%S') + '-' + os.urandom(4).hex())
    target.mkdir(parents=True, mode=0o700)
    rows = []
    # Operation archives and logs remain in place; never rewind or delete them.
    for name in ('data', 'private-uploads', 'upload-tmp', 'development.key'):
        source = data / name
        if not source.exists():
            continue
        entries = sorted(source.rglob('*')) if source.is_dir() else [source]
        for entry in entries:
            safe_path(entry)
            if entry.is_dir():
                continue
            if not entry.is_file():
                raise ValueError('Upgrade snapshot encountered a non-regular file')
            relative = entry.relative_to(data)
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.copy2(entry, destination)
            checksum = digest(entry)
            if digest(destination) != checksum:
                raise ValueError('Upgrade snapshot byte verification failed')
            rows.append({'path': relative.as_posix(), 'sha256': checksum, 'bytes': destination.stat().st_size})
    write_json(target / 'snapshot.json', {'format': 1, 'sourceData': str(data), 'createdAt': int(time.time()), 'files': rows,
                                         'excludes': ['instance.lock', 'backups', 'exports', 'logs', 'externally provided production secrets'], 'automaticRestore': False})
    return target


def release_checks(release):
    release = safe_path(release)
    for name in ('pyproject.toml', 'uv.lock', 'src/tongpin/__main__.py', 'apps/web/dist/index.html'):
        if not (release / name).is_file():
            raise ValueError('Incomplete release: ' + name)
    from build_receipt import verify
    from release import verify_staged
    verify(release)
    if (release / 'release-manifest.json').exists():
        verify_staged(release)
    executable = local_python(release)
    probe = call([executable, '-c', 'import sys,tongpin,flask,socketio,sqlite3; assert sys.version_info[:3]==(3,12,13); print(sqlite3.sqlite_version)'], release=release, capture=True)
    return {'release': str(release), 'sqlite': probe.stdout.strip()}


def activate(options, *, rollback=False):
    from tongpin.infra.runtime_lock import RuntimeLock
    state_path = safe_path(options.state)
    state_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    controller_lock = RuntimeLock(state_path.with_suffix(state_path.suffix + '.lock'))
    controller_lock.acquire()
    try:
        state = json.loads(state_path.read_text(encoding='utf-8')) if state_path.exists() else {}
        if rollback and not state.get('previousRelease'):
            raise ValueError('No previous release is recorded')
        release = safe_path(state['previousRelease'] if rollback else options.release)
        data = dedicated(state['dataDir'] if rollback else options.data_dir)
        if state and safe_path(state['dataDir']) != data:
            raise ValueError('Deployment data directory cannot change during an activation')
        if release == data or release in data.parents or data in release.parents:
            raise ValueError('Managed release and persistent data directories must be separate')
        if state_path == release or release in state_path.parents or state_path == data or data in state_path.parents:
            raise ValueError('Deployment state must be stored outside every release and persistent data directory')
        previous = state.get('activeRelease')
        if previous and safe_path(previous) in state_path.parents:
            raise ValueError('Deployment state cannot be stored inside the active release')
        if state.get('activeRelease') and safe_path(state['activeRelease']) == release:
            raise ValueError('Release is already active')
        backup_root = dedicated(options.backup_dir)
        for code_directory in (release, safe_path(previous) if previous else release):
            if backup_root == code_directory or code_directory in backup_root.parents or backup_root in code_directory.parents:
                raise ValueError('Upgrade snapshots must be stored outside release directories')
        probe = release_checks(release)
        with lock_data(data):
            database = data / 'data/tongpin.sqlite3'
            schemas = schema_compatible(release, database, allow_new=not rollback)
            snapshot = snapshot_data(data, backup_root)
            env = config_env(options.env_file, release)
            env['TONGPIN_DATA_DIR'] = str(data)
            if not rollback:
                migrate = ('from tongpin.config import Settings; from tongpin.infra.paths import DataPaths; '
                           'from tongpin.infra.db import Database; s=Settings.from_env(); p=DataPaths(s.data_root); '
                           'p.prepare(); d=Database(p.database); print(d.migrate())')
                call([local_python(release), '-c', migrate], release=release, env=env, capture=True)
            with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as conn:
                if conn.execute('PRAGMA integrity_check').fetchone()[0] != 'ok' or conn.execute('PRAGMA foreign_key_check').fetchall():
                    raise ValueError('Candidate database verification failed; deployment pointer unchanged')
            result = {'format': 1, 'activeRelease': str(release), 'previousRelease': state.get('activeRelease'),
                      'dataDir': str(data), 'snapshot': str(snapshot), 'activatedAt': int(time.time()),
                      'operation': 'rollback' if rollback else 'activate', 'schema': schema_rows(database),
                      'automaticServiceStart': False, 'dataRewound': False}
            write_json(state_path, result)
        return {**result, 'compatibility': schemas, 'probe': probe}
    finally:
        controller_lock.release()


def precheck(options):
    release = safe_path(options.release or ROOT)
    env = config_env(options.env_file, release)
    if options.data_dir:
        env['TONGPIN_DATA_DIR'] = str(dedicated(options.data_dir))
    # Execute the candidate's own Settings without importing another release.
    script = release / 'scripts/release_precheck.py'
    if not script.is_file():
        raise ValueError('Candidate precheck entry is missing')
    result = subprocess.run([local_python(release), str(script)], cwd=release, env=env, text=True, capture_output=True, check=False,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    if result.stdout:
        print(result.stdout.rstrip())
    if result.stderr:
        print('Precheck could not complete; inspect candidate dependencies/configuration.', file=sys.stderr)
    return result.returncode


def run_service(options):
    release = ROOT
    data = None
    if options.state:
        state = json.loads(safe_path(options.state).read_text(encoding='utf-8'))
        release, data = safe_path(state['activeRelease']), dedicated(state['dataDir'])
    env = config_env(options.env_file, release)
    if data:
        env['TONGPIN_DATA_DIR'] = str(data)
    executable = local_python(release)
    if env.get('TONGPIN_ENV') == 'production':
        result = subprocess.run([executable, str(release / 'scripts/release_precheck.py')], cwd=release, env=env, check=False)
        if result.returncode:
            raise ValueError('Production release precheck failed; service was not started')
    command = [executable, '-m', 'tongpin']
    if os.name != 'nt':
        os.chdir(release)
        os.execve(executable, command, env)
    process = subprocess.Popen(command, cwd=release, env=env)
    try:
        return process.wait()
    except KeyboardInterrupt:
        # Console Ctrl+C is delivered to the child; allow graceful shutdown first.
        try:
            return process.wait(timeout=35)
        except subprocess.TimeoutExpired:
            process.terminate()
            return process.wait(timeout=10)


def manage(options):
    if not options.arguments:
        raise ValueError('Provide an existing protected management command, such as init-admin or operator')
    return subprocess.run([local_python(ROOT), str(ROOT / 'scripts/manage.py'), *options.arguments],
                          cwd=ROOT, env=config_env(options.env_file), check=False).returncode


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument('--env-file', help='External protected TONGPIN_ configuration; existing environment wins')
    sub = result.add_subparsers(dest='command', required=True)
    sub.add_parser('doctor', help='Read-only platform and prerequisite inventory')
    install_parser = sub.add_parser('install', help='Sync this release .venv; no database writes or global installs')
    install_parser.add_argument('--dev', action='store_true')
    install_parser.add_argument('--build', action='store_true', help='Install locked Node dependencies and build frontend')
    install_parser.add_argument('--download-python', action='store_true', help='Permit uv to download Python into this project .codex/python')
    check = sub.add_parser('precheck', help='Read-only production readiness check; returns nonzero for missing operator configuration')
    check.add_argument('--release')
    check.add_argument('--data-dir')
    for name in ('activate', 'rollback'):
        action = sub.add_parser(name, help='Offline pointer switch; preserves current data and old release')
        action.add_argument('--state', required=True, help='Deployment pointer JSON outside release/data')
        action.add_argument('--backup-dir', required=True, help='Separate protected upgrade snapshot directory')
        if name == 'activate':
            action.add_argument('--release', required=True, help='Already extracted and installed candidate release')
            action.add_argument('--data-dir', required=True)
    serve = sub.add_parser('run', help='Foreground service; managed state is optional')
    serve.add_argument('--state')
    maintenance = sub.add_parser('manage', help='Run the existing protected offline management entry')
    maintenance.add_argument('arguments', nargs=argparse.REMAINDER)
    return result


def main():
    options = parser().parse_args()
    try:
        if options.command == 'precheck':
            return precheck(options)
        if options.command == 'run':
            return run_service(options)
        if options.command == 'manage':
            return manage(options)
        actions = {'doctor': lambda: doctor(), 'install': lambda: install(options),
                   'activate': lambda: activate(options), 'rollback': lambda: activate(options, rollback=True)}
        print(json.dumps(actions[options.command](), ensure_ascii=False, indent=2))
        return 0
    except (ValueError, TypeError, KeyError, OSError, RuntimeError, sqlite3.Error, subprocess.SubprocessError) as error:
        # Never print command environments, configuration bodies, or secrets.
        print('Operation stopped: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
