import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { chromium } from '@playwright/test';
import { observeRequests } from '../scripts/ci_browser_requests.mjs';

let browser, server, origin;
const navigation = '/api/v1/account/navigation';
before(async () => {
  server = createServer((request, response) => {
    if (request.url === '/') response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Request cancellation fixture</title>');
    else if (request.url.endsWith('?server-error')) response.writeHead(503).end('unavailable');
    else if (request.url === '/favicon.ico') response.writeHead(204).end();
    else response.writeHead(200, { 'Content-Type': 'application/json' }).write('{');
    // Other response bodies remain in flight until aborted or reloaded.
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  server?.closeAllConnections();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
});
async function fixture(t) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const observer = await observeRequests(page, { origin });
  await page.goto(origin);
  return { page, observer };
}
async function start(page, path = navigation, method = 'GET') {
  const started = page.waitForRequest((request) => new URL(request.url()).pathname === path.split('?')[0]);
  await page.evaluate(({ path, method }) => {
    window.controller = new AbortController();
    void fetch(path, { method, signal: window.controller.signal }).then((response) => response.text()).catch(() => {});
  }, { path, method });
  return started;
}
async function cancel(page) {
  const failed = page.waitForEvent('requestfailed');
  await page.evaluate(() => window.controller.abort());
  await failed;
}

test('recognizes an actual AbortController cancellation of the permission read', async (t) => {
  const { page, observer } = await fixture(t);
  await start(page);
  await cancel(page);
  const [failure] = await observer.collect();
  assert.equal(failure.message, 'net::ERR_ABORTED');
  assert.equal(failure.reason, 'application-abort-signal');
});
test('tracks an incomplete permission body until cancelled, without exempting later failures', async (t) => {
  const { page, observer } = await fixture(t);
  const responding = page.waitForResponse((response) => new URL(response.url()).pathname === navigation);
  await start(page);
  await responding;
  assert.equal(observer.pendingReads(), 1);
  await cancel(page);
  assert.equal(observer.pendingReads(), 0);
  assert.equal((await observer.collect())[0].reason, 'application-abort-signal');
  observer.beginNavigation();
  try { await page.reload(); } finally { observer.endNavigation(); }
  // A later request in the new document must not inherit that exemption.
  await page.route(`**${navigation}`, (route) => route.abort('aborted'));
  const later = page.waitForEvent('requestfailed');
  await start(page);
  await later;
  assert.equal((await observer.collect())[0].reason, undefined);
});
for (const [description, path, method] of [
  ['another endpoint', '/api/v1/tasks', 'GET'],
  ['a mutation on the same endpoint', navigation, 'POST'],
]) test(`does not excuse a cancelled ${description}`, async (t) => {
  const { page, observer } = await fixture(t);
  await start(page, path, method);
  await cancel(page);
  assert.equal((await observer.collect())[0].reason, undefined);
});
test('does not excuse an aborted read without a signal or scripted reload', async (t) => {
  const { page, observer } = await fixture(t);
  await page.route(`**${navigation}`, (route) => route.abort('aborted'));
  const failed = page.waitForEvent('requestfailed');
  await start(page);
  await failed;
  const [failure] = await observer.collect();
  assert.equal(failure.message, 'net::ERR_ABORTED');
  assert.equal(failure.reason, undefined);
});
test('does not transfer abort evidence to another request with the same URL and error', async (t) => {
  const { page, observer } = await fixture(t);
  await start(page);
  await cancel(page);
  await page.route(`**${navigation}`, (route) => route.abort('aborted'));
  const failed = page.waitForEvent('requestfailed');
  await start(page);
  await failed;
  const failures = await observer.collect();
  assert.equal(failures.length, 2);
  assert.equal(failures[0].reason, 'application-abort-signal');
  assert.equal(failures[1].message, 'net::ERR_ABORTED');
  assert.equal(failures[1].reason, undefined);
});
test('does not hide connection errors', async (t) => {
  const { page, observer } = await fixture(t);
  await page.route(`**${navigation}`, (route) => route.abort('connectionrefused'));
  const failed = page.waitForEvent('requestfailed');
  await start(page);
  await failed;
  const [failure] = await observer.collect();
  assert.equal(failure.message, 'net::ERR_CONNECTION_REFUSED');
  assert.equal(failure.reason, undefined);
});
test('preserves server error responses for the smoke HTTP error check', async (t) => {
  const { page } = await fixture(t);
  const response = page.waitForResponse((response) => response.status() === 503);
  await page.evaluate((path) => fetch(path), `${navigation}?server-error`);
  assert.equal((await response).status(), 503);
});
