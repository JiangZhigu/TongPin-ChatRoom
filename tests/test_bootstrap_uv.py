from __future__ import annotations

import hashlib
import io
import json
import os
import stat
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import bootstrap_uv as bootstrap


def wheel_bytes(entries=None):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w') as archive:
        if entries is None:
            entries = [(f'uv-{bootstrap.UV_VERSION}.data/scripts/uv.exe', b'MZ uv fixture'),
                       (f'uv-{bootstrap.UV_VERSION}.data/scripts/uvx.exe', b'never extracted'),
                       ('uv/__init__.py', b'raise RuntimeError("never imported")')]
        for name, content in entries:
            archive.writestr(name, content)
    return output.getvalue()


class Response(io.BytesIO):
    def __init__(self, content, url, headers=None):
        super().__init__(content)
        self.url = url
        self.headers = headers or {}

    def geturl(self):
        return self.url


def fake_pypi(monkeypatch, *, payload=None, digest=None):
    payload = payload if payload is not None else wheel_bytes()
    filename = bootstrap._wheel_filename('windows-x86_64')
    url = f'https://files.pythonhosted.org/packages/test/{filename}'
    metadata = {'info': {'version': bootstrap.UV_VERSION}, 'urls': [
        {'filename': filename, 'url': url, 'packagetype': 'bdist_wheel', 'yanked': False,
         'size': len(payload), 'digests': {'sha256': digest or hashlib.sha256(payload).hexdigest()}}]}
    requests = []

    class Opener:
        def open(self, request, timeout):
            requests.append(request.full_url)
            assert timeout == bootstrap.SOCKET_TIMEOUT
            content = json.dumps(metadata).encode() if request.full_url == bootstrap.METADATA_URL else payload
            assert request.full_url in (bootstrap.METADATA_URL, url)
            return Response(content, request.full_url)

    monkeypatch.setattr(bootstrap.urllib.request, 'build_opener', lambda *a: Opener())
    monkeypatch.setattr(bootstrap, '_platform_key', lambda: 'windows-x86_64')
    return requests, metadata


@pytest.mark.parametrize(('system', 'machine', 'libc', 'target', 'tag'), [
    ('Windows', 'AMD64', None, 'windows-x86_64', 'win_amd64'),
    ('Windows', 'ARM64', None, 'windows-aarch64', 'win_arm64'),
    ('Darwin', 'x86_64', None, 'macos-x86_64', 'macosx_10_12_x86_64'),
    ('Darwin', 'arm64', None, 'macos-aarch64', 'macosx_11_0_arm64'),
    ('Linux', 'x86_64', 'glibc', 'linux-x86_64-glibc', 'manylinux_2_17_x86_64'),
    ('Linux', 'x86_64', 'musl', 'linux-x86_64-musl', 'musllinux_1_1_x86_64'),
    ('Linux', 'aarch64', 'glibc', 'linux-aarch64-glibc', 'manylinux_2_17_aarch64'),
    ('Linux', 'aarch64', 'musl', 'linux-aarch64-musl', 'musllinux_1_1_aarch64'),
])
def test_platform_selects_published_compatible_wheel(system, machine, libc, target, tag):
    assert bootstrap._platform_key(system, machine, libc) == target
    assert tag in bootstrap._wheel_filename(target)


@pytest.mark.parametrize(('system', 'machine', 'libc'), [
    ('Windows', 'x86', None), ('FreeBSD', 'amd64', None), ('Linux', 'aarch64', 'unknown'),
])
def test_unsupported_platform_fails_instead_of_guessing(system, machine, libc):
    with pytest.raises(bootstrap.BootstrapError, match='supported uv wheel'):
        bootstrap._platform_key(system, machine, libc)


def test_linux_libc_detection_prefers_detected_glibc_and_rejects_old_versions(monkeypatch):
    monkeypatch.setattr(bootstrap.platform, 'libc_ver', lambda: ('glibc', '2.17'))
    monkeypatch.setattr(bootstrap.sysconfig, 'get_config_var', lambda key: 'x86_64-linux-musl')
    assert bootstrap._linux_libc('x86_64') == 'glibc'
    monkeypatch.setattr(bootstrap.platform, 'libc_ver', lambda: ('glibc', '2.16'))
    with pytest.raises(bootstrap.BootstrapError, match='2.17'):
        bootstrap._linux_libc('x86_64')
    monkeypatch.setattr(bootstrap.platform, 'libc_ver', lambda: ('', ''))
    assert bootstrap._linux_libc('x86_64') == 'musl'
    monkeypatch.setattr(bootstrap.sysconfig, 'get_config_var', lambda key: '')
    monkeypatch.setattr(bootstrap.Path, 'is_file', lambda self: False)
    with pytest.raises(bootstrap.BootstrapError, match='Cannot identify'):
        bootstrap._linux_libc('x86_64')


def test_bootstrap_only_extracts_uv_and_reuses_verified_cache_offline(tmp_path, monkeypatch):
    requests, _ = fake_pypi(monkeypatch)
    executable = Path(bootstrap.ensure_uv(tmp_path))
    directory = tmp_path / '.codex/tools/uv/0.11.27/windows-x86_64'
    assert executable == directory / 'uv.exe'
    assert executable.read_bytes() == b'MZ uv fixture'
    assert {item.name for item in directory.iterdir()} == {'uv.exe', 'receipt.json'}
    assert len(requests) == 2
    monkeypatch.setattr(bootstrap, '_metadata', lambda: pytest.fail('Valid cache must work offline'))
    assert bootstrap.ensure_uv(tmp_path) == str(executable)
    assert len(requests) == 2


def test_wrong_wheel_hash_does_not_publish_cache(tmp_path, monkeypatch):
    fake_pypi(monkeypatch, digest='0' * 64)
    with pytest.raises(bootstrap.BootstrapError, match='wheel SHA256'):
        bootstrap.ensure_uv(tmp_path)
    assert list((tmp_path / '.codex/tools/uv/0.11.27').iterdir()) == []


@pytest.mark.parametrize('damage', ['binary', 'receipt', 'missing_receipt'])
def test_damaged_cache_is_rejected_before_network(tmp_path, monkeypatch, damage):
    fake_pypi(monkeypatch)
    executable = Path(bootstrap.ensure_uv(tmp_path))
    if damage == 'binary':
        executable.write_bytes(b'MZ uv changed')
    elif damage == 'receipt':
        receipt = json.loads((executable.parent / 'receipt.json').read_text())
        receipt['version'] = '0.0.0'
        (executable.parent / 'receipt.json').write_text(json.dumps(receipt))
    else:
        (executable.parent / 'receipt.json').unlink()
    monkeypatch.setattr(bootstrap, '_metadata', lambda: pytest.fail('Damaged cache must fail closed'))
    with pytest.raises(bootstrap.BootstrapError, match='cache'):
        bootstrap.ensure_uv(tmp_path)


@pytest.mark.parametrize('path', ['../outside', '/outside', 'C:/outside', 'folder\\outside'])
def test_unsafe_archive_paths_do_not_publish_any_binary(tmp_path, monkeypatch, path):
    payload = wheel_bytes([(f'uv-{bootstrap.UV_VERSION}.data/scripts/uv.exe', b'uv'), (path, b'unsafe')])
    if '\\' in path:
        # zipfile normalises Windows separators while writing. Preserve the
        # attacker's actual archive names in both equal-length ZIP headers.
        payload = payload.replace(path.replace('\\', '/').encode(), path.encode())
    fake_pypi(monkeypatch, payload=payload)
    with pytest.raises(bootstrap.BootstrapError, match='unsafe path or link'):
        bootstrap.ensure_uv(tmp_path)
    assert list((tmp_path / '.codex/tools/uv/0.11.27').iterdir()) == []


def test_symlink_executable_in_wheel_is_rejected(tmp_path, monkeypatch):
    member = zipfile.ZipInfo(f'uv-{bootstrap.UV_VERSION}.data/scripts/uv.exe')
    member.create_system = 3
    member.external_attr = (stat.S_IFLNK | 0o777) << 16
    fake_pypi(monkeypatch, payload=wheel_bytes([(member, b'/outside')]))
    with pytest.raises(bootstrap.BootstrapError, match='unsafe path or link'):
        bootstrap.ensure_uv(tmp_path)
    assert list((tmp_path / '.codex/tools/uv/0.11.27').iterdir()) == []


def test_missing_uv_executable_never_extracts_other_binaries(tmp_path, monkeypatch):
    fake_pypi(monkeypatch, payload=wheel_bytes([('uvx.exe', b'wrong executable')]))
    with pytest.raises(bootstrap.BootstrapError, match='expected executable'):
        bootstrap.ensure_uv(tmp_path)
    assert list((tmp_path / '.codex/tools/uv/0.11.27').iterdir()) == []


def test_linked_tool_directory_rejected_without_touching_target(tmp_path, monkeypatch):
    release = tmp_path / 'release'
    release.mkdir()
    outside = tmp_path / 'protected'
    outside.mkdir()
    sentinel = outside / 'keep.txt'
    sentinel.write_text('preserve')
    link = release / '.codex'
    if os.name == 'nt':
        env = os.environ | {'TONGPIN_TEST_LINK': str(link), 'TONGPIN_TEST_TARGET': str(outside)}
        subprocess.run(['powershell.exe', '-NoProfile', '-Command',
                        ('New-Item -ItemType Junction -Path $env:TONGPIN_TEST_LINK '
                         '-Target $env:TONGPIN_TEST_TARGET | Out-Null')],
                       env=env, check=True, capture_output=True)
    else:
        link.symlink_to(outside, target_is_directory=True)
    monkeypatch.setattr(bootstrap, '_metadata', lambda: pytest.fail('No network for redirected path'))
    try:
        with pytest.raises(bootstrap.BootstrapError, match='symlink or reparse'):
            bootstrap.ensure_uv(release)
        assert sentinel.read_text() == 'preserve'
        assert [item.name for item in outside.iterdir()] == ['keep.txt']
    finally:
        if os.name == 'nt':
            link.rmdir()
        else:
            link.unlink()


def test_parent_traversal_is_rejected_before_directory_creation(tmp_path):
    with pytest.raises(bootstrap.BootstrapError, match='parent traversal'):
        bootstrap.ensure_uv(tmp_path / 'absent' / '..' / 'other')
    assert not (tmp_path / 'absent').exists()


@pytest.mark.parametrize('url', ['http://files.pythonhosted.org/a', 'https://example.com/a',
                              'https://files.pythonhosted.org:80/a', 'https://user@pypi.org/a'])
def test_download_rejects_untrusted_or_plain_http_urls(url):
    with pytest.raises(bootstrap.BootstrapError, match='HTTPS'):
        bootstrap._download(url, io.BytesIO(), 100)


def test_https_redirect_cannot_escape_official_hosts():
    request = bootstrap.urllib.request.Request(bootstrap.METADATA_URL)
    with pytest.raises(bootstrap.BootstrapError, match='HTTPS'):
        bootstrap._OfficialRedirect().redirect_request(
            request, None, 302, 'Found', {}, 'http://pypi.org/download')


@pytest.mark.parametrize('headers', [{}, {'Content-Length': '8'}])
def test_download_enforces_size_limit_with_or_without_content_length(monkeypatch, headers):
    class Opener:
        def open(self, request, timeout):
            return Response(b'12345678', request.full_url, headers)

    monkeypatch.setattr(bootstrap.urllib.request, 'build_opener', lambda *a: Opener())
    with pytest.raises(bootstrap.BootstrapError, match='permitted size'):
        bootstrap._download(bootstrap.METADATA_URL, io.BytesIO(), 4)


def test_missing_or_yanked_platform_wheel_fails_before_writing_cache(tmp_path, monkeypatch):
    _, metadata = fake_pypi(monkeypatch)
    metadata['urls'][0]['yanked'] = True
    with pytest.raises(bootstrap.BootstrapError, match='unavailable'):
        bootstrap.ensure_uv(tmp_path)
    assert not (tmp_path / '.codex').exists()


def test_failed_atomic_publication_leaves_no_success_cache(tmp_path, monkeypatch):
    fake_pypi(monkeypatch)

    def denied(*args):
        raise PermissionError('isolated publication failure')

    monkeypatch.setattr(bootstrap.os, 'rename', denied)
    with pytest.raises(bootstrap.BootstrapError, match='publication failure'):
        bootstrap.ensure_uv(tmp_path)
    assert list((tmp_path / '.codex/tools/uv/0.11.27').iterdir()) == []


def test_unexpected_metadata_version_is_rejected_before_write(tmp_path, monkeypatch):
    _, metadata = fake_pypi(monkeypatch)
    metadata['info']['version'] = '0.0.0'
    with pytest.raises(bootstrap.BootstrapError, match='unexpected uv version'):
        bootstrap.ensure_uv(tmp_path)
    assert not (tmp_path / '.codex').exists()
