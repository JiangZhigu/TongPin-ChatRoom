from __future__ import annotations

import importlib.util
import io
import json
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace

from flask import Flask, g, jsonify

ROOT = Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f'scripts/{name}.py')
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def test_ci_probe_keeps_original_error_response_and_excludes_sensitive_values(capsys):
    probe = module('ci_server_probe')
    app = Flask('ci-probe-test')
    secret = 'synthetic-secret-that-must-never-be-printed'

    @app.before_request
    def request_id():
        g.request_id = 'a' * 24

    @app.errorhandler(Exception)
    def original(error):
        return jsonify({'error': 'original-safe-response'}), 500

    @app.get('/objects/<object_id>')
    def broken(object_id):
        raise ValueError(secret)

    probe.instrument(SimpleNamespace(flask=app))
    response = app.test_client().get('/objects/private-object-id')
    assert response.status_code == 500
    assert response.json == {'error': 'original-safe-response'}
    output = capsys.readouterr().out
    assert secret not in output and 'private-object-id' not in output
    record = json.loads(output.removeprefix(probe.PREFIX))
    assert record['type'] == 'ValueError' and record['requestId'] == 'a' * 24
    assert record['route'] == '/objects/<object_id>'
    assert 1 <= len(record['frames']) <= 12
    assert any(frame['function'] == 'broken' for frame in record['frames'])
    assert all(set(frame) == {'file', 'line', 'function'} for frame in record['frames'])


def test_ci_server_uses_real_entry_and_restores_factory(monkeypatch):
    from tongpin import __main__ as entry

    probe = module('ci_server_probe')
    calls = []
    factory = lambda value: calls.append(('factory', value)) or value
    monkeypatch.setattr(entry, 'create_application', factory)
    monkeypatch.setattr(probe, 'instrument', lambda value: calls.append(('instrument', value)) or value)
    monkeypatch.setattr(entry, 'main', lambda: entry.create_application('settings'))
    probe.main()
    assert calls == [('factory', 'settings'), ('instrument', 'settings')]
    assert entry.create_application is factory


def test_ci_diagnostics_bounds_records_and_omits_raw_server_exception_messages(tmp_path):
    smoke = module('ci_browser_smoke')
    secret = 'synthetic-sensitive-server-message'
    rows = ['OLD-prefix-outside-bound' + 'x' * 70000]
    rows += ['ValueError: ' + secret]
    rows += ['TONGPIN_CI_EXCEPTION ' + json.dumps({'type': 'ValueError', 'requestId': str(index),
              'route': '/probe', 'frames': [], 'message': secret, 'locals': {'secret': secret}}) for index in range(20)]
    rows += ['TONGPIN_CI_EXCEPTION {invalid']
    (tmp_path / 'server.log').write_text('\n'.join(rows), encoding='utf-8')
    result = smoke.server_diagnostics(tmp_path)
    encoded = json.dumps(result)
    assert result['available'] and len(result['exceptions']) == 12
    assert result['exceptions'][0]['requestId'] == '8'
    assert result['unhandledTypes'] == ['ValueError']
    assert secret not in encoded and 'OLD-prefix-outside-bound' not in encoded
    assert 'message' not in result['exceptions'][0] and 'locals' not in result['exceptions'][0]


def test_ci_failure_includes_server_metadata_with_or_without_browser_report(tmp_path):
    smoke = module('ci_browser_smoke')
    fixture = {role: {'session': role + '-session', 'csrf': role + '-csrf'} for role in ('owner', 'member')}
    (tmp_path / 'server.log').write_text('TONGPIN_CI_EXCEPTION ' + json.dumps({'type': 'RuntimeError',
        'requestId': 'a' * 24, 'route': '/meta', 'frames': []}) + '\n', encoding='utf-8')
    for with_report in (False, True):
        if with_report:
            (tmp_path / 'observed-browser.json').write_text(json.dumps({'status': 'failed', 'steps': [],
                'failure': 'owner-session member-csrf'}), encoding='utf-8')
        output = io.StringIO()
        with redirect_stdout(output):
            smoke.browser_failure(tmp_path, fixture, 1)
        result = json.loads(output.getvalue())
        assert result['serverDiagnostics']['exceptions'][0]['type'] == 'RuntimeError'
        assert 'owner-session' not in output.getvalue() and 'member-csrf' not in output.getvalue()
    (tmp_path / 'server.log').unlink()
    assert smoke.server_diagnostics(tmp_path)['available'] is False
