// Invoked by the isolated CI fixture harness. This file never installs a browser.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const report = { schemaVersion: 1, check: 'ci-browser-smoke', status: 'running', startedAt: new Date().toISOString(), steps: [], sockets: [], errors: [], ignoredRequests: [], assets: [], screenshots: [], viewports: [] };
let output, fixture, browser, expect;
let closing = false;
const pages = [];
const inside = (root, target) => { const relative = path.relative(root, target); return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); };
const redact = (value) => {
  let text = String(value);
  for (const secret of [fixture?.owner?.session, fixture?.member?.session]) if (secret) text = text.split(secret).join('[redacted]');
  return text.slice(0, 2000);
};
const urlPath = (value) => { try { return new URL(value).pathname; } catch { return '[invalid URL]'; } };
async function step(name, action) {
  const record = { name, startedAt: new Date().toISOString(), status: 'running' };
  report.steps.push(record);
  try { await action(); record.status = 'passed'; }
  catch (error) { record.status = 'failed'; record.error = redact(error.message); throw error; }
  finally { record.endedAt = new Date().toISOString(); }
}
async function initialize() {
  const outputEnv = process.env.TONGPIN_CI_OUTPUT;
  assert(outputEnv && path.isAbsolute(outputEnv), 'TONGPIN_CI_OUTPUT must be an absolute project-local directory');
  const target = path.resolve(outputEnv);
  assert(inside(repoRoot, target), 'Output must be inside this repository');
  let ancestor = target;
  while (true) {
    try { await stat(ancestor); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = path.dirname(ancestor); }
  }
  const resolvedAncestor = await realpath(ancestor);
  assert(resolvedAncestor === repoRoot || inside(repoRoot, resolvedAncestor), 'Output parent escapes repository');
  await mkdir(target, { recursive: true });
  output = await realpath(target);
  assert(inside(repoRoot, output), 'Output resolves outside repository');
  const fixturePath = process.env.TONGPIN_CI_FIXTURE;
  assert(fixturePath && path.isAbsolute(fixturePath), 'TONGPIN_CI_FIXTURE must be an absolute JSON file');
  fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  for (const key of ['baseUrl', 'cookieName', 'messageText', 'taskTitle']) assert(typeof fixture[key] === 'string' && fixture[key].length, `Missing fixture ${key}`);
  for (const role of ['owner', 'member']) for (const key of ['userId', 'session']) assert(typeof fixture[role]?.[key] === 'string' && fixture[role][key].length, `Missing fixture ${role}.${key}`);
  assert(fixture.owner.userId !== fixture.member.userId, 'Fixture requires distinct users');
  assert(fixture.group?.id && fixture.group?.title, 'Fixture requires a shared group');
  const base = new URL(fixture.baseUrl);
  assert(['http:', 'https:'].includes(base.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) && !base.username && !base.password, 'CI browser fixture must use a loopback HTTP origin');
  assert(base.pathname === '/' && !base.search && !base.hash, 'Fixture baseUrl must be an origin');
  report.origin = base.origin;
  const playwright = await import('@playwright/test');
  expect = playwright.expect.configure({ timeout: 15000 });
  browser = await playwright.chromium.launch({ headless: true });
  report.browser = { name: 'chromium', version: browser.version(), headless: true };
}
async function openPage(role) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  await context.addCookies([{ name: fixture.cookieName, value: fixture[role].session, url: fixture.baseUrl, httpOnly: true, sameSite: 'Lax', secure: fixture.baseUrl.startsWith('https:') }]);
  const page = await context.newPage();
  const entry = { role, page, navigating: false };
  pages.push(entry);
  page.setDefaultTimeout(15000);
  page.on('console', (message) => { if (message.type() === 'error') report.errors.push({ role, kind: 'console', message: redact(message.text()) }); });
  page.on('pageerror', (error) => report.errors.push({ role, kind: 'pageerror', message: redact(error.message) }));
  page.on('requestfailed', (request) => {
    const error = request.failure()?.errorText || 'unknown';
    const item = { role, kind: 'requestfailed', path: urlPath(request.url()), message: redact(error) };
    if (closing || (entry.navigating && request.isNavigationRequest() && error === 'net::ERR_ABORTED')) report.ignoredRequests.push(item);
    else report.errors.push(item);
  });
  page.on('response', (response) => {
    const pathname = urlPath(response.url());
    if (response.status() >= 500) report.errors.push({ role, kind: 'http', path: pathname, status: response.status() });
    if (/\.(?:js|css)$/.test(pathname) && !report.assets.some((item) => item.path === pathname)) report.assets.push({ path: pathname, status: response.status() });
  });
  page.on('websocket', (socket) => {
    const address = new URL(socket.url());
    if (!address.pathname.includes('socket.io')) return;
    const record = { role, path: address.pathname, transport: address.searchParams.get('transport'), framesReceived: 0, framesSent: 0, connected: false };
    report.sockets.push(record);
    socket.on('framereceived', ({ payload }) => { record.framesReceived++; if (String(payload).startsWith('40')) record.connected = true; });
    socket.on('framesent', () => record.framesSent++);
    socket.on('socketerror', (error) => { if (!closing) report.errors.push({ role, kind: 'websocket', message: redact(error) }); });
  });
  await navigate(entry, false);
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  return entry;
}
async function navigate(entry, reload) {
  entry.navigating = true;
  try { if (reload) await entry.page.reload({ waitUntil: 'domcontentloaded' }); else await entry.page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' }); }
  finally { entry.navigating = false; }
}
async function openGroup(entry) {
  const page = entry.page;
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^消息(?:\s|$)/ }).click();
  // Match exact rendered group text independently of unread badges and previews.
  const matching = page.getByRole('complementary', { name: '会话列表' }).locator('button.conversation-item').filter({ has: page.getByText(fixture.group.title, { exact: true }) });
  await expect(matching).toHaveCount(1);
  await matching.click();
  await expect(page.getByLabel('消息内容', { exact: true })).toBeEditable();
}
const message = (page) => page.getByRole('region', { name: '消息记录' }).getByText(fixture.messageText, { exact: true });
const taskWorkspace = (page) => page.locator('.task-workspace');
const savedTask = (page) => taskWorkspace(page).getByRole('button', { name: fixture.taskTitle, exact: true });
async function openTasks(page) {
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '待办', exact: true }).click();
  const workspace = taskWorkspace(page);
  await expect(workspace.getByRole('heading', { name: '把交流变成可跟进的事', exact: true })).toBeVisible();
  await expect(workspace.getByRole('button', { name: '新建待办', exact: true })).toBeEnabled();
  return workspace;
}
async function screenshot(entry, name) {
  const filename = `${name}.png`;
  const buffer = await entry.page.screenshot({ path: path.join(output, filename), fullPage: true, animations: 'disabled' });
  report.screenshots.push({ role: entry.role, file: filename, sha256: createHash('sha256').update(buffer).digest('hex') });
}
async function viewport(entry, surface, width) {
  await entry.page.setViewportSize({ width, height: 900 });
  await entry.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const metrics = await entry.page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
  report.viewports.push({ role: entry.role, surface, ...metrics });
  await screenshot(entry, `${surface}-${width}`);
  assert(metrics.documentWidth <= metrics.width + 1 && metrics.bodyWidth <= metrics.width + 1, `${surface} overflows horizontally at ${width}px`);
  if (surface === 'chat') { await expect(message(entry.page)).toBeVisible(); await expect(entry.page.getByLabel('消息内容', { exact: true })).toBeEditable(); }
  else await expect(savedTask(entry.page)).toBeVisible();
}
try {
  await step('initialize-isolated-chromium', initialize);
  let owner, member;
  await step('open-two-authenticated-contexts', async () => { owner = await openPage('owner'); member = await openPage('member'); await openGroup(owner); await openGroup(member); });
  await step('websocket-handshakes', async () => {
    for (const role of ['owner', 'member']) await expect.poll(() => report.sockets.some((item) => item.role === role && item.transport === 'websocket' && item.connected)).toBe(true);
  });
  await step('send-and-receive-without-reload', async () => {
    await expect(message(member.page)).toHaveCount(0);
    await owner.page.getByLabel('消息内容', { exact: true }).fill(fixture.messageText);
    await owner.page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(message(owner.page)).toBeVisible();
    await expect(message(member.page)).toBeVisible();
    await expect(owner.page.getByLabel('消息内容', { exact: true })).toHaveValue('');
    report.realtime = { receivedBeforeReload: true, receiver: 'member' };
  });
  await step('message-persists-after-reload', async () => { await navigate(member, true); await openGroup(member); await expect(message(member.page)).toBeVisible(); });
  await step('create-personal-task-through-ui', async () => {
    const workspace = await openTasks(owner.page);
    await workspace.getByRole('button', { name: '新建待办', exact: true }).click();
    const dialog = owner.page.getByRole('dialog', { name: '新建待办', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('可见范围').selectOption('personal');
    await dialog.getByLabel(/待办标题/).fill(fixture.taskTitle);
    await dialog.getByRole('button', { name: '确认创建待办', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: '待办已创建', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '查看已保存待办', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const detail = owner.page.getByRole('dialog', { name: '待办详情', exact: true });
    await expect(detail.getByRole('heading', { name: fixture.taskTitle, exact: true })).toBeVisible();
    await detail.getByRole('button', { name: '关闭详情', exact: true }).click();
    await expect(detail).toHaveCount(0);
  });
  await step('personal-task-persists-after-reload', async () => {
    await navigate(owner, true);
    const workspace = await openTasks(owner.page);
    const personal = workspace.getByRole('navigation', { name: '任务范围', exact: true }).getByRole('button', { name: '个人待办', exact: true });
    await personal.click();
    await expect(personal).toHaveAttribute('aria-current', 'page');
    await expect(savedTask(owner.page)).toBeVisible();
  });
  for (const width of [320, 768, 1440]) await step(`rendered-viewports-${width}`, async () => { await viewport(member, 'chat', width); await viewport(owner, 'tasks', width); });
  await step('no-browser-runtime-errors', async () => { assert.equal(report.errors.length, 0, `Unexpected browser errors: ${JSON.stringify(report.errors)}`); });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = redact(error.message); process.exitCode = 1;
  if (output) for (const entry of pages) { try { await screenshot(entry, `failure-${entry.role}`); } catch { /* Preserve the original failure. */ } }
} finally {
  closing = true;
  if (browser) { try { await browser.close(); } catch (error) { report.errors.push({ kind: 'close', message: redact(error.message) }); report.status = 'failed'; process.exitCode = 1; } }
  report.endedAt = new Date().toISOString();
  if (output) await writeFile(path.join(output, 'observed-browser.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ status: report.status, report: output ? path.join(output, 'observed-browser.json') : null, failure: report.failure })}\n`);
}
