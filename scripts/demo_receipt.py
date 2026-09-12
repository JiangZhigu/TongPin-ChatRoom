"""Verify the standalone demo matches the source included in a release."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def demo_inputs(root=ROOT):
    demo = root / 'demo'
    paths = [demo / name for name in ('app.html', 'package.json', 'package-lock.json',
                                     'tsconfig.json', 'vite.config.ts', 'tools/build.mjs')]
    paths += [path for path in (demo / 'src').rglob('*') if path.is_file()]
    return {path.relative_to(demo).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(paths)}


def verify_demo(root=ROOT):
    demo = root / 'demo'
    receipt_path = demo / 'build-receipt.json'
    if not receipt_path.is_file() or not (demo / 'index.html').is_file():
        raise ValueError('Demo build is missing; run node demo/tools/build.mjs')
    receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
    outputs = {'index.html': hashlib.sha256((demo / 'index.html').read_bytes()).hexdigest()}
    if receipt.get('format') != 1 or receipt.get('inputs') != demo_inputs(root) or receipt.get('outputs') != outputs:
        raise ValueError('Demo source or output differs from its build receipt; rebuild before packaging')
    return receipt
