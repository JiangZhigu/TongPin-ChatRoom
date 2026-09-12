"""Native installer branch tests: every system installer is an isolated fixture."""
from __future__ import annotations

import ast
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import bootstrap_runtime as runtime

SH = shutil.which('sh')
if not SH and os.name == 'nt' and Path('C:/Program Files/Git/bin/sh.exe').is_file():
    SH = 'C:/Program Files/Git/bin/sh.exe'


def release_fixture(tmp_path):
    candidate = tmp_path / 'release with spaces'
    (candidate / 'scripts').mkdir(parents=True)
    (candidate / 'apps/web/dist').mkdir(parents=True)
    (candidate / '.python-version').write_text('3.12.13\n')
    (candidate / 'scripts/bootstrap_runtime.py').write_text('# fixture\n')
    (candidate / 'scripts/deploy.py').write_text('# fixture\n')
    (candidate / 'apps/web/dist/index.html').write_text('<main>fixture</main>')
    return candidate


def executable(path, text):
    path.write_text(text, encoding='utf-8', newline='\n')
    path.chmod(0o700)


@pytest.fixture
def unix(tmp_path):
    if not SH:
        pytest.skip('POSIX shell unavailable')
    candidate = release_fixture(tmp_path)
    fake_bin = tmp_path / 'fake-bin'
    fake_bin.mkdir()
    log = tmp_path / 'commands.log'
    managers = ['apt-get', 'dnf', 'yum', 'pacman', 'zypper', 'apk', 'brew', 'sudo', 'doas']
    # All known managers and privilege tools shadow the host PATH. Even a
    # regression in selection cannot reach a real package-install command.
    for manager in managers:
        executable(fake_bin / manager, '''#!/bin/sh
name=${0##*/}
printf '%s|%s\n' "$name" "$*" >> "$TP_TEST_LOG"
if [ "$name" = sudo ] || [ "$name" = doas ]; then
    [ "${TP_TEST_AUTH_EXIT:-0}" = 0 ] || exit "$TP_TEST_AUTH_EXIT"
    [ "$1" = -v ] && exit 0
    exec "$@"
fi
if [ "$name" = brew ] && [ "$1" = --prefix ]; then printf '%s\n' "$TP_ROOT/brew-prefix"; exit 0; fi
if [ "${TP_TEST_MANAGER_EXIT:-0}" != 0 ]; then exit "$TP_TEST_MANAGER_EXIT"; fi
case "$*" in *install*|*add*|*-S*) : > "$TP_ROOT/python-installed" ;; esac
''')
    executable(candidate / 'fixture-python', '''#!/bin/sh
printf '%s\n' "$@" > "$TP_ROOT/runtime-args.txt"
exit "${TP_TEST_RUNTIME_EXIT:-0}"
''')
    release = tmp_path / 'os-release'
    release.write_text('ID=ubuntu\nVERSION_ID="24.04"\nID_LIKE=debian\n', newline='\n')
    env = os.environ.copy()
    env.update(TP_ROOT=candidate.as_posix(), TP_TEST_LOG=log.as_posix(),
               TP_TEST_RELEASE=release.as_posix(), TP_TEST_OS='Linux', TP_TEST_ARCH='x86_64',
               TP_TEST_UID='0', TP_TEST_BIN=fake_bin.as_posix(), TP_TEST_MANAGER_EXIT='0',
               TP_TEST_AUTH_EXIT='0', TP_TEST_RUNTIME_EXIT='0',
               PATH=str(fake_bin) + os.pathsep + os.environ.get('PATH', ''))
    library = (ROOT / 'scripts/bootstrap_unix.sh').as_posix()
    harness = f'''TP_FIXTURE_BIN=$(CDPATH= cd -- "$TP_TEST_BIN" && pwd)
PATH="$TP_FIXTURE_BIN:$PATH"
export PATH
. '{library}'
tp_has_command() {{
    case "$1" in
        apt-get|dnf|yum|pacman|zypper|apk|brew|sudo|doas|curl|shasum) [ -f "$TP_TEST_BIN/$1" ] ;;
        /opt/homebrew/bin/brew|/usr/local/bin/brew|/opt/local/bin/port) return 1 ;;
        *) command -v "$1" >/dev/null 2>&1 ;;
    esac
}}
uname() {{ if [ "$1" = -s ]; then printf '%s\n' "$TP_TEST_OS"; else printf '%s\n' "$TP_TEST_ARCH"; fi; }}
id() {{ printf '%s\n' "$TP_TEST_UID"; }}
sw_vers() {{ printf '%s\n' '15.0'; }}
tp_os_release_file() {{ printf '%s\n' "$TP_TEST_RELEASE"; }}
tp_find_python() {{
    if [ -f "$TP_ROOT/python-installed" ]; then TP_PYTHON="$TP_ROOT/fixture-python"; return 0; fi
    TP_PYTHON=; return 1
}}
tp_install "$@"
'''

    def run(*args, extra='', **values):
        selected = env | {key: str(value) for key, value in values.items()}
        # Insert test-specific function overrides before the actual entry call.
        script = harness.replace('tp_install "$@"', extra + '\ntp_install "$@"')
        result = subprocess.run([SH, '-c', script, 'fixture', *args], cwd=tmp_path,
                                env=selected, capture_output=True, text=True, check=False)
        rows = log.read_text().splitlines() if log.exists() else []
        return result, rows

    return SimpleNamespace(root=candidate, bin=fake_bin, release=release, env=env, run=run, log=log)


@pytest.mark.parametrize(('distro', 'version', 'parent', 'manager', 'package'), [
    ('ubuntu', '24.04', 'debian', 'apt-get', 'python3'),
    ('debian', '12', '', 'apt-get', 'python3'),
    ('linuxmint', '22', 'ubuntu debian', 'apt-get', 'python3'),
    ('custom', '1', 'debian', 'apt-get', 'python3'),
    ('fedora', '43', '', 'dnf', 'python3'),
    ('rocky', '8.10', 'rhel centos fedora', 'dnf', 'python3.12'),
    ('almalinux', '9', 'rhel', 'dnf', 'python3'),
    ('arch', '', '', 'pacman', 'python'),
    ('manjaro', '', 'arch', 'pacman', 'python'),
    ('opensuse-leap', '15.6', 'suse opensuse', 'zypper', 'python311'),
    ('sles', '15.6', 'suse', 'zypper', 'python311'),
    ('alpine', '3.22', '', 'apk', 'python3'),
])
def test_unix_missing_python_selects_distribution_manager_and_continues(unix, distro, version, parent, manager, package):
    unix.release.write_text(f'ID={distro}\nVERSION_ID="{version}"\nID_LIKE="{parent}"\n', newline='\n')
    result, rows = unix.run('--dev', '--build')
    assert result.returncode == 0, result.stderr
    assert any(row.startswith(manager + '|') and package in row and 'ca-certificates' in row for row in rows)
    if manager == 'apt-get':
        assert rows[0] == 'apt-get|update'
    assert (unix.root / 'runtime-args.txt').read_text().splitlines() == [
        (unix.root / 'scripts/bootstrap_runtime.py').as_posix(), '--dev', '--build']
    assert not any('--sysupgrade' in row or '-Syu' in row or '-Sy ' in row for row in rows)


def test_unix_existing_python_skips_all_system_commands(unix):
    (unix.root / 'python-installed').touch()
    result, rows = unix.run()
    assert result.returncode == 0, result.stderr
    assert rows == []
    assert (unix.root / 'runtime-args.txt').exists()


@pytest.mark.parametrize('existing', [False, True])
def test_unix_dry_run_does_not_install_or_launch_runtime(unix, existing):
    if existing:
        (unix.root / 'python-installed').touch()
    result, rows = unix.run('--dry-run')
    assert result.returncode == 0, result.stderr
    assert rows == []
    assert not (unix.root / 'runtime-args.txt').exists()
    assert 'no changes made' in result.stderr


@pytest.mark.parametrize('argument', ['--help', '--unsupported'])
def test_unix_help_or_bad_arguments_never_install(unix, argument):
    result, rows = unix.run(argument)
    assert result.returncode == (0 if argument == '--help' else 2)
    assert rows == []
    assert not (unix.root / 'runtime-args.txt').exists()


@pytest.mark.parametrize(('uid', 'expected'), [('0', False), ('1000', True)])
def test_unix_elevates_only_the_package_commands(unix, uid, expected):
    result, rows = unix.run(TP_TEST_UID=uid)
    assert result.returncode == 0, result.stderr
    assert any(row.startswith('sudo|') for row in rows) is expected
    assert not any('bootstrap_runtime' in row for row in rows)


def test_unix_uses_doas_without_sudo(unix):
    (unix.bin / 'sudo').unlink()
    result, rows = unix.run(TP_TEST_UID='1000')
    assert result.returncode == 0, result.stderr
    assert any(row.startswith('doas|') for row in rows)


def test_unix_no_privilege_tool_stops_before_package_commands(unix):
    (unix.bin / 'sudo').unlink()
    (unix.bin / 'doas').unlink()
    result, rows = unix.run(TP_TEST_UID='1000')
    assert result.returncode != 0 and rows == []
    assert not (unix.root / 'runtime-args.txt').exists()


def test_unix_incomplete_release_does_not_install_system_packages(unix):
    (unix.root / 'apps/web/dist/index.html').unlink()
    result, rows = unix.run()
    assert result.returncode != 0 and rows == []
    assert 'Frontend build is missing' in result.stderr


@pytest.mark.parametrize(('variable', 'code'), [('TP_TEST_MANAGER_EXIT', 37), ('TP_TEST_AUTH_EXIT', 130)])
def test_unix_package_failure_or_cancel_stops_without_retry(unix, variable, code):
    result, rows = unix.run(**{variable: code, 'TP_TEST_UID': '1000'})
    assert result.returncode == code
    assert not (unix.root / 'runtime-args.txt').exists()
    assert len(rows) <= 2
    assert not any('install -y' in row for row in rows)


def test_unix_unknown_distribution_and_os_release_injection_fail_closed(unix):
    marker = unix.root / 'should-not-exist'
    unix.release.write_text('ID="$(touch ' + marker.as_posix() + ')"\n', newline='\n')
    result, rows = unix.run()
    assert result.returncode != 0
    assert not marker.exists() and rows == []
    unix.release.write_text('ID=unknown\n', newline='\n')
    result, rows = unix.run()
    assert result.returncode != 0 and rows == []
    assert 'Unknown distribution' in result.stderr


def test_unix_unsupported_architecture_does_not_install(unix):
    result, rows = unix.run(TP_TEST_ARCH='armv7l')
    assert result.returncode != 0 and rows == []


def test_unix_rpm_uses_yum_when_dnf_is_unavailable(unix):
    unix.release.write_text('ID=rhel\nVERSION_ID=9\n', newline='\n')
    (unix.bin / 'dnf').unlink()
    result, rows = unix.run()
    assert result.returncode == 0, result.stderr
    assert rows == ['yum|install -y python3 ca-certificates']


def test_macos_existing_homebrew_installs_without_sudo(unix):
    result, rows = unix.run(TP_TEST_OS='Darwin', TP_TEST_ARCH='arm64', TP_TEST_UID='501')
    assert result.returncode == 0, result.stderr
    assert rows == ['brew|install python@3.12', 'brew|--prefix python@3.12']


def test_macos_without_manager_reports_homebrew_plan_without_downloading(unix):
    extra = 'tp_find_brew() { return 1; }'
    result, rows = unix.run('--dry-run', extra=extra, TP_TEST_OS='Darwin', TP_TEST_UID='501')
    assert result.returncode == 0, result.stderr
    assert 'official Homebrew' in result.stderr and rows == []
    assert not (unix.root / '.codex').exists()


@pytest.mark.parametrize('correct_hash', [False, True])
def test_macos_homebrew_script_requires_hash_before_execution(unix, correct_hash):
    executable(unix.bin / 'curl', '''#!/bin/sh
while [ "$#" -gt 0 ]; do
    if [ "$1" = --output ]; then shift; target=$1; fi
    shift
done
printf '%s\n' '#!/bin/sh' ': > "$TP_ROOT/brew-installed"' > "$target"
''')
    digest = '25548e1da7930c1563dbbe2cb05834a4131c4da09234540b6fdac812fda3c287' if correct_hash else '0' * 64
    executable(unix.bin / 'shasum', '#!/bin/sh\nprintf "%s  fixture\\n" "' + digest + '"\n')
    extra = '''tp_find_brew() {
    if [ -f "$TP_ROOT/brew-installed" ]; then TP_MANAGER=brew; return 0; fi
    return 1
}'''
    result, rows = unix.run(extra=extra, TP_TEST_OS='Darwin', TP_TEST_UID='501')
    assert result.returncode == (0 if correct_hash else 1), result.stderr
    assert (unix.root / 'brew-installed').exists() is correct_hash
    if not correct_hash:
        assert rows == [] and 'SHA-256 mismatch' in result.stderr


@pytest.fixture
def windows(tmp_path):
    if os.name != 'nt':
        pytest.skip('Windows PowerShell installer')
    candidate = release_fixture(tmp_path)
    log = tmp_path / 'native.jsonl'
    script = tmp_path / 'fixture.ps1'
    script.write_text('''param([string]$ProjectRoot)
. $env:TP_TEST_LIBRARY
function Get-TongpinPlatform { return [pscustomobject]@{Name='Windows';Version='fixture';Architecture='AMD64'} }
function Get-TongpinPython([string]$ProjectRoot) {
    if ($env:TP_TEST_EXISTING -eq '1' -or (Test-Path -LiteralPath (Join-Path $ProjectRoot 'python-installed'))) {
        return [pscustomobject]@{Name='fixture-python';Prefix=@('-fixture-prefix')}
    }
    return $null
}
function Get-TongpinWinget { if ($env:TP_TEST_WINGET -eq '1') { return 'fixture-winget' }; return $null }
function Invoke-TongpinNative([string]$Executable,[string[]]$NativeArguments) {
    @{executable=$Executable;arguments=$NativeArguments} | ConvertTo-Json -Compress | Add-Content -LiteralPath $env:TP_TEST_LOG
    if ($Executable -eq 'fixture-winget') {
        if ($env:TP_TEST_PACKAGE_EXIT -eq '0' -and $env:TP_TEST_NO_DISCOVERY -ne '1') {
            New-Item -ItemType File -Path (Join-Path $ProjectRoot 'python-installed') -Force | Out-Null
        }
        return [int]$env:TP_TEST_PACKAGE_EXIT
    }
    return [int]$env:TP_TEST_RUNTIME_EXIT
}
try { exit (Invoke-TongpinInstall $ProjectRoot ($env:TP_TEST_ARGS | ConvertFrom-Json)) }
catch { Write-Error $_ -ErrorAction Continue; exit 1 }
''', encoding='utf-8')
    env = os.environ | {'TP_TEST_LIBRARY': str(ROOT / 'scripts/bootstrap_windows.ps1'),
                       'TP_TEST_LOG': str(log), 'TP_TEST_WINGET': '1', 'TP_TEST_EXISTING': '0',
                       'TP_TEST_PACKAGE_EXIT': '0', 'TP_TEST_RUNTIME_EXIT': '0', 'TP_TEST_NO_DISCOVERY': '0'}

    def run(*args, **values):
        result = subprocess.run(['powershell.exe', '-NoLogo', '-NoProfile', '-File', str(script), str(candidate)],
                                cwd=tmp_path, env=env | {'TP_TEST_ARGS': json.dumps(args)} | values,
                                capture_output=True, text=True, check=False)
        rows = [json.loads(line) for line in log.read_text(encoding='utf-8-sig').splitlines()] if log.exists() else []
        return result, rows

    return SimpleNamespace(root=candidate, run=run)


def test_windows_no_python_uses_user_scope_winget_and_finds_new_interpreter(windows):
    result, rows = windows.run('--dev', '--build')
    assert result.returncode == 0, result.stderr
    assert len(rows) == 2
    args = rows[0]['arguments']
    assert rows[0]['executable'] == 'fixture-winget'
    assert args[args.index('--id') + 1] == 'Python.Python.3.12'
    assert args[args.index('--scope') + 1] == 'user'
    assert args[args.index('--source') + 1] == 'winget'
    assert 'PrependPath=0' in args[args.index('--custom') + 1]
    assert not any(arg in args for arg in ['--force', '--allow-reboot', '--ignore-security-hash'])
    assert rows[1]['executable'] == 'fixture-python'
    assert rows[1]['arguments'][0] == '-fixture-prefix'
    assert rows[1]['arguments'][-2:] == ['--dev', '--build']


def test_windows_existing_python_does_not_install_system_packages(windows):
    result, rows = windows.run(TP_TEST_EXISTING='1')
    assert result.returncode == 0, result.stderr
    assert [row['executable'] for row in rows] == ['fixture-python']


def test_windows_incomplete_release_does_not_install_system_packages(windows):
    (windows.root / 'apps/web/dist/index.html').unlink()
    result, rows = windows.run()
    assert result.returncode != 0 and rows == []


@pytest.mark.parametrize('existing', ['0', '1'])
def test_windows_dry_run_never_invokes_installer_or_runtime(windows, existing):
    result, rows = windows.run('--dry-run', TP_TEST_EXISTING=existing)
    assert result.returncode == 0, result.stderr
    assert rows == []


@pytest.mark.parametrize('code', ['17', '130'])
def test_windows_installer_error_or_cancel_does_not_retry(windows, code):
    result, rows = windows.run(TP_TEST_PACKAGE_EXIT=code)
    assert result.returncode == int(code)
    assert len(rows) == 1


def test_windows_missing_winget_stops_without_alternate_installer(windows):
    result, rows = windows.run(TP_TEST_WINGET='0')
    assert result.returncode != 0 and rows == []
    assert 'No working Python or winget' in result.stderr


def test_windows_success_without_discoverable_python_is_not_reported_installed(windows):
    result, rows = windows.run(TP_TEST_NO_DISCOVERY='1')
    assert result.returncode != 0 and len(rows) == 1


@pytest.mark.parametrize('option', ['--help', '--unsupported'])
def test_windows_help_and_bad_arguments_do_not_start_installation(windows, option):
    result, rows = windows.run(option)
    assert (result.returncode == 0) is (option == '--help')
    assert rows == []


def test_runtime_bridge_uses_python38_compatible_syntax():
    for filename in ['bootstrap_runtime.py', 'bootstrap_uv.py']:
        ast.parse((ROOT / 'scripts' / filename).read_text(encoding='utf-8'), feature_version=(3, 8))


@pytest.mark.parametrize('version', [(3, 8, 20), (3, 11, 14), (3, 12, 10), (3, 13, 7)])
def test_runtime_bridge_upgrades_older_bootstrap_before_deployment(tmp_path, monkeypatch, version):
    candidate = release_fixture(tmp_path)
    monkeypatch.setattr(runtime, 'ROOT', candidate)
    monkeypatch.setattr(runtime.sys, 'version_info', version)
    operations = []

    def prepare(release, requested, env):
        operations.append(('prepare', release, requested))
        assert env['UV_PYTHON_INSTALL_DIR'] == str(candidate / '.codex/python')
        return 'prepared-python'

    monkeypatch.setattr(runtime, 'prepare_runtime', prepare)
    monkeypatch.setattr(runtime.subprocess, 'run', lambda command, **kwargs: operations.append(('deploy', command, kwargs)) or SimpleNamespace(returncode=0))
    assert runtime.install(['--dev', '--build']) == 0
    if version < (3, 12):
        assert operations[0] == ('prepare', candidate, '3.12.13')
    command = operations[-1][1]
    assert command[0] == ('prepared-python' if version < (3, 12) else sys.executable)
    assert command[-4:] == ['--bootstrap-tools', '--download-python', '--dev', '--build']


def test_runtime_download_never_registers_global_python_and_checks_returned_version(tmp_path, monkeypatch):
    candidate = release_fixture(tmp_path)
    python = candidate / '.codex/python/managed/python'
    python.parent.mkdir(parents=True)
    python.write_text('fixture')
    env = runtime.runtime_environment(candidate)
    env['TONGPIN_UV'] = 'fixture-uv'
    commands = []

    def run(command, **kwargs):
        commands.append(command)
        if 'find' in command:
            return SimpleNamespace(stdout=str(python) + '\n')
        return SimpleNamespace(stdout='3.12.13\n')

    monkeypatch.setattr(runtime.subprocess, 'run', run)
    assert runtime.prepare_runtime(candidate, '3.12.13', env) == str(python.resolve())
    assert '--no-bin' in commands[0] and '--no-registry' in commands[0]
    assert '--managed-python' in commands[1] and '--no-project' in commands[1]
    assert commands[2][1:3] == ['-I', '-S']


def test_runtime_rejects_python_outside_project_download_root(tmp_path, monkeypatch):
    candidate = release_fixture(tmp_path)
    env = runtime.runtime_environment(candidate)
    env['TONGPIN_UV'] = 'fixture-uv'
    monkeypatch.setattr(runtime.subprocess, 'run', lambda *a, **kw: SimpleNamespace(stdout=sys.executable))
    with pytest.raises(runtime.BootstrapError, match='outside the project'):
        runtime.prepare_runtime(candidate, '3.12.13', env)


def test_runtime_rejects_downloaded_interpreter_version_mismatch(tmp_path, monkeypatch):
    candidate = release_fixture(tmp_path)
    python = candidate / '.codex/python/managed/python'
    python.parent.mkdir(parents=True)
    python.write_text('fixture')
    env = runtime.runtime_environment(candidate)
    env['TONGPIN_UV'] = 'fixture-uv'

    def run(command, **kwargs):
        return SimpleNamespace(stdout=str(python) if 'find' in command else '3.11.9\n')

    monkeypatch.setattr(runtime.subprocess, 'run', run)
    with pytest.raises(runtime.BootstrapError, match='does not match'):
        runtime.prepare_runtime(candidate, '3.12.13', env)
