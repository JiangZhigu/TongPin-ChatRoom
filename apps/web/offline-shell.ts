import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

/** The cache contains only build artifacts, never authenticated responses or user data. */
export function offlineShell(): Plugin {
  return {
    name: 'tongpin-offline-shell', apply: 'build', enforce: 'post',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter((name) => name === 'index.html' || (name.startsWith('assets/') && !name.endsWith('.map'))).sort();
      if (!files.includes('index.html')) throw new Error('Offline shell requires the final HTML build artifact');
      const fingerprint = createHash('sha256').update(files.map((name) => {
        const output = bundle[name];
        return name + ':' + createHash('sha256').update(output.type === 'chunk' ? output.code : output.source).digest('hex');
      }).join('\n')).digest('hex').slice(0, 20);
      const source = `
'use strict';
const CACHE = 'tongpin-shell-${fingerprint}';
const STATIC = ${JSON.stringify(files.map((name) => '/' + name))};
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(STATIC.map(path => new Request(path, { credentials: 'omit', cache: 'reload' })))));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('tongpin-shell-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (STATIC.includes(url.pathname) && !url.search) {
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(url.pathname)) || fetch(request)));
    return;
  }
  // Only the product root gets an offline navigation fallback. Admin, API, file and
  // socket paths remain network-only, including downloads opened in a new tab.
  if (request.mode === 'navigate' && url.pathname === '/' && !url.search) {
    event.respondWith(fetch(request).catch(async () => {
      const cached = await (await caches.open(CACHE)).match('/index.html');
      return cached || Response.error();
    }));
  }
});
`;
      this.emitFile({ type: 'asset', fileName: 'service-worker.js', source });
    },
  };
}
