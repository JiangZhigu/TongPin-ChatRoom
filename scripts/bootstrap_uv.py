"""Bootstrap the pinned uv binary inside a release using only Python's stdlib.

The caller owns download authorization. This module never installs packages,
modifies PATH, invokes an installer script, or searches for a global uv.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import platform
import re
import shutil
import stat
import sysconfig
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

UV_VERSION = '0.11.27'
METADATA_URL = f'https://pypi.org/pypi/uv/{UV_VERSION}/json'
MAX_METADATA_BYTES = 2 * 1024 * 1024
MAX_WHEEL_BYTES = 64 * 1024 * 1024
MAX_BINARY_BYTES = 160 * 1024 * 1024
SOCKET_TIMEOUT = 30
DOWNLOAD_DEADLINE = 180
CHUNK_SIZE = 1024 * 1024

# These exact platform tags are published in the fixed PyPI release above.
# The ARM64 Linux wheel carries both manylinux and musllinux compatibility tags.
WHEEL_TAGS = {
    'windows-x86_64': 'win_amd64',
    'windows-aarch64': 'win_arm64',
    'macos-x86_64': 'macosx_10_12_x86_64',
    'macos-aarch64': 'macosx_11_0_arm64',
    'linux-x86_64-glibc': 'manylinux_2_17_x86_64.manylinux2014_x86_64',
    'linux-x86_64-musl': 'musllinux_1_1_x86_64',
    'linux-aarch64-glibc': 'manylinux_2_17_aarch64.manylinux2014_aarch64.musllinux_1_1_aarch64',
    'linux-aarch64-musl': 'manylinux_2_17_aarch64.manylinux2014_aarch64.musllinux_1_1_aarch64',
}


class BootstrapError(ValueError):
    """The local uv could not be securely selected, downloaded, or verified."""


def _linux_libc(architecture: str) -> str:
    name, version = platform.libc_ver()
    if name.lower() == 'glibc':
        if version and tuple(int(x) for x in version.split('.')[:2]) < (2, 17):
            raise BootstrapError('uv requires glibc 2.17 or newer on this Linux platform')
        return 'glibc'
    if name.lower() == 'musl' or 'musl' in (sysconfig.get_config_var('HOST_GNU_TYPE') or ''):
        return 'musl'
    if Path(f'/lib/ld-musl-{architecture}.so.1').is_file():
        return 'musl'
    raise BootstrapError('Cannot identify Linux libc; provide an existing uv using TONGPIN_UV')


def _platform_key(system=None, machine=None, libc=None) -> str:
    system = system or platform.system()
    machine = (machine or platform.machine()).lower()
    aliases = {'amd64': 'x86_64', 'x86_64': 'x86_64', 'arm64': 'aarch64', 'aarch64': 'aarch64'}
    architecture = aliases.get(machine)
    if architecture is None:
        raise BootstrapError(f'No supported uv wheel for architecture {machine!r}')
    if system == 'Windows':
        return f'windows-{architecture}'
    if system == 'Darwin':
        return f'macos-{architecture}'
    if system == 'Linux':
        libc = libc or _linux_libc(architecture)
        if libc in ('glibc', 'musl'):
            return f'linux-{architecture}-{libc}'
    raise BootstrapError(f'No supported uv wheel for {system!r} / {machine!r} / {libc!r}')


def _safe_path(value: Path) -> Path:
    path = Path(value).expanduser()
    if '..' in path.parts:
        raise BootstrapError('Tool paths cannot contain parent traversal')
    path = path.absolute()
    # lstat detects dangling links, junctions, and every Windows reparse type;
    # resolving the path first would erase this evidence.
    for entry in (path, *path.parents):
        try:
            info = entry.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise BootstrapError(f'Tool paths cannot traverse a symlink or reparse point: {entry}')
    return path


def _regular_file(path: Path, limit: int):
    path = _safe_path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise BootstrapError(f'Tool cache requires an unlinked regular file: {path}')
    if not 0 < info.st_size <= limit:
        raise BootstrapError(f'Tool file size is outside the permitted range: {path}')
    return info


def _sha256(path: Path) -> str:
    result = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(CHUNK_SIZE), b''):
            result.update(chunk)
    return result.hexdigest()


def _official_url(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != 'https' or parsed.hostname not in ('pypi.org', 'files.pythonhosted.org')
            or parsed.username or parsed.password or parsed.port not in (None, 443)
            or parsed.fragment):
        raise BootstrapError('uv downloads must use HTTPS on official PyPI hosts')
    return url


class _OfficialRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        _official_url(newurl)
        return super().redirect_request(request, fp, code, message, headers, newurl)


def _download(url: str, output, limit: int, *, expected_size=None, expected_sha256=None):
    request = urllib.request.Request(_official_url(url), headers={'User-Agent': 'TongPin-uv-bootstrap/1'})
    opener = urllib.request.build_opener(_OfficialRedirect())
    started = time.monotonic()
    size = 0
    digest = hashlib.sha256()
    with opener.open(request, timeout=SOCKET_TIMEOUT) as response:
        _official_url(response.geturl())
        declared = response.headers.get('Content-Length')
        if declared is not None and not 0 < int(declared) <= limit:
            raise BootstrapError('uv download exceeds the permitted size')
        while True:
            if time.monotonic() - started > DOWNLOAD_DEADLINE:
                raise BootstrapError('uv download exceeded the time limit')
            chunk = response.read(min(CHUNK_SIZE, limit + 1 - size))
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                raise BootstrapError('uv download exceeds the permitted size')
            digest.update(chunk)
            output.write(chunk)
    if not size or (expected_size is not None and size != expected_size):
        raise BootstrapError('uv download size does not match PyPI metadata')
    if expected_sha256 is not None and digest.hexdigest() != expected_sha256:
        raise BootstrapError('uv wheel SHA256 does not match PyPI metadata')


def _metadata():
    output = io.BytesIO()
    _download(METADATA_URL, output, MAX_METADATA_BYTES)
    data = json.loads(output.getvalue())
    if (not isinstance(data, dict) or not isinstance(data.get('info'), dict)
            or data['info'].get('version') != UV_VERSION or not isinstance(data.get('urls'), list)):
        raise BootstrapError('PyPI metadata returned an unexpected uv version')
    return data


def _wheel_filename(target: str) -> str:
    return f'uv-{UV_VERSION}-py3-none-{WHEEL_TAGS[target]}.whl'


def _is_digest(value) -> bool:
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value) is not None


def _select_wheel(metadata, target: str):
    filename = _wheel_filename(target)
    matches = [item for item in metadata['urls']
               if isinstance(item, dict) and item.get('filename') == filename
               and item.get('packagetype') == 'bdist_wheel'
               and not item.get('yanked', False)]
    if len(matches) != 1:
        raise BootstrapError(f'Official uv {UV_VERSION} wheel is unavailable for {target}')
    item = matches[0]
    if not _is_digest(item.get('digests', {}).get('sha256')):
        raise BootstrapError('PyPI metadata lacks a valid wheel SHA256')
    if type(item.get('size')) is not int or not 0 < item['size'] <= MAX_WHEEL_BYTES:
        raise BootstrapError('PyPI wheel size is outside the permitted range')
    _official_url(item['url'])
    if urllib.parse.urlsplit(item['url']).hostname != 'files.pythonhosted.org':
        raise BootstrapError('Wheel URL must point to the official PyPI file host')
    if urllib.parse.urlsplit(item['url']).path.rsplit('/', 1)[-1] != filename:
        raise BootstrapError('PyPI wheel URL does not match its filename')
    return item


def _extract_binary(wheel: Path, destination: Path, executable: str):
    destination = _safe_path(destination)
    member = f'uv-{UV_VERSION}.data/scripts/{executable}'
    with zipfile.ZipFile(_safe_path(wheel)) as archive:
        entries = archive.infolist()
        if len(entries) > 2000:
            raise BootstrapError('uv wheel contains too many archive members')
        seen = set()
        for entry in entries:
            # ZipInfo normalises Windows separators and truncates NUL bytes in
            # filename; inspect the original name before that normalisation.
            name = entry.orig_filename
            parts = PurePosixPath(name)
            mode = entry.external_attr >> 16
            if (not name or name != entry.filename or parts.is_absolute()
                    or '..' in parts.parts or '\\' in name
                    or ':' in name or '\x00' in name or name in seen
                    or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR))):
                raise BootstrapError('uv wheel contains an unsafe path or link')
            seen.add(name)
        matches = [entry for entry in entries if entry.filename == member]
        if len(matches) != 1:
            raise BootstrapError(f'uv wheel does not contain the expected executable: {member}')
        entry = matches[0]
        if entry.is_dir() or not 0 < entry.file_size <= MAX_BINARY_BYTES or entry.flag_bits & 1:
            raise BootstrapError('uv wheel executable is invalid or exceeds the permitted size')
        size = 0
        with archive.open(entry) as source, destination.open('xb') as output:
            for chunk in iter(lambda: source.read(CHUNK_SIZE), b''):
                size += len(chunk)
                if size > MAX_BINARY_BYTES:
                    raise BootstrapError('uv executable exceeds the permitted size')
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        if size != entry.file_size:
            raise BootstrapError('uv executable size does not match the wheel directory')
    _safe_path(destination).chmod(0o700)


def _cached(directory: Path, target: str, executable: str):
    directory = _safe_path(directory)
    if not directory.exists():
        return None
    binary = _safe_path(directory / executable)
    receipt_path = _safe_path(directory / 'receipt.json')
    if not directory.is_dir() or not binary.exists() or not receipt_path.exists():
        raise BootstrapError(f'Incomplete uv cache; inspect and remove this tool directory: {directory}')
    binary_info = _regular_file(binary, MAX_BINARY_BYTES)
    _regular_file(receipt_path, 16 * 1024)
    receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
    expected = {'format': 1, 'version': UV_VERSION, 'platform': target,
                'wheel': _wheel_filename(target), 'executable': executable, 'bytes': binary_info.st_size}
    if (not isinstance(receipt, dict) or any(receipt.get(key) != value for key, value in expected.items())
            or not _is_digest(receipt.get('wheel_sha256'))
            or not _is_digest(receipt.get('binary_sha256'))
            or _sha256(binary) != receipt['binary_sha256']):
        raise BootstrapError(f'uv cache SHA256 or receipt verification failed: {directory}')
    if os.name != 'nt' and not os.access(binary, os.X_OK):
        raise BootstrapError(f'Cached uv is not executable: {binary}')
    return str(binary)


def ensure_uv(release: Path) -> str:
    """Return a verified project-local uv, downloading it on a cache miss.

    Call only after the user has opted into tool bootstrapping. Integrity,
    platform, filesystem, archive and network failures raise BootstrapError.
    An existing damaged cache is rejected instead of silently replaced.
    """
    staging = None
    try:
        release = _safe_path(release)
        if not release.is_dir() or release == Path(release.anchor):
            raise BootstrapError('uv bootstrap requires an existing dedicated release directory')
        target = _platform_key()
        executable = 'uv.exe' if target.startswith('windows-') else 'uv'
        tools = _safe_path(release / '.codex/tools/uv' / UV_VERSION)
        directory = _safe_path(tools / target)
        cached = _cached(directory, target, executable)
        if cached is not None:
            return cached
        item = _select_wheel(_metadata(), target)
        _safe_path(tools).mkdir(parents=True, exist_ok=True, mode=0o700)
        staging = Path(tempfile.mkdtemp(prefix=f'.{target}-', dir=_safe_path(tools)))
        wheel = _safe_path(staging / 'download.whl')
        with wheel.open('xb') as output:
            _download(item['url'], output, MAX_WHEEL_BYTES,
                      expected_size=item['size'], expected_sha256=item['digests']['sha256'])
        binary = staging / executable
        _extract_binary(wheel, binary, executable)
        wheel.unlink()
        receipt = {'format': 1, 'version': UV_VERSION, 'platform': target,
                   'wheel': item['filename'], 'wheel_sha256': item['digests']['sha256'],
                   'executable': executable, 'bytes': binary.stat().st_size, 'binary_sha256': _sha256(binary)}
        with _safe_path(staging / 'receipt.json').open('x', encoding='utf-8') as output:
            json.dump(receipt, output, indent=2)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        # Publish binary and receipt together; a crash before this rename leaves
        # only an unrecognised temporary directory, never a usable partial cache.
        _safe_path(directory)
        try:
            os.rename(_safe_path(staging), directory)
        except OSError:
            # Another bootstrap may have completed during the download.
            cached = _cached(directory, target, executable)
            if cached is None:
                raise
            return cached
        staging = None
        cached = _cached(directory, target, executable)
        if cached is None:
            raise BootstrapError('Published uv cache disappeared before verification')
        return cached
    except BootstrapError:
        raise
    except (OSError, urllib.error.URLError, ValueError, KeyError, TypeError, RuntimeError,
            zipfile.BadZipFile) as error:
        raise BootstrapError(f'Unable to prepare project-local uv {UV_VERSION}: {error}') from error
    finally:
        if staging is not None:
            # Only this invocation's checked temporary directory is disposable.
            # Refuse cleanup if its path was redirected in the meantime.
            cleanup = _safe_path(staging)
            if cleanup.parent != tools or not cleanup.name.startswith(f'.{target}-'):
                raise BootstrapError('Refusing cleanup outside the temporary uv tool directory')
            shutil.rmtree(cleanup)
