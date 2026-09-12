import { build } from 'vite';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function inputs() {
  const paths = ['app.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'tools/build.mjs'];
  async function walk(folder) { for (const entry of await readdir(path.join(root, folder), { withFileTypes: true })) { const name = folder + '/' + entry.name; if (entry.isDirectory()) await walk(name); else if (entry.isFile()) paths.push(name); } }
  await walk('src');
  return Object.fromEntries(await Promise.all(paths.sort().map(async name => [name, digest(await readFile(path.join(root, name)))])));
}
const before = await inputs();
await build({ configFile: path.join(root, 'vite.config.ts') });
let html = await readFile(path.join(root, 'dist/app.html'), 'utf8');
for (const match of [...html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/g)]) {
  const script = await readFile(path.join(root, 'dist', match[1]), 'utf8');
  html = html.replace(match[0], () => '<script type="module">' + script.replace(/<\/script/gi, '<\\/script') + '</script>');
}
for (const match of [...html.matchAll(/<link\b[^>]*href="([^"]+\.css)"[^>]*>/g)]) {
  const css = await readFile(path.join(root, 'dist', match[1]), 'utf8');
  html = html.replace(match[0], () => '<style>' + css + '</style>');
}
html = html.replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src data: blob:; worker-src \'none\'; base-uri \'none\'; form-action \'none\'">');
await writeFile(path.join(root, 'index.html'), html);
if (JSON.stringify(before) !== JSON.stringify(await inputs())) throw new Error('Demo inputs changed during build. Rebuild stable source.');
if (/<script\b[^>]*\bsrc=|<link\b[^>]*\brel="(?:stylesheet|modulepreload)"/i.test(html)) throw new Error('Standalone document contains external bundle references.');
await writeFile(path.join(root, 'build-receipt.json'), JSON.stringify({ format: 1, inputs: before, outputs: { 'index.html': digest(html) }, transport: 'browser-local' }, null, 2) + '\n');
console.log(JSON.stringify({ standalone: path.join(root, 'index.html'), bytes: Buffer.byteLength(html), backendConnections: 'blocked by demo transport and CSP' }));
