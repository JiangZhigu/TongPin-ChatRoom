"""Bridge a system Python >= 3.8 to the project's locked runtime.

This file and bootstrap_uv.py deliberately use only the Python 3.8 stdlib.
System package managers are called by the native installers, never here.
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from bootstrap_uv import BootstrapError, _safe_path, ensure_uv

ROOT = Path(__file__).absolute().parents[1]


def runtime_environment(release):
    release = _safe_path(release)
    paths = {
        'UV_PYTHON_INSTALL_DIR': release / '.codex/python',
        'UV_CACHE_DIR': release / '.codex/cache/uv',
        'UV_PYTHON_BIN_DIR': release / '.codex/bin',
        'UV_PROJECT_ENVIRONMENT': release / '.venv',
    }
    env = os.environ.copy()
    for key in ('UV_PROJECT', 'UV_WORKING_DIR', 'UV_WORKING_DIRECTORY', 'UV_PYTHON'):
        env.pop(key, None)
    for key, path in paths.items():
        env[key] = str(_safe_path(path))
    env['PYTHONUTF8'] = '1'
    return env


def prepare_runtime(release, version, env):
    uv = env.get('TONGPIN_UV') or shutil.which('uv') or ensure_uv(release)
    print('Preparing project Python ' + version + ' using uv.', flush=True)
    subprocess.run([uv, 'python', 'install', version, '--no-bin', '--no-registry', '--no-config',
                    '--install-dir', env['UV_PYTHON_INSTALL_DIR'], '--cache-dir', env['UV_CACHE_DIR']],
                   cwd=release, env=env, check=True)
    result = subprocess.run([uv, 'python', 'find', version, '--managed-python',
                             '--no-python-downloads', '--no-project', '--no-config'],
                            cwd=release, env=env, check=True, capture_output=True, text=True)
    # uv-managed Unix installations may contain an interpreter symlink. Resolve
    # it, then require the executable to remain inside the checked install root.
    executable = Path(result.stdout.strip()).resolve()
    installation = Path(env['UV_PYTHON_INSTALL_DIR']).resolve()
    if not executable.is_file() or installation not in executable.parents:
        raise BootstrapError('uv returned a Python outside the project installation directory')
    probe = subprocess.run([str(executable), '-I', '-S', '-c',
                            'import sys; print(".".join(map(str, sys.version_info[:3])))'],
                           cwd=release, env=env, check=True, capture_output=True, text=True)
    if probe.stdout.strip() != version:
        raise BootstrapError('Downloaded Python does not match .python-version')
    env['TONGPIN_UV'] = uv
    return str(executable)


def install(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dev', action='store_true')
    parser.add_argument('--build', action='store_true')
    # Accepted for compatibility with the previous install entry's arguments.
    parser.add_argument('--bootstrap-tools', action='store_true')
    parser.add_argument('--download-python', action='store_true')
    options = parser.parse_args(arguments)
    if sys.version_info < (3, 8):  # noqa: UP036 - system bootstrap predates the project's runtime
        raise BootstrapError('The system bootstrap interpreter must be Python 3.8 or newer')
    release = _safe_path(ROOT)
    version = (release / '.python-version').read_text(encoding='ascii').strip()
    if not re.fullmatch(r'3\.12\.\d+', version):
        raise BootstrapError('Unsupported project Python version in .python-version')
    if not (release / 'scripts/deploy.py').is_file():
        raise BootstrapError('The release deployment entry is missing')
    if not options.build and not (release / 'apps/web/dist/index.html').is_file():
        raise BootstrapError('Frontend build is missing. Use a prebuilt ZIP, or install with --dev --build (requires Node/npm)')
    env = runtime_environment(release)
    executable = sys.executable
    if sys.version_info < (3, 12):  # noqa: UP036 - upgrade the older system bootstrap first
        executable = prepare_runtime(release, version, env)
    command = [executable, str(release / 'scripts/deploy.py'), 'install',
               '--bootstrap-tools', '--download-python']
    if options.dev:
        command.append('--dev')
    if options.build:
        command.append('--build')
    return subprocess.run(command, cwd=release, env=env, check=False).returncode


def main():
    try:
        return install()
    except KeyboardInterrupt:
        print('Installation cancelled; no automatic retry.', file=sys.stderr)
        return 130
    except subprocess.CalledProcessError as error:
        print('Runtime preparation failed; no automatic retry.', file=sys.stderr)
        return error.returncode or 1
    except (BootstrapError, OSError, ValueError) as error:
        print('Installation stopped: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
