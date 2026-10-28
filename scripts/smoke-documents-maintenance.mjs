import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import yauzl from 'yauzl';

// Production acceptance only: separate ephemeral port and fresh local-JSON data.
// No real database, credentials, existing data, or Harness GUI is touched.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-documents-maintenance-smoke-'));
let child;
let browser;
const checks = [];
const canonical =
  '中文正文：青山与远方。\n<script>window.documentSmokeExecuted = true</script>\n第二段 & 原稿';
async function unzip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error || new Error('ZIP missing'));
      const files = new Map();
      zip.on('error', reject);
      zip.on('end', () => resolve(files));
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) return reject(error || new Error('ZIP entry missing'));
          const chunks = [];
          stream.on('error', reject);
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            files.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}
function pdfFixture() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length 45 >>\nstream\nBT /F1 12 Tf 20 200 Td (PDF smoke test) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  // Stream length is measured rather than relying on an approximate fixture.
  const stream = 'BT /F1 12 Tf 20 200 Td (PDF smoke test) Tj ET\n';
  objects[3] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`;
  let text = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(text));
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}
async function stop() {
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
}
try {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(root, 'build/packages/server/src/index.js')], {
    cwd: os.tmpdir(),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: data,
      MODEL_API_KEY: '',
      MODEL_SECRETS_KEY: '',
      PLATFORM_SECRETS_KEY: '',
    },
    stdio: 'ignore',
  });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      ready = (await fetch(`${base}/api/auth/session`)).ok;
    } catch {}
    if (ready || child.exitCode !== null) break;
    await delay(100);
  }
  assert.ok(ready, 'disposable production backend starts');
  const json = async (url, options) => {
    const response = await fetch(`${base}${url}`, options);
    assert.ok(response.ok, `${options?.method || 'GET'} ${url}: HTTP ${response.status}`);
    return response.json();
  };
  assert.equal((await json('/api/auth/session')).enabled, false);
  const admin = await json('/api/admin/session');
  assert.equal(admin.mode, 'local');
  assert.ok(admin.csrfToken);
  const health = await json('/api/health');
  const mutate = (url, body) =>
    json(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Platform-CSRF': health.platform.csrfToken },
      body: JSON.stringify(body),
    });
  const project = await mutate('/api/projects', {
    title: '文档烟测中文作品',
    genre: '奇幻',
    description: '',
  });
  const updated = await mutate(`/api/projects/${project.id}/chapters`, {
    number: 1,
    title: '第一章：真实原稿',
    content: canonical,
    requestId: randomUUID(),
  });
  assert.equal(updated.chapters.length, 1);
  const documents = `/api/projects/${project.id}/documents`;
  checks.push('auth OFF and loopback local administration; real CSRF project and canonical chapter writes');

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
  await page.addInitScript((id) => {
    // Init scripts run in sandboxed srcDoc iframes too; those cannot access localStorage.
    if (window.self === window.top) localStorage.setItem('novel-project', id);
  }, project.id);
  await page.goto(`${base}/chapters`);
  await page.getByRole('button', { name: '文稿格式与阅读', exact: true }).click();
  await page.getByRole('heading', { name: '文档阅读与稿件导出', exact: true }).waitFor();
  checks.push('actual production browser opens document modal through wired App action');

  const downloads = new Map();
  for (const [format, mime] of [
    ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['epub', 'application/epub+zip'],
  ]) {
    // Chromium handles attachment navigation outside normal page response events.
    // Check HTTP MIME independently, and verify the actual UI download bytes below.
    const response = await fetch(`${base}${documents}/export/${format}`);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(mime));
    await response.arrayBuffer();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: `导出 ${format.toUpperCase()}`, exact: true }).click(),
    ]);
    assert.ok(download.suggestedFilename().endsWith(`.${format}`));
    assert.equal(await download.failure(), null);
    const stream = await download.createReadStream();
    assert.ok(stream);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    assert.equal(bytes.subarray(0, 2).toString(), 'PK');
    const files = await unzip(bytes);
    const text = files.get(format === 'docx' ? 'word/document.xml' : 'EPUB/manuscript.xhtml');
    assert.ok(text?.includes('青山与远方'));
    assert.ok(text.includes('&lt;script&gt;'));
    if (format === 'epub') assert.equal(files.get('mimetype'), mime);
    else assert.ok(files.has('[Content_Types].xml'));
    downloads.set(format, bytes);
  }
  checks.push('real UI DOCX and EPUB downloads: MIME, ZIP structure, escaped Chinese canonical manuscript');

  await page.getByLabel('打开 DOCX 或 PDF', { exact: true }).setInputFiles({
    name: '中文稿件.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: downloads.get('docx'),
  });
  const word = page.frameLocator('iframe[title^="Word："]');
  await word.getByText('中文正文：青山与远方。', { exact: false }).waitFor();
  assert.equal(await word.locator('script,a,img,object,embed,iframe').count(), 0);
  assert.ok(
    (await word.locator('body').innerText()).includes('<script>window.documentSmokeExecuted = true</script>'),
  );
  assert.equal(await page.locator('iframe[title^="Word："]').getAttribute('sandbox'), '');
  assert.equal(await page.evaluate(() => window.documentSmokeExecuted), undefined);
  checks.push('UI DOCX upload and sandboxed readable Chinese preview, escaped inactive script text');

  await page.getByRole('button', { name: '准备 PDF 打印', exact: true }).click();
  const print = page.frameLocator('iframe[title="稿件专用打印预览"]');
  await print.getByText('中文正文：青山与远方。', { exact: false }).waitFor();
  assert.ok((await print.locator('body').innerText()).includes('第一章：真实原稿'));
  assert.equal(await print.locator('script').count(), 0);
  await page.locator('iframe[title="稿件专用打印预览"]').evaluate((frame) => {
    frame.contentWindow.print = () => {
      frame.dataset.smokePrinted = 'true';
    };
  });
  await page.getByRole('button', { name: '打印稿件 / 另存为 PDF', exact: true }).click();
  assert.equal(
    await page.locator('iframe[title="稿件专用打印预览"]').getAttribute('data-smoke-printed'),
    'true',
  );
  checks.push(
    'dedicated print iframe contains canonical manuscript; real button invokes intercepted iframe print without dialog',
  );

  const pdf = pdfFixture();
  await page
    .getByLabel('打开 DOCX 或 PDF', { exact: true })
    .setInputFiles({ name: 'native-reader.pdf', mimeType: 'application/pdf', buffer: pdf });
  const fallback = page.getByRole('link', { name: '用浏览器打开 PDF（内嵌阅读器不可用时）', exact: true });
  await fallback.waitFor();
  const resource = await fallback.getAttribute('href');
  assert.ok(resource?.startsWith(`${documents}/`));
  const pdfResponse = await fetch(`${base}${resource}`);
  assert.equal(pdfResponse.status, 200);
  assert.ok(pdfResponse.headers.get('content-type').startsWith('application/pdf'));
  assert.equal(pdfResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(Buffer.from(await pdfResponse.arrayBuffer()).equals(pdf));
  assert.equal(await page.locator('iframe[title="PDF：native-reader.pdf"]').getAttribute('src'), resource);
  checks.push(
    'PDF iframe and native-reader fallback wired; exact protected PDF resource verified (not native PDF rendering)',
  );

  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.getByRole('button', { name: '管理控制台', exact: true }).click();
  await page.getByRole('heading', { name: '管理控制台', exact: true }).waitFor();
  await page.getByRole('tab', { name: '备份与维护', exact: true }).click();
  const maintenance = '/api/admin/online-maintenance';
  const denied = await fetch(`${base}${maintenance}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'backup', confirmSecrets: true }),
  });
  assert.equal(denied.status, 403, 'online maintenance retains administrator CSRF guard');
  const adminPost = (url, body) =>
    json(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-CSRF': admin.csrfToken },
      body: JSON.stringify(body),
    });
  const waitTask = async (task) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      const current = await json(`${maintenance}/tasks/${task.id}`);
      if (!['queued', 'running'].includes(current.state)) {
        assert.equal(
          current.state,
          'succeeded',
          `maintenance ${current.kind}: ${current.errorCode || current.state}`,
        );
        assert.equal(current.progress, 100);
        return current;
      }
      await delay(100);
    }
    assert.fail('maintenance task exceeded thirty seconds');
  };
  // Saving prospective profiles must not activate SQL or connect them during local backup.
  // Reserve then close an ephemeral loopback port; no SQL service exists there.
  const inactiveProbe = createServer();
  inactiveProbe.listen(0, '127.0.0.1');
  await once(inactiveProbe, 'listening');
  const inactivePort = inactiveProbe.address().port;
  await new Promise((resolve) => inactiveProbe.close(resolve));
  await json('/api/admin/storage', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Admin-CSRF': admin.csrfToken },
    body: JSON.stringify({
      version: 3,
      defaultProfileId: 'inactive-unreachable',
      profiles: [
        {
          id: 'inactive-unreachable',
          label: 'Unactivated smoke profile',
          connection: {
            driver: 'postgresql',
            host: '127.0.0.1',
            port: inactivePort,
            database: 'smoke_unused',
            user: 'smoke_unused',
            tls: 'off',
            timeoutMs: 1000,
          },
        },
      ],
      ownerProfiles: [],
    }),
  });
  const inactiveStatus = await json('/api/admin/status');
  assert.equal(inactiveStatus.storage.backend, 'local-json');
  assert.equal(inactiveStatus.storage.active, false);
  assert.equal(inactiveStatus.storage.profiles.length, 1);
  const backup = await waitTask(
    await adminPost(`${maintenance}/tasks`, { kind: 'backup', confirmSecrets: true }),
  );
  assert.ok(backup.backupId);
  const validation = await waitTask(
    await adminPost(`${maintenance}/backups/${backup.backupId}/validate`, {}),
  );
  assert.equal(validation.result.validation, 'integrity-only');
  assert.ok(validation.result.fileCount > 0);
  assert.equal(validation.result.profileCount, 0, 'no real database used');
  assert.equal(validation.result.offlineRequired, true);
  assert.equal((await json('/api/auth/session')).enabled, false);
  const recovered = await json(`/api/projects/${project.id}`);
  assert.equal(recovered.chapters[0].content, canonical);
  // Force a fresh client load after quiescence drained and retired old tenant Workers.
  await page.reload();
  await page.getByRole('button', { name: '文稿格式与阅读', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  checks.push(
    'online backup and integrity validation via admin CSRF with inactive unreachable SQL profile, successful local-only snapshot, auth remains OFF',
  );
  checks.push(
    'business and canonical manuscript survive maintenance worker retirement; browser reload has no runtime errors',
  );
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks,
        limitations: [
          'PDF resource and native fallback checked; browser-native PDF visual rendering and OS print/PDF output are not claimed.',
          'Local JSON only; no real database or third-party services used.',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await stop();
  assert.equal(path.dirname(data), os.tmpdir());
  assert.ok(path.basename(data).startsWith('novel-documents-maintenance-smoke-'));
  fs.rmSync(data, { recursive: true, force: true });
}
