"""Create a reviewed local source bundle or stage a hash-verified bundle in a new directory."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import zipfile
from pathlib import PurePosixPath

from build_receipt import verify
from deploy import ROOT, digest, safe_path

MANIFEST = 'release-manifest.json'
ROOT_FILES = {'.gitattributes', '.gitignore', '.dockerignore', '.python-version', '.env.example',
              'Dockerfile', 'compose.yaml', 'README.md', 'LICENSE', 'pyproject.toml', 'uv.lock',
              'package.json', 'package-lock.json', 'tsconfig.base.json', 'THIRD_PARTY_NOTICES.md',
              'tongpin.cmd', 'tongpin.ps1', 'tongpin.sh', 'install.cmd', 'install.sh',
              'INSTALL-PYTHON.zh-CN.md'}
PREFIXES = ('src/', 'scripts/', 'apps/web/', 'tests/', 'docs/', 'implementation/', '.github/workflows/',
            'vendor/unicode/', 'packages/contracts/src/')
MAX_BYTES = 1024 * 1024 * 1024


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT).decode('utf-8')


def permitted(name):
    parts = PurePosixPath(name).parts
    return (name in ROOT_FILES or name.startswith(PREFIXES)) and not any(
        part in {'.env', '.codex', '.git', '.idea', '.venv', '__pycache__', 'node_modules'}
        or part.lower().endswith(('.sqlite3', '.sqlite3-wal', '.sqlite3-shm', '.pyc')) for part in parts)


def package(options):
    verify()
    changed = git('diff', '--name-only', '-z').split('\0') + git('diff', '--cached', '--name-only', '-z').split('\0')
    if any(permitted(name) for name in changed if name):
        raise ValueError('Commit reviewed tracked changes before packaging')
    names = git('ls-files', '-z').split('\0')
    names = [name for name in names if name and permitted(name)]
    untracked = git('ls-files', '--others', '--exclude-standard', '-z').split('\0')
    if any(permitted(name) for name in untracked if name):
        raise ValueError('Uncommitted deliverable files exist; review and commit them before packaging')
    names += [p.relative_to(ROOT).as_posix() for p in (ROOT / 'apps/web/dist').rglob('*') if p.is_file()]
    names = sorted(set(names))
    rows = []
    for name in names:
        path = safe_path(ROOT / name)
        if not path.is_file() or not permitted(name):
            raise ValueError('Unsupported release entry: ' + name)
        rows.append({'path': name, 'sha256': digest(path), 'bytes': path.stat().st_size})
    target = safe_path(options.output)
    if target.exists():
        raise ValueError('Output exists; choose a new bundle path')
    target.parent.mkdir(parents=True, exist_ok=True)
    manifest = {'format': 1, 'commit': git('rev-parse', 'HEAD').strip(), 'files': rows,
                'dataIncluded': False, 'dependenciesIncluded': False, 'frontendIncluded': True}
    # Exclusive creation avoids replacing an existing archive after a race.
    with zipfile.ZipFile(target, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for row in rows:
            path = ROOT / row['path']
            content = path.read_bytes()
            if hashlib.sha256(content).hexdigest() != row['sha256']:
                raise ValueError('Source changed during packaging')
            archive.writestr(row['path'], content)
        archive.writestr(MANIFEST, json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    checksum = digest(target)
    sidecar = target.with_suffix(target.suffix + '.sha256')
    with sidecar.open('x', encoding='ascii') as stream:
        stream.write(checksum + '  ' + target.name + '\n')
    return {'archive': str(target), 'sha256': checksum, 'commit': manifest['commit'], 'files': len(rows), 'bytes': target.stat().st_size}


def archive_entries(archive):
    entries = archive.infolist()
    if len(entries) > 10000 or sum(item.file_size for item in entries) > MAX_BYTES:
        raise ValueError('Bundle exceeds the file count or 1 GiB unpacked bound')
    seen = set()
    for item in entries:
        name = item.filename
        path = PurePosixPath(name)
        mode = item.external_attr >> 16
        if (not name or '\\' in name or ':' in name or path.is_absolute() or '..' in path.parts
                or str(path) != name or item.is_dir() or stat.S_ISLNK(mode)
                or any(p.rstrip('. ') != p or re.match(r'(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', p) for p in path.parts)
                or name.casefold() in seen or (name != MANIFEST and not permitted(name))):
            raise ValueError('Unsafe, duplicate or unsupported bundle entry')
        seen.add(name.casefold())
    return entries


def stage(options):
    bundle, destination = safe_path(options.bundle), safe_path(options.destination)
    if not re.fullmatch('[a-fA-F0-9]{64}', options.sha256) or digest(bundle) != options.sha256.lower():
        raise ValueError('Bundle SHA-256 did not match the expected separately recorded value')
    if destination.exists():
        raise ValueError('Destination exists; stage into a new release directory')
    with zipfile.ZipFile(bundle) as archive:
        entries = archive_entries(archive)
        manifest_entry = archive.getinfo(MANIFEST)
        if manifest_entry.file_size > 4 * 1024 * 1024:
            raise ValueError('Manifest is too large')
        manifest = json.loads(archive.read(MANIFEST))
        if not isinstance(manifest, dict) or not isinstance(manifest.get('files'), list):
            raise TypeError('Invalid bundle manifest')
        rows = manifest.get('files', [])
        expected = {row['path']: row for row in rows}
        if manifest.get('format') != 1 or len(expected) != len(rows) or set(expected) != {item.filename for item in entries if item.filename != MANIFEST}:
            raise ValueError('Bundle and manifest entry sets differ')
        # Validate the full archive before creating the destination.
        for name, row in expected.items():
            if archive.getinfo(name).file_size != row['bytes'] or hashlib.sha256(archive.read(name)).hexdigest() != row['sha256']:
                raise ValueError('Bundle file verification failed')
        destination.mkdir(parents=True, mode=0o700)
        for item in entries:
            target = safe_path(destination / item.filename)
            if destination not in target.parents:
                raise ValueError('Bundle entry escaped the destination')
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as stream:
                stream.write(archive.read(item.filename))
            if item.filename.endswith('.sh') and os.name != 'nt':
                target.chmod(0o700)
    return {'staged': str(destination), 'commit': manifest.get('commit'), 'files': len(expected), 'installed': False, 'dataModified': False}


def verify_staged(directory):
    """Recheck installed bundle files; local dependency/cache files are outside the manifest."""
    path = safe_path(directory / MANIFEST)
    if not path.is_file() or path.stat().st_size > 4 * 1024 * 1024:
        raise ValueError('Staged release manifest is missing or too large')
    manifest = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(manifest, dict):
        raise TypeError('Invalid staged release manifest')
    rows = manifest.get('files', [])
    if manifest.get('format') != 1 or not isinstance(rows, list) or not rows or len(rows) > 10000:
        raise ValueError('Invalid staged release manifest')
    seen = set()
    for row in rows:
        name = row['path']
        relative = PurePosixPath(name)
        if (relative.is_absolute() or '..' in relative.parts or str(relative) != name
                or '\\' in name or ':' in name or not permitted(name) or name.casefold() in seen):
            raise ValueError('Unsafe staged release manifest entry')
        seen.add(name.casefold())
        target = safe_path(directory / name)
        if directory not in target.parents or not target.is_file() or target.stat().st_size != row['bytes'] or digest(target) != row['sha256']:
            raise ValueError('Staged release file differs from its verified manifest: ' + name)
    return {'commit': manifest.get('commit'), 'files': len(rows)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    create = sub.add_parser('package')
    create.add_argument('--output', required=True)
    extract = sub.add_parser('stage')
    extract.add_argument('--bundle', required=True)
    extract.add_argument('--sha256', required=True)
    extract.add_argument('--destination', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(package(args) if args.command == 'package' else stage(args), ensure_ascii=False, indent=2))
        return 0
    except (ValueError, KeyError, TypeError, OSError, zipfile.BadZipFile, subprocess.SubprocessError) as error:
        print('Release operation stopped: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
