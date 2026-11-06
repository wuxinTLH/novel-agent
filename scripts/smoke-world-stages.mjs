import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright';

// Run only AFTER the parent finishes `npm run build`. Never uses dev/user data,
// existing browser profiles, credentials, model calls, or remote integrations.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-world-stages-'));
const data = path.join(temporary, 'data');
const artifacts = path.join(root, 'test-results', `world-stages-${path.basename(temporary)}`);
const textName = 'smoke-stage-lore.txt';
const mapName = 'smoke-stage-map.png';
const existingName = 'smoke-existing-ungrouped.md';
const stageOneName = '烟测·第一纪元';
const stageTwoName = '烟测·第二纪元';
const renamedName = '烟测·第二纪元（重命名与窄屏长名称验证）';
// Generate a real CRC-valid 2x2 RGB PNG without image libraries or fixture files.
const pngChunk = (type, bytes) => {
  const payload = Buffer.concat([Buffer.from(type, 'ascii'), bytes]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, payload, checksum]);
};
const imageHeader = Buffer.alloc(13);
imageHeader.writeUInt32BE(2, 0);
imageHeader.writeUInt32BE(2, 4);
imageHeader[8] = 8;
imageHeader[9] = 2;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk('IHDR', imageHeader),
  pngChunk('IDAT', deflateSync(Buffer.from([0, 40, 100, 140, 60, 120, 160, 0, 80, 140, 180, 100, 160, 200]))),
  pngChunk('IEND', Buffer.alloc(0)),
]);
let server;
let browser;
let page;
let step = 'prepare isolated production deployment';
const browserErrors = [];
const failedRequests = [];
const externalRequests = [];
const forbiddenRequests = [];
try {
  for (const entry of ['build/packages/server/src/index.js', 'dist/index.html']) {
    assert.ok(fs.existsSync(path.join(root, entry)), `Missing ${entry}; finish npm run build first.`);
  }
  // The server resolves .env from app root, so DATA_DIR/cwd alone is insufficient.
  fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({
    name: 'novel-agent', type: 'module', workspaces: ['packages/web', 'packages/server'],
  }));
  fs.cpSync(path.join(root, 'build'), path.join(temporary, 'build'), { recursive: true });
  fs.cpSync(path.join(root, 'dist'), path.join(temporary, 'dist'), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(temporary, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(data);
  fs.mkdirSync(artifacts, { recursive: true });
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA'].includes(key.toUpperCase())));
  Object.assign(environment, {
    PORT: String(port), DATA_DIR: data, NODE_ENV: 'production', CoreModel: 'local',
    MODEL_API_KEY: '', MODEL_SECRETS_KEY: '', PLATFORM_SECRETS_KEY: '',
  });
  server = spawn(process.execPath, [path.join(temporary, 'build/packages/server/src/index.js')], {
    cwd: temporary, env: environment, stdio: 'ignore',
  });
  let startupError;
  server.on('error', (error) => { startupError = error; });
  let session;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const response = await fetch(`${base}/api/auth/session`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) { session = await response.json(); break; }
    } catch {}
    if (startupError || server.exitCode !== null) break;
    await delay(100);
  }
  assert.ok(session, `isolated server starts (${startupError?.message ?? server.exitCode})`);
  assert.equal(session.enabled, false, 'fresh deployment has no inherited authentication');
  const get = async (url) => {
    const response = await fetch(`${base}${url}`, { signal: AbortSignal.timeout(15000) });
    assert.ok(response.ok, `${url}: HTTP ${response.status}`);
    return response.json();
  };
  const health = await get('/api/health');
  const request = (url, method, body) => fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Platform-CSRF': health.platform.csrfToken },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const mutate = async (url, method, body) => {
    const response = await request(url, method, body);
    assert.ok(response.ok, `${method} ${url}: HTTP ${response.status}`);
    return response.json();
  };
  const project = await mutate('/api/projects', 'POST', {
    title: 'World stages isolated smoke', genre: '奇幻', description: 'Disposable synthetic fixture.',
  });
  const projectPath = `/api/projects/${project.id}`;
  const assetPath = `${projectPath}/assets`;
  const stagesPath = `${projectPath}/world-stages`;
  const initial = await mutate(assetPath, 'POST', {
    name: existingName, category: 'world', content: '# Synthetic existing lore\nNo real manuscript.',
  });
  const existing = initial.assets.find((asset) => asset.name === existingName);
  assert.ok(existing);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', serviceWorkers: 'block' });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(`${base}/`)) {
      // A regression must never trigger generation or platform side effects.
      if (route.request().method() !== 'GET' && /\/api\/.*(?:\/run(?:\/|$)|\/generate(?:\/|$)|\/publication|\/platforms\/)/.test(new URL(url).pathname)) {
        forbiddenRequests.push(new URL(url).pathname);
        return route.abort();
      }
      return route.continue();
    }
    if (/^(data:|blob:)/.test(url)) return route.continue();
    externalRequests.push(url);
    if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url))
      return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    return route.abort();
  });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
  page.on('requestfailed', (request) => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  await page.addInitScript((id) => {
    localStorage.setItem('novel-project', id);
    localStorage.setItem('novel-theme', 'mtf');
  }, project.id);
  const stages = page.getByRole('region', { name: '世界观阶段', exact: true });
  const stageButton = (name) => {
    // Stage and ungrouped tabs include a live asset count in their accessible name.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return stages.getByRole('button', { name: new RegExp(`^${escaped}(?:\\s+\\d+)?$`) });
  };
  const row = (name) => page.getByRole('combobox', { name: `所属阶段 ${name}`, exact: true });
  const expectRows = async (present, absent = []) => {
    for (const name of present) await row(name).waitFor({ state: 'visible' });
    for (const name of absent) await row(name).waitFor({ state: 'detached' });
  };
  const saveStage = async (name, method, suffix = '') => {
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('阶段名称', { exact: true }).fill(name);
    const [response] = await Promise.all([
      page.waitForResponse((response) => response.url() === `${base}${stagesPath}${suffix}` && response.request().method() === method),
      dialog.getByRole('button', { name: '保存阶段', exact: true }).click(),
    ]);
    assert.ok(response.ok(), `save stage: HTTP ${response.status()}`);
    await dialog.waitFor({ state: 'detached' });
    return response.json();
  };
  const upload = async (files) => {
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '选择文件', exact: true }).click();
    const chooser = await chooserPromise;
    assert.equal(await chooser.element().getAttribute('type'), 'file');
    assert.equal(await chooser.element().getAttribute('hidden') !== null, true, 'real hidden upload input is exercised');
    const [response] = await Promise.all([
      page.waitForResponse((response) => response.url() === `${base}${assetPath}/upload` && response.request().method() === 'POST'),
      chooser.setFiles(files),
    ]);
    assert.equal(response.status(), 201, 'upload succeeds through production file sandbox');
    return response.json();
  };

  step = 'create two stages and rename through real modal';
  // Enter through the real sidebar; production /assets can collide with Vite's
  // static asset directory, while history navigation exercises the intended UI.
  await page.goto(base);
  await page.getByRole('button', { name: /^小说设定库(?:\s*\d+)?$/ }).click();
  await stages.waitFor();
  await stageButton('全部阶段').waitFor();
  await stageButton('未分组').waitFor();
  await stageButton('新增阶段').click();
  let saved = await saveStage(stageOneName, 'POST');
  const first = saved.worldStages.find((item) => item.name === stageOneName);
  assert.ok(first);
  await stageButton('新增阶段').click();
  saved = await saveStage(stageTwoName, 'POST');
  const second = saved.worldStages.find((item) => item.name === stageTwoName);
  assert.ok(second);
  assert.notEqual(first.id, second.id);
  await stageButton(stageTwoName).click();
  await stageButton('重命名阶段').click();
  saved = await saveStage(renamedName, 'PATCH', `/${second.id}`);
  assert.equal(saved.worldStages.find((item) => item.id === second.id).name, renamedName);
  await stageButton(renamedName).waitFor();

  step = 'selected stage defaults for real TXT and PNG uploads, no cross-group leakage';
  await stageButton(stageOneName).click();
  await page.getByRole('combobox', { name: '上传设定分类', exact: true }).selectOption('world');
  saved = await upload([
    { name: textName, mimeType: 'text/plain', buffer: Buffer.from('# Synthetic first era\nOnly the first stage.') },
    { name: mapName, mimeType: 'image/png', buffer: png },
  ]);
  for (const name of [textName, mapName]) {
    const asset = saved.assets.find((item) => item.name === name);
    assert.ok(asset, `${name} persisted`);
    assert.equal(asset.worldStageId, first.id, 'selected stage applied to uploads');
    assert.equal(asset.category, 'world');
  }
  const map = saved.assets.find((item) => item.name === mapName);
  assert.equal(map.mime, 'image/png');
  assert.ok(map.url?.startsWith('/uploads/'));
  const mapResponse = await fetch(`${base}${map.url}`);
  assert.equal(mapResponse.status, 200, 'uploaded map remains accessible');
  assert.ok((await mapResponse.arrayBuffer()).byteLength > 0);
  await expectRows([textName, mapName], [existingName]);
  await stageButton(renamedName).click();
  await expectRows([], [textName, mapName, existingName]);
  await stageButton('未分组').click();
  await expectRows([existingName], [textName, mapName]);
  await stageButton('全部阶段').click();
  await expectRows([existingName, textName, mapName]);

  step = 'move existing asset with revision-checked row select and nullable ungroup';
  const move = async (name, value, expectedStage) => {
    const before = (await get(projectPath)).assets.find((item) => item.name === name);
    const [response] = await Promise.all([
      page.waitForResponse((response) => response.url() === `${base}${assetPath}/${before.id}` && response.request().method() === 'PATCH'),
      row(name).selectOption(value),
    ]);
    const payload = response.request().postDataJSON();
    assert.equal(payload.expectedRevision, before.revision || 1, 'move carries current asset revision');
    assert.equal(payload.worldStageId, expectedStage, 'move uses stage ID or explicit null');
    assert.ok(response.ok(), `move asset: HTTP ${response.status()}`);
    const result = await response.json();
    const asset = result.assets.find((item) => item.id === before.id);
    assert.equal(asset.worldStageId ?? null, expectedStage);
    assert.equal(asset.revision, (before.revision || 1) + 1);
    return asset;
  };
  await move(existingName, second.id, second.id);
  await stageButton(renamedName).click();
  await expectRows([existingName], [textName, mapName]);
  assert.equal(await stageButton('删除阶段').isDisabled(), true, 'occupied stage cannot be deleted');
  const ungroupedValue = await row(existingName).locator('option').evaluateAll((options) => {
    const option = options.find((item) => item.textContent.trim() === '未分组');
    if (!option) throw new Error('Missing ungrouped option');
    return option.value;
  });
  await move(existingName, ungroupedValue, null);
  await expectRows([], [existingName, textName, mapName]);

  step = 'empty stage deletion uses application confirmation and cancellation';
  await stageButton('删除阶段').click();
  const confirmation = page.getByRole('alertdialog');
  await confirmation.waitFor();
  assert.ok((await confirmation.textContent()).includes(renamedName));
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  assert.ok((await get(projectPath)).worldStages.some((item) => item.id === second.id), 'cancel keeps empty stage');
  await stageButton('删除阶段').click();
  await confirmation.waitFor();
  const [deleted] = await Promise.all([
    page.waitForResponse((response) => response.url() === `${base}${stagesPath}/${second.id}` && response.request().method() === 'DELETE'),
    confirmation.getByRole('button', { name: /^(确定|删除阶段|删除)$/ }).click(),
  ]);
  assert.ok(deleted.ok(), `delete empty stage: HTTP ${deleted.status()}`);
  await confirmation.waitFor({ state: 'detached' });
  await stageButton(renamedName).waitFor({ state: 'detached' });

  step = 'reload persistence and 390px layout';
  await page.reload();
  await stages.waitFor();
  await stageButton(stageOneName).click();
  await expectRows([textName, mapName], [existingName]);
  assert.equal(await stageButton('删除阶段').isDisabled(), true);
  saved = await get(projectPath);
  assert.deepEqual(saved.worldStages, [{ id: first.id, name: stageOneName }]);
  assert.equal(saved.assets.find((item) => item.id === existing.id).worldStageId ?? null, null);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  for (const [name, target] of [['document', page.locator('html')], ['world stages', stages]]) {
    const size = await target.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    assert.ok(size.scroll <= size.client + 1, `${name}: no overflow at 390px (${size.scroll}/${size.client})`);
  }
  await stageButton('全部阶段').click();
  await expectRows([existingName, textName, mapName]);
  await page.screenshot({ path: path.join(artifacts, 'world-stages-390.png'), fullPage: true });

  step = 'API rejects invalid and cross-project stages without mutating state';
  const other = await mutate('/api/projects', 'POST', { title: 'Foreign stage smoke fixture', genre: '奇幻', description: 'Synthetic only.' });
  await mutate(`/api/projects/${other.id}/world-stages`, 'POST', { name: 'Foreign stage' });
  const foreign = (await get(`/api/projects/${other.id}`)).worldStages[0];
  assert.ok(foreign);
  const beforeNegative = await get(projectPath);
  const target = beforeNegative.assets.find((item) => item.name === textName);
  const reject = async (url, method, body) => {
    const response = await request(url, method, body);
    assert.ok([400, 404, 409, 422].includes(response.status), `${method} ${url} rejected by validation (HTTP ${response.status})`);
    await response.arrayBuffer();
  };
  for (const invalidId of ['not-a-stage-id', foreign.id]) {
    await reject(assetPath, 'POST', { name: 'Must not persist', category: 'world', content: 'Synthetic.', worldStageId: invalidId });
    await reject(`${assetPath}/${target.id}`, 'PATCH', { expectedRevision: target.revision || 1, worldStageId: invalidId });
    const form = new FormData();
    form.append('category', 'world');
    form.append('worldStageId', invalidId);
    form.append('files', new Blob(['Synthetic rejected upload.'], { type: 'text/plain' }), 'must-not-persist.txt');
    const response = await fetch(`${base}${assetPath}/upload`, {
      method: 'POST', headers: { 'X-Platform-CSRF': health.platform.csrfToken }, body: form,
      signal: AbortSignal.timeout(15000),
    });
    assert.ok([400, 404, 409, 422].includes(response.status), `upload rejects invalid/cross-project stage: HTTP ${response.status}`);
    await response.arrayBuffer();
  }
  await reject(`${stagesPath}/${foreign.id}`, 'PATCH', { name: 'Must not rename foreign stage' });
  await reject(`${stagesPath}/${foreign.id}`, 'DELETE');
  await reject(stagesPath, 'POST', { name: '   ' });
  await reject(`${stagesPath}/${first.id}`, 'DELETE');
  const stale = await request(`${assetPath}/${target.id}`, 'PATCH', { expectedRevision: (target.revision || 1) + 10, worldStageId: null });
  assert.equal(stale.status, 409, 'revision mismatch cannot move an asset');
  await stale.arrayBuffer();
  assert.deepEqual(await get(projectPath), beforeNegative, 'every rejected mutation leaves project unchanged');
  assert.equal((await get(`/api/projects/${other.id}`)).worldStages[0].name, 'Foreign stage');
  assert.deepEqual(forbiddenRequests, [], 'no model/generation/publication mutations');
  assert.deepEqual(externalRequests.filter((url) => !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url)), [], 'no external integration requests');
  const knownFontCsp = (error) => error.includes('https://fonts.googleapis.com/') && error.includes('Content Security Policy') && error.includes('stylesheet');
  assert.deepEqual(browserErrors.filter((error) => !knownFontCsp(error)), [], 'no unexpected browser console/runtime errors');
  assert.deepEqual(failedRequests.filter(({ url, error }) => !(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url)) && error !== 'net::ERR_ABORTED'), [], 'no unexpected failed browser requests');
  console.log('PASS: isolated production world stages; create/rename; TXT+PNG selected-stage upload; filters/no cross-group leakage; revision-checked move/null ungroup; occupied delete disabled; empty delete cancel/confirm; refresh persistence; 390px no overflow; invalid/cross-project create/upload/PATCH rejected; no model or external integration calls.');
  console.log(`Synthetic screenshot: ${path.relative(root, artifacts)}`);
} catch (error) {
  console.error(`FAIL [${step}]: ${error.stack ?? error}`);
  if (page && !page.isClosed()) {
    console.error('Failure route:', new URL(page.url()).pathname);
    console.error('Stage section count:', await page.locator('section[aria-label="世界观阶段"]').count());
    console.error('Visible headings:', await page.getByRole('heading').allTextContents());
    console.error('Synthetic page excerpt:', (await page.locator('body').innerText()).slice(0, 2500));
    await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
    console.error(`Synthetic failure screenshot: ${path.join(artifacts, 'failure.png')}`);
  }
  if (browserErrors.length) console.error('Browser errors:', browserErrors);
  if (failedRequests.length) console.error('Failed requests:', failedRequests);
  process.exitCode = 1;
} finally {
  try {
    if (browser) await browser.close();
  } finally {
    try {
      if (server && server.exitCode === null && server.pid) {
        const exited = once(server, 'exit');
        server.kill();
        await exited;
      }
    } finally {
      // Only this invocation's verified mkdtemp target is removed; artifacts remain.
      assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
      assert.ok(path.basename(temporary).startsWith('novel-world-stages-'));
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}
