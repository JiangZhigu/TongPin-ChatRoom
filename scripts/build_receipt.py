"""Frontend build inputs and output hashes shared by build and release commands."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RECEIPT = 'build-receipt.json'


def hashes(paths, root=ROOT):
    return {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(paths) if p.is_file()}


def inputs(root=ROOT):
    paths = list((root / 'apps/web/src').rglob('*'))
    paths += [p for p in (root / 'apps/web').iterdir() if p.is_file()]
    paths += [root / 'package.json', root / 'package-lock.json', root / 'tsconfig.base.json']
    return hashes(paths, root)


def outputs(root=ROOT):
    return hashes((p for p in (root / 'apps/web/dist').rglob('*') if p.name != RECEIPT), root)


def write(before, root=ROOT):
    if inputs(root) != before:
        raise ValueError('Frontend source changed during build; rebuild a stable checkout')
    receipt = {'format': 1, 'inputs': before, 'outputs': outputs(root)}
    (root / 'apps/web/dist' / RECEIPT).write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')


def verify(root=ROOT):
    path = root / 'apps/web/dist' / RECEIPT
    if not path.is_file():
        raise ValueError('Frontend build receipt is missing; run scripts/build.py')
    receipt = json.loads(path.read_text(encoding='utf-8'))
    if receipt.get('format') != 1 or receipt.get('inputs') != inputs(root) or receipt.get('outputs') != outputs(root):
        raise ValueError('Frontend source or output differs from the build receipt; rebuild before packaging')
    return receipt
