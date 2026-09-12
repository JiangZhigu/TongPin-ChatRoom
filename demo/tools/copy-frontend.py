"""Copy a traceable snapshot of the current product UI; never modify the source app."""
import hashlib
import json
import subprocess
from pathlib import Path

DEMO = Path(__file__).resolve().parents[1]
ROOT = DEMO.parent
SOURCE = ROOT / 'apps/web/src'
TARGET = DEMO / 'src'
assert not TARGET.exists(), 'Snapshot already exists; do not overwrite demo customizations.'
rows = []
for source in sorted(SOURCE.rglob('*')):
    if not source.is_file() or '.test.' in source.name or source.name in ('DevelopmentPreview.tsx', 'main.tsx'):
        continue
    relative = source.relative_to(SOURCE)
    target = TARGET / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    content = source.read_bytes()
    target.write_bytes(content)
    rows.append({'source': source.relative_to(ROOT).as_posix(), 'demo': target.relative_to(DEMO).as_posix(), 'sha256': hashlib.sha256(content).hexdigest()})
(DEMO / 'source-manifest.json').write_text(json.dumps({
    'source': 'Current working frontend, including uncommitted UX-R04 correction',
    'baseCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
    'sourceModified': False, 'files': rows}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'copied': len(rows), 'destination': str(TARGET)}))
