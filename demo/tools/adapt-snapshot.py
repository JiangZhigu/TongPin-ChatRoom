import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'src'
p = ROOT / 'App.tsx'
s = p.read_text(encoding='utf-8')
s = s.replace("const DevelopmentPreview = import.meta.env.DEV ? lazy(() => import('./DevelopmentPreview')) : null;", '')
s = re.sub(r"  if \(DevelopmentPreview.*?;\n", '', s)
p.write_text(s, encoding='utf-8')
for p in ROOT.rglob('*.ts*'):
    if 'sandbox' in p.parts: continue
    s = p.read_text(encoding='utf-8')
    if 'window.location.pathname' in s or 'window.location.search' in s:
        relative = './sandbox/navigation' if p.parent == ROOT else '../sandbox/navigation'
        s = "import { demoPath, demoSearch } from '" + relative + "';\n" + s
        s = s.replace('window.location.pathname', "demoPath().split('?')[0]").replace('window.location.search', 'demoSearch()')
    if p.name in ('AdminShell.tsx','AdminShared.tsx'):
        s = s.replace('window.location.origin', "'http://tongpin.demo'")
    s = s.replace('tongpin-local-v1', 'tongpin-demo-local-v1').replace('tongpin-emoji-recent:', 'tongpin-demo-emoji-recent:').replace('tongpin-browser-notifications:', 'tongpin-demo-browser-notifications:')
    p.write_text(s, encoding='utf-8')
p = ROOT / 'lib/invitation.ts'
s = p.read_text(encoding='utf-8').replace('new URL(trimmed, window.location.origin)', 'new URL(trimmed, window.location.href)').replace("window.location.origin + '/#invite=' + token", "window.location.href.split('#')[0] + '#invite=' + token")
p.write_text(s, encoding='utf-8')
