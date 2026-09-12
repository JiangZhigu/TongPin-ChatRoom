from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import deploy


def candidate_release(tmp_path):
    candidate = tmp_path / 'runtime release'
    (candidate / 'apps/web/dist').mkdir(parents=True)
    (candidate / 'apps/web/dist/index.html').write_text('<main>prebuilt</main>')
    (candidate / '.python-version').write_text('3.12.13')
    return candidate


def test_plain_install_does_not_download_a_missing_tool(tmp_path, monkeypatch):
    monkeypatch.setattr(deploy, 'ROOT', candidate_release(tmp_path))
    monkeypatch.delenv('TONGPIN_UV', raising=False)
    monkeypatch.setattr(deploy.shutil, 'which', lambda name: None)
    with pytest.raises(ValueError, match='--bootstrap-tools'):
        deploy.install(deploy.parser().parse_args(['install']))


def test_python_only_install_bootstraps_uv_then_syncs_without_node(tmp_path, monkeypatch):
    import bootstrap_uv

    candidate = candidate_release(tmp_path)
    monkeypatch.setattr(deploy, 'ROOT', candidate)
    monkeypatch.delenv('TONGPIN_UV', raising=False)
    monkeypatch.setattr(deploy.shutil, 'which', lambda name: None)
    operations = []

    def prepare_uv(release):
        assert release == candidate
        operations.append(('bootstrap', release))
        return str(candidate / '.codex/tools/isolated-uv')

    monkeypatch.setattr(bootstrap_uv, 'ensure_uv', prepare_uv)
    monkeypatch.setattr(deploy, 'call', lambda command, **kwargs: operations.append(('sync', command, kwargs)))
    options = deploy.parser().parse_args(['install', '--bootstrap-tools', '--download-python'])
    assert deploy.install(options)['installed']
    assert [item[0] for item in operations] == ['bootstrap', 'sync']
    _, command, kwargs = operations[1]
    assert command[1] == 'sync'
    assert '--no-dev' in command
    assert '--locked' in command
    assert '--no-python-downloads' not in command
    assert kwargs['env']['UV_PROJECT_ENVIRONMENT'] == str(candidate / '.venv')
    assert kwargs['env']['UV_PYTHON_INSTALL_DIR'] == str(candidate / '.codex/python')
    assert not (candidate / 'var').exists()


def test_explicit_uv_is_reused_without_bootstrap_download(tmp_path, monkeypatch):
    import bootstrap_uv

    monkeypatch.setattr(deploy, 'ROOT', candidate_release(tmp_path))
    monkeypatch.setenv('TONGPIN_UV', 'approved-existing-uv')
    monkeypatch.setattr(bootstrap_uv, 'ensure_uv', lambda _: pytest.fail('existing uv must be reused'))
    captured = []
    monkeypatch.setattr(deploy, 'call', lambda command, **kwargs: captured.append(command))
    deploy.install(deploy.parser().parse_args(['install', '--bootstrap-tools']))
    assert captured[0][0] == 'approved-existing-uv'
    assert '--no-python-downloads' in captured[0]


def test_install_bootstrap_rejects_redirected_environment_before_download(tmp_path, monkeypatch):
    import bootstrap_uv

    candidate = candidate_release(tmp_path)
    protected = tmp_path / 'protected'
    protected.mkdir()
    (protected / 'keep').write_text('unchanged')
    link = candidate / '.venv'
    if os.name == 'nt':
        env = os.environ | {'TP_LINK': str(link), 'TP_TARGET': str(protected)}
        subprocess.run(['powershell.exe', '-NoProfile', '-Command',
                        'New-Item -ItemType Junction -Path $env:TP_LINK -Target $env:TP_TARGET | Out-Null'],
                       env=env, check=True, capture_output=True)
    else:
        link.symlink_to(protected, target_is_directory=True)
    monkeypatch.setattr(deploy, 'ROOT', candidate)
    monkeypatch.delenv('TONGPIN_UV', raising=False)
    monkeypatch.setattr(deploy.shutil, 'which', lambda name: None)
    monkeypatch.setattr(bootstrap_uv, 'ensure_uv', lambda _: pytest.fail('download must not start'))
    try:
        with pytest.raises(ValueError, match='symlink or junction'):
            deploy.install(deploy.parser().parse_args(['install', '--bootstrap-tools']))
        assert [item.name for item in protected.iterdir()] == ['keep']
        assert (protected / 'keep').read_text() == 'unchanged'
    finally:
        link.rmdir() if os.name == 'nt' else link.unlink()


@pytest.mark.skipif(os.name != 'nt', reason='Windows launcher contract')
@pytest.mark.parametrize('exit_code', [0, 17])
def test_windows_install_launcher_from_external_directory(tmp_path, exit_code):
    candidate = tmp_path / 'package with spaces'
    (candidate / 'scripts').mkdir(parents=True)
    shutil.copyfile(ROOT / 'install.cmd', candidate / 'install.cmd')
    (candidate / 'scripts/bootstrap_windows.ps1').write_text(
        'param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)\n'
        '$Arguments | Set-Content -LiteralPath (Join-Path (Split-Path $PSScriptRoot) "captured.txt")\n'
        'exit ' + str(exit_code) + '\n')
    result = subprocess.run(['cmd.exe', '/d', '/c', str(candidate / 'install.cmd'), '--dev', '--build'],
                            cwd=tmp_path, env=os.environ | {'TONGPIN_NO_PAUSE': '1'},
                            capture_output=True, text=True, check=False)
    assert result.returncode == exit_code
    assert (candidate / 'captured.txt').read_text().splitlines() == ['--dev', '--build']


@pytest.mark.skipif(not shutil.which('sh'), reason='POSIX shell unavailable on this host')
@pytest.mark.parametrize('exit_code', [0, 17])
def test_posix_install_launcher_from_external_directory(tmp_path, exit_code):
    candidate = tmp_path / 'package with spaces'
    (candidate / 'scripts').mkdir(parents=True)
    shutil.copyfile(ROOT / 'install.sh', candidate / 'install.sh')
    (candidate / 'scripts/bootstrap_unix.sh').write_text(
        'tp_install() { printf "%s\\n" "$@" > "$TP_ROOT/captured.txt"; return ' + str(exit_code) + '; }\n')
    result = subprocess.run(['sh', str(candidate / 'install.sh'), '--dev', '--build'], cwd=tmp_path,
                            capture_output=True, text=True, check=False)
    assert result.returncode == exit_code
    assert (candidate / 'captured.txt').read_text().splitlines() == ['--dev', '--build']


@pytest.mark.skipif(os.name != 'nt', reason='Windows PowerShell native stderr behavior')
def test_windows_wrapper_continues_after_python_launcher_stderr(tmp_path):
    candidate = tmp_path / 'release with spaces'
    (candidate / 'scripts').mkdir(parents=True)
    for name in ('tongpin.cmd', 'tongpin.ps1'):
        shutil.copyfile(ROOT / name, candidate / name)
    (candidate / 'scripts/deploy.py').write_text('print("bootstrap reached")\n')
    fake_bin = tmp_path / 'fake-launcher'
    fake_bin.mkdir()
    (fake_bin / 'py.cmd').write_bytes(b'@echo off\r\necho No suitable Python runtime found 1>&2\r\nexit /b 103\r\n')
    windows = Path(os.environ['SystemRoot'])
    env = os.environ.copy()
    env['PATH'] = os.pathsep.join([str(fake_bin), str(Path(sys._base_executable).parent),
                                  str(windows / 'System32'), str(windows),
                                  str(windows / 'System32/WindowsPowerShell/v1.0')])
    result = subprocess.run([str(windows / 'System32/cmd.exe'), '/d', '/c', str(candidate / 'tongpin.cmd'), 'doctor'],
                            cwd=tmp_path, env=env, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == 'bootstrap reached'
