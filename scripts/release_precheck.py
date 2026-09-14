"""Read-only production precheck using this release's installed environment."""
from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
from contextlib import closing
from pathlib import Path

from tongpin.config import DEFAULT_POLICY, Settings
from tongpin.infra.paths import reject_links
from tongpin.infra.scanner import ClamdScanner


def check():
    checks = []
    warnings = []

    def add(name, ok, detail):
        checks.append({'check': name, 'passed': bool(ok), 'detail': detail})

    try:
        settings = Settings.from_env()
    except (ValueError, TypeError):
        return {'ready': False, 'checks': [{'check': 'configuration', 'passed': False,
                 'detail': 'Invalid environment, HTTPS origins, secret, data path, port, scanner or task bounds; values are not echoed.'}], 'warnings': []}
    add('production', settings.production, 'TONGPIN_ENV must be production for a production-ready result')
    add('frontend', (settings.web_dist / 'index.html').is_file(), 'Built frontend index is required')
    data = settings.data_root.resolve()
    try:
        reject_links(settings.data_root.absolute())
        add('data_path', data.exists() and data.is_dir(), 'Dedicated existing data directory; no symlinks/junctions')
    except ValueError:
        add('data_path', False, 'Data path contains a symbolic link or junction')
        return {'ready': False, 'checks': checks, 'warnings': warnings}
    database = data / 'data/tongpin.sqlite3'
    policy = dict(DEFAULT_POLICY)
    add('database', database.is_file(), 'Initialize the data and first administrator with protected offline management')
    if database.is_file():
        try:
            with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as conn:
                conn.execute('PRAGMA query_only=ON')
                row = conn.execute('SELECT values_json FROM policy_versions ORDER BY version DESC LIMIT 1').fetchone()
                if row:
                    policy.update(json.loads(row[0]))
                administrator = conn.execute("SELECT count(*) FROM users WHERE site_role='super_admin' AND status='active' AND must_change_password=0").fetchone()[0]
                add('administrator', administrator > 0, 'At least one active administrator with a usable password')
                known = {int(p.name.split('_', 1)[0]): hashlib.sha256(p.read_bytes()).hexdigest() for p in (Path(__file__).resolve().parents[1] / 'src/tongpin/migrations').glob('[0-9]*.sql')}
                current = dict(conn.execute('SELECT version,checksum FROM schema_migrations'))
                add('schema', current == known, 'Migration versions and byte checksums match this release')
                add('foreign_keys', not conn.execute('PRAGMA foreign_key_check').fetchall(), 'No persisted foreign-key violation')
                add('integrity', conn.execute('PRAGMA quick_check').fetchone()[0] == 'ok', 'SQLite quick_check is ok')
        except (sqlite3.Error, ValueError, TypeError):
            add('database_read', False, 'Database/schema is incomplete or not readable; no data was changed')
    add('operator', bool(policy.get('operator_name', '').strip()) and bool(policy.get('operator_contact', '').strip()), 'Operator name and contact are required')
    terms = policy.get('terms_version', '')
    add('terms', bool(terms) and not terms.startswith('development'), 'A reviewed non-development terms version is required')
    add('file_policy', not settings.allow_unscanned_files, 'Production does not permit unscanned document bypass')
    if policy.get('registration_mode') == 'open':
        warnings.append('Registration is OPEN under the current audited policy; confirm this is the operator decision before public access.')
    if data.exists():
        usage = shutil.disk_usage(data)
        used = usage.used * 100 / usage.total
        add('disk', used < policy.get('disk_high_watermark', 90), 'Disk usage is below the configured high watermark')
    scanner = ClamdScanner(settings.scanner_host, settings.scanner_port, settings.scanner_timeout).health()
    if scanner['status'] != 'reachable':
        warnings.append('The loopback scanner is not reachable/enabled. General documents remain quarantined; this check does not mark them clean.')
    warnings += ['TLS certificate, reverse-proxy reachability, firewall, host data permissions and independent backup retention require target-host validation.',
                 'This is a configuration/data precheck, not a public deployment or multi-client acceptance test.']
    return {'ready': all(item['passed'] for item in checks), 'checks': checks, 'warnings': warnings,
            'readOnly': True, 'scanner': scanner}


if __name__ == '__main__':
    result = check()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result['ready'] else 1)
