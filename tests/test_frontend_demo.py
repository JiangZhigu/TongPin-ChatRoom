"""Standalone-demo integrity and distribution boundaries."""
import hashlib
import importlib.util
import json
import sys
import threading
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import demo_receipt
import release


def fixture_demo(root):
    demo = root / 'demo'
    (demo / 'src').mkdir(parents=True)
    (demo / 'tools').mkdir()
    for name in ('app.html', 'package.json', 'package-lock.json', 'tsconfig.json',
                 'vite.config.ts', 'tools/build.mjs', 'src/main.tsx'):
        (demo / name).write_text('fixture')
    (demo / 'index.html').write_text('<!doctype html><p>standalone</p>')
    receipt = {'format': 1, 'inputs': demo_receipt.demo_inputs(root),
               'outputs': {'index.html': hashlib.sha256((demo / 'index.html').read_bytes()).hexdigest()}}
    (demo / 'build-receipt.json').write_text(json.dumps(receipt))
    return demo


@pytest.mark.parametrize('changed', ['src/main.tsx', 'index.html', 'package-lock.json'])
def test_demo_receipt_rejects_changed_source_or_output(tmp_path, changed):
    demo = fixture_demo(tmp_path)
    demo_receipt.verify_demo(tmp_path)
    (demo / changed).write_text('changed after build')
    with pytest.raises(ValueError, match='differs'):
        demo_receipt.verify_demo(tmp_path)


def test_release_includes_demo_and_excludes_private_or_installed_files():
    for name in ('demo/index.html', 'demo/README.md', 'demo/start-demo.cmd',
                 'demo/src/lib/api.ts', 'demo/build-receipt.json'):
        assert release.permitted(name)
    for name in ('demo/.env', 'demo/node_modules/react/index.js', 'demo/.codex/log.txt',
                 'demo/__pycache__/serve.pyc', 'demo/state.sqlite3'):
        assert not release.permitted(name)


def test_demo_static_server_exposes_only_bundled_html(tmp_path):
    spec = importlib.util.spec_from_file_location('demo_server_fixture', ROOT / 'demo/serve.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    (tmp_path / 'index.html').write_text('<p>demo fixture</p>')
    (tmp_path / 'source.txt').write_text('not public')
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(module.DemoHandler, directory=str(tmp_path)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    opener = build_opener(ProxyHandler({}))
    url = f'http://127.0.0.1:{server.server_port}'
    try:
        with opener.open(url + '/', timeout=5) as response:
            assert response.read() == b'<p>demo fixture</p>'
            assert response.headers['Cache-Control'] == 'no-store'
        for path in ('/api/v1/auth/bootstrap', '/source.txt', '/../README.md', '/src/main.tsx'):
            for method in ('GET', 'HEAD'):
                with pytest.raises(HTTPError) as error:
                    opener.open(Request(url + path, method=method), timeout=5)
                assert error.value.code == 404
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
