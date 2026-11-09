import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Run only after the parent builds reviewed artifacts. All data and the production
// app root are disposable copies; no existing .env, credentials or browser state.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-publication-blockers-'));
const screenshots = path.join(root, 'test-results', 'publication-blockers');
const hash = 'ab'.repeat(32);
const safeBatchId = 'safe-local-unwritten';
let server;
let browser;
try {
  fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({
    name: 'novel-agent', type: 'module', workspaces: ['packages/web', 'packages/server'],
  }));
  fs.cpSync(path.join(root, 'build'), path.join(temporary, 'build'), { recursive: true });
  fs.cpSync(path.join(root, 'dist'), path.join(temporary, 'dist'), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(temporary, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const data = path.join(temporary, 'data');
  fs.mkdirSync(data);
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA'].includes(key.toUpperCase())));
  Object.assign(env, { PORT: String(port), DATA_DIR: data, NODE_ENV: 'production',
    MODEL_API_KEY: '', MODEL_SECRETS_KEY: '', PLATFORM_SECRETS_KEY: '' });
  server = spawn(process.execPath, [path.join(temporary, 'build/packages/server/src/index.js')],
    { cwd: temporary, env, stdio: 'ignore' });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { ready = (await fetch(`${base}/api/auth/session`)).ok; } catch {}
    if (ready || server.exitCode !== null) break;
    await delay(100);
  }
  assert.ok(ready, 'copied-root production server starts');
  const healthResponse = await fetch(`${base}/api/health`);
  assert.ok(healthResponse.ok);
  const health = await healthResponse.json();
  const create = async (title) => {
    const response = await fetch(`${base}/api/projects`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Platform-CSRF': health.platform.csrfToken },
      body: JSON.stringify({ title, genre: '科幻冒险', description: '隔离删除诊断验收，不连接真实平台。' }) });
    assert.ok(response.ok, 'create disposable project');
    return response.json();
  };
  const list = async () => {
    const response = await fetch(`${base}/api/projects`);
    assert.ok(response.ok);
    return response.json();
  };
  fs.mkdirSync(screenshots, { recursive: true });
  browser = await chromium.launch({ headless: true });
  for (const locale of ['zh-CN', 'en']) {
    const current = await create(`星海 Current ${locale}`);
    const other = await create(`长安 Other ${locale}`);
    const safe = await create(`山野 Safe ${locale}`);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 },
      reducedMotion: 'reduce', serviceWorkers: 'block' });
    let failurePage;
    try {
      const page = await context.newPage();
      failurePage = page;
      page.setDefaultTimeout(20000);
      const errors = [];
      const forbidden = [];
      const events = [];
      let cancelled = false;
      let permittedDelete;
      let retainedDeletePermit;
      const retainedDeletes = [];
      const diagnosticOverrides = new Map();
      const diagnostic = (id) => id === safe.id ? {
        removable: cancelled, busy: false,
        batches: cancelled ? [] : [{ id: safeBatchId, state: 'failed', approvalHash: hash,
          canCancel: true, errorCode: 'PLATFORM_ACCOUNT_MISMATCH', failureStage: 'validate',
          items: [{ number: 31, state: 'queued', mutationStarted: false, hasRemoteDraftId: false }] }],
        legacyOperations: [],
      } : {
        removable: false, busy: false, canDeletePreservingRecords: true,
        ...diagnosticOverrides.get(id),
        batches: [{ id: `unknown-${id}`, state: 'unknown', approvalHash: hash, canCancel: false,
          errorCode: 'PLATFORM_PAGE_LOAD_FAILED', failureStage: 'execute', items: [
            { number: 11, state: 'unknown', mutationStarted: true, hasRemoteDraftId: false },
            { number: 12, state: 'queued', mutationStarted: false, hasRemoteDraftId: false },
          ] }], legacyOperations: [{ id: 'legacy-unknown-local', state: 'unknown' }],
      };
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
      // Record attempts before interception, so even an aborted destructive request fails.
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.origin === base && url.pathname.startsWith('/api/'))
          events.push({ method: request.method(), path: url.pathname });
      });
      await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const pathname = url.pathname;
        const method = request.method();
        const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
        if (url.origin !== base) {
          if (['data:', 'blob:'].includes(url.protocol)) return route.continue();
          if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(request.url()))
            return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
          forbidden.push(`${method} external ${url.origin}${pathname}`);
          return route.abort();
        }
        const blocked = pathname.match(/^\/api\/projects\/([^/]+)\/platform-deletion-blockers$/);
        if (blocked && method === 'GET' && [current.id, other.id, safe.id].includes(decodeURIComponent(blocked[1])))
          return json(diagnostic(decodeURIComponent(blocked[1])));
        const cancelPath = `/api/projects/${safe.id}/platform-publication-batches/${safeBatchId}/cancel`;
        if (pathname === cancelPath && method === 'POST' && !cancelled) {
          assert.deepEqual(request.postDataJSON(), { confirmed: true, approvalHash: hash },
            'safe cancellation uses exact immutable approval hash and explicit confirmation');
          cancelled = true;
          return json({ id: safeBatchId, state: 'cancelled' });
        }
        // Results navigation may load only these local, credential-free records.
        // They are mocked as well: no platform API request reaches the server.
        if (method === 'GET' && pathname === '/api/platforms/session')
          return json({ available: true, csrfToken: health.platform.csrfToken, persistentCredentials: false });
        if (method === 'GET' && pathname === '/api/platforms/providers') return json([]);
        if (method === 'GET' && /^\/api\/projects\/[^/]+\/(platform-connections|platform-links|platform-chapters|platform-operations|platform-draft-receipts|platform-publication-batches)$/.test(pathname))
          return json([]);
        if (pathname.startsWith('/api/') && (/\/platform/.test(pathname) || !['GET', 'HEAD'].includes(method))) {
          if (method === 'DELETE' && pathname === `/api/projects/${retainedDeletePermit}`) {
            assert.deepEqual(request.postDataJSON(), { confirmed: true, preservePlatformRecords: true },
              'retained deletion sends only the exact explicitly confirmed preservation body');
            assert.ok(!retainedDeletes.some((entry) => entry.path === pathname), 'one retained DELETE per confirmation');
            retainedDeletePermit = undefined; // One-use permission, never a general DELETE allow-list.
            retainedDeletes.push({ method, path: pathname, body: request.postDataJSON() });
            // Only diagnostics contain mocked unknowns. The disposable backend project
            // has no actual platform records, so this checks the real DELETE/Project[] route.
            const response = await route.fetch();
            assert.ok(response.ok(), 'isolated backend accepts explicitly confirmed preservation body');
            const projects = await response.json();
            assert.ok(Array.isArray(projects), 'retained DELETE returns Project[]');
            assert.ok(!projects.some((project) => project.id === decodeURIComponent(pathname.split('/').at(-1))),
              'retained DELETE response excludes the deleted local project');
            return route.fulfill({ response });
          }
          if (method === 'DELETE' && pathname === `/api/projects/${permittedDelete}`) return route.continue();
          forbidden.push(`${method} ${pathname}`);
          return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Smoke forbids this request' }) });
        }
        return route.continue();
      });
      await page.addInitScript(({ id, language }) => {
        localStorage.setItem('novel-project', id);
        localStorage.setItem('novel-theme', 'mtf');
        localStorage.setItem('novel-locale', language);
      }, { id: current.id, language: locale });
      const english = locale === 'en';
      const labels = {
        heading: english ? /^All projects/ : /^全部作品/,
        remove: (title) => `${english ? 'Delete project: ' : '删除作品：'}${title}`,
        blocker: english ? 'Platform records block project deletion' : '作品删除被平台记录阻止',
        refresh: /刷新删除诊断|Refresh deletion diagnostic/i,
        results: /打开该作品的平台结果|Open.*platform results/i,
        cancel: english ? 'Safely cancel unstarted batch' : '安全取消未写入批次',
        retry: /再次尝试删除作品|Try deleting.*again|Retry project deletion/i,
        retainDelete: english ? 'Keep platform records and delete local project' : '保留平台记录并删除本地作品',
      };
      const modal = page.getByRole('dialog', { name: labels.blocker });
      const confirmation = page.getByRole('alertdialog');
      const confirm = async () => {
        await confirmation.waitFor();
        await confirmation.getByRole('button', { name: /^(确定|确认|删除|Confirm|Delete)$/ }).click();
      };
      const openBlocked = async (target) => {
        await page.getByRole('button', { name: labels.remove(target.title), exact: true }).click();
        await confirm();
        await modal.waitFor();
        assert.ok((await modal.innerText()).includes(target.title), 'dialog preserves exact user title');
        await modal.getByRole('button', { name: labels.refresh }).waitFor();
      };
      const noDelete = () => assert.equal(events.filter((event) => event.method === 'DELETE').length, 0,
        'unknown and cancellation must never DELETE project');
      const setMobileViewport = async () => {
        await page.setViewportSize({ width: 390, height: 900 });
        // Resize completion (even two rAFs) can precede responsive style updates:
        // wait for the actual mobile breakpoint and removal of the desktop 208px
        // main offset before measuring. This never waits away real content overflow.
        await page.waitForFunction(() => {
          const main = document.querySelector('.main');
          return innerWidth === 390 && matchMedia('(max-width: 1000px)').matches &&
            main !== null && getComputedStyle(main).marginLeft === '0px';
        }, undefined, { polling: 'raf' });
      };
      const logOverflow = async () => {
        const offenders = await page.evaluate(() => Array.from(document.querySelectorAll('body *')).filter(element => !element.closest('.sidebar'))
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return { tag: element.tagName, className: element.getAttribute('class'),
              text: element.textContent?.trim().slice(0, 120),
              x: rect.x, right: rect.right, width: rect.width, viewport: innerWidth,
              parent: element.parentElement?.className, parentLayout: element.parentElement ? { display:getComputedStyle(element.parentElement).display, direction:getComputedStyle(element.parentElement).flexDirection, columns:getComputedStyle(element.parentElement).gridTemplateColumns, width:element.parentElement.getBoundingClientRect().width, x:element.parentElement.getBoundingClientRect().x } : null, position: getComputedStyle(element).position,
              transform: getComputedStyle(element).transform, margin: getComputedStyle(element).margin,
              display: getComputedStyle(element).display, align: getComputedStyle(element).alignItems };
          })
          .filter((item) => item.width > 0 && (item.x < -1 || item.right > item.viewport + 1 || item.width > item.viewport + 1))
          .slice(0, 12));
        if (offenders.length) {
          console.error(`Overflow elements ${locale}:`, JSON.stringify(offenders));
          console.error('Layout ancestors:', await page.locator('.projects-library__heading').evaluate(el => { const a=[]; for(let e=el;e;e=e.parentElement) {const r=e.getBoundingClientRect(),s=getComputedStyle(e);a.push({tag:e.tagName,cls:e.className,x:r.x,w:r.width,display:s.display,margin:s.margin,padding:s.padding,columns:s.gridTemplateColumns});}return a;}));
        }
      };
      await page.goto(`${base}/projects`);
      await page.getByRole('heading', { name: labels.heading }).waitFor();
      for (const target of [other, current]) {
        const before = events.length;
        await openBlocked(target);
        assert.ok(events.slice(before).some((event) => event.method === 'GET' && event.path === `/api/projects/${target.id}/platform-deletion-blockers`));
        const text = await modal.innerText();
        assert.match(text, /11.*unknown/i, 'unknown chapter listed');
        assert.match(text, /12.*queued/i, 'remaining queued chapter listed');
        assert.match(text, /缺少准确远端 ID|Exact remote ID missing/i, 'missing remote chapter ID explained');
        assert.ok(text.includes('legacy-unknown-local'), 'legacy unknown operation retained');
        assert.equal(await modal.getByRole('button', { name: labels.cancel }).count(), 0, 'server canCancel=false exposes no cancellation');
        assert.equal(await modal.getByRole('button', { name: labels.retry }).isDisabled(), true);
        const refreshCount = events.filter((event) => event.path.endsWith('/platform-deletion-blockers')).length;
        await Promise.all([
          page.waitForResponse((response) => response.url() === `${base}/api/projects/${target.id}/platform-deletion-blockers` && response.request().method() === 'GET'),
          modal.getByRole('button', { name: labels.refresh }).click(),
        ]);
        await modal.getByRole('heading', { name: new RegExp(`unknown-${target.id}`) }).waitFor();
        await page.waitForFunction(() => document.querySelector('.project-deletion-blockers')?.getAttribute('aria-busy') === 'false');
        assert.ok(events.filter((event) => event.path.endsWith('/platform-deletion-blockers')).length > refreshCount);
        await setMobileViewport();
        await logOverflow();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '390px page has no horizontal overflow');
        assert.ok(await modal.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), '390px blocker modal has no horizontal overflow');
        await page.screenshot({ path: path.join(screenshots, `${locale}-${target.id === current.id ? 'current' : 'noncurrent'}-unknown-390.png`), fullPage: true });
        noDelete();
        assert.equal(cancelled, false);
        assert.equal(await page.evaluate(() => localStorage.getItem('novel-project')), current.id, 'diagnostic never changes selection');
        await modal.getByRole('button', { name: labels.results }).click();
        await modal.waitFor({ state: 'detached' });
        await page.waitForURL(`${base}/platforms/tomato`);
        await page.locator('.platform-step-button[aria-current="step"]').filter({ hasText: /核对结果|Check results|Verify results/ }).waitFor();
        await page.waitForFunction((id) => localStorage.getItem('novel-project') === id, target.id);
        noDelete();
        // Restore the chosen active fixture only between scenarios, not during a diagnostic.
        await page.goto(`${base}/projects`);
        await page.getByRole('heading', { name: labels.heading }).waitFor();
        await page.setViewportSize({ width: 1440, height: 1050 });
      }
      await openBlocked(safe);
      assert.equal(await modal.getByRole('button', { name: labels.cancel }).count(), 1, 'only server-approved unwritten batch can be cancelled');
      await modal.getByRole('button', { name: labels.cancel }).click();
      await confirmation.waitFor();
      await confirmation.getByRole('button', { name: /^(取消|Cancel)$/ }).click();
      assert.equal(cancelled, false, 'cancel confirmation dismissal makes no request');
      await modal.getByRole('button', { name: labels.cancel }).click();
      await confirm();
      await page.waitForFunction(() => {
        const button = document.querySelector('.project-deletion-blockers__actions .danger');
        return button && !button.disabled;
      });
      assert.equal(cancelled, true);
      noDelete();
      const cancelIndex = events.findIndex((event) => event.method === 'POST');
      assert.ok(cancelIndex >= 0);
      assert.ok(events.slice(cancelIndex + 1).some((event) => event.method === 'GET' && event.path === `/api/projects/${safe.id}/platform-deletion-blockers`), 'safe cancellation refreshes diagnostic');
      assert.equal(events.filter((event) => event.method === 'POST').length, 1, 'exactly one mocked cancel POST; no clear/start/reconcile');
      assert.ok((await list()).some((project) => project.id === safe.id), 'removable diagnostic does not auto-delete fixture');
      await setMobileViewport();
      await logOverflow();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: path.join(screenshots, `${locale}-safe-removable-390.png`), fullPage: true });
      // Only a fresh explicit action and a second confirmation may delete the project.
      permittedDelete = safe.id;
      const beforeRetry = events.length;
      await modal.getByRole('button', { name: labels.retry }).click();
      await confirmation.waitFor();
      noDelete();
      assert.ok((await confirmation.innerText()).includes(safe.title));
      await confirm();
      await page.getByRole('button', { name: labels.remove(safe.title), exact: true }).waitFor({ state: 'detached' });
      assert.deepEqual(events.filter((event) => event.method === 'DELETE'), [{ method: 'DELETE', path: `/api/projects/${safe.id}` }]);
      const retryEvents = events.slice(beforeRetry);
      assert.ok(retryEvents.findIndex((event) => event.path.endsWith('/platform-deletion-blockers')) < retryEvents.findIndex((event) => event.method === 'DELETE'), 'fresh diagnostic precedes explicit deletion');
      const projects = await list();
      assert.ok(!projects.some((project) => project.id === safe.id));
      for (const target of [current, other]) {
        assert.ok(projects.some((project) => project.id === target.id && project.title === target.title));
        assert.ok((await page.locator('.projects-library').innerText()).includes(target.title), 'locale preserves user-owned title');
      }
      // The old protection scenarios above still prohibit every DELETE until their
      // fresh explicit confirmation. Retained deletion is a separate opt-in below.
      permittedDelete = undefined;
      await page.setViewportSize({ width: 1440, height: 1050 });
      const retainedAction = () => modal.getByRole('button', { name: labels.retainDelete, exact: true });
      const closeBlocked = async () => {
        await page.keyboard.press('Escape');
        await modal.waitFor({ state: 'detached' });
      };
      const mutations = () => events.filter((event) => !['GET', 'HEAD'].includes(event.method));
      for (const override of [
        { busy: false, canDeletePreservingRecords: undefined },
        { busy: true, canDeletePreservingRecords: true },
      ]) {
        diagnosticOverrides.set(other.id, override);
        const before = mutations().length;
        await openBlocked(other);
        assert.ok(await retainedAction().count() === 0 || await retainedAction().isDisabled(),
          'missing optional capability or busy diagnostic fails closed for retained deletion');
        assert.equal(mutations().length, before, 'ineligible diagnostic makes no write');
        await closeBlocked();
      }
      diagnosticOverrides.clear();
      for (const target of [other, current]) {
        await openBlocked(target);
        assert.equal(await retainedAction().isEnabled(), true, 'explicit server capability enables retained-delete action');
        if (target.id === other.id) {
          await setMobileViewport();
          await page.locator('.toast').waitFor({ state: 'detached' });
          await logOverflow();
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
            '390px page with retained-delete action has no horizontal overflow');
          assert.ok(await modal.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
            '390px blocker modal with long retained-delete action has no horizontal overflow');
          await page.screenshot({ path: path.join(screenshots, `${locale}-retained-delete-390.png`), fullPage: true });
        }
        // Keep the narrow viewport for both targets and their opt-in confirmations.
        const selectionBefore = await page.evaluate(() => localStorage.getItem('novel-project'));
        assert.equal(selectionBefore, current.id, 'retained-delete scenario starts with original current project');
        const before = mutations().length;
        await retainedAction().click();
        await confirmation.waitFor();
        assert.ok((await confirmation.innerText()).includes(target.title), 'retention confirmation names exact project');
        assert.equal(mutations().length, before, 'opening fresh retained-delete confirmation does not write');
        await confirmation.getByRole('button', { name: /^(取消|Cancel)$/ }).click();
        await confirmation.waitFor({ state: 'detached' });
        assert.equal(mutations().length, before, 'cancelled retained-delete confirmation makes no write');
        assert.ok((await list()).some((project) => project.id === target.id), 'cancel retains local project');
        assert.equal(await page.evaluate(() => localStorage.getItem('novel-project')), selectionBefore,
          'cancelled retained deletion preserves current selection');
        await retainedAction().click();
        await confirmation.waitFor();
        assert.equal(mutations().length, before, 'new explicit confirmation is required before DELETE');
        retainedDeletePermit = target.id;
        await confirmation.getByRole('button', { name: labels.retainDelete, exact: true }).click();
        await confirmation.waitFor({ state: 'detached' });
        await modal.waitFor({ state: 'detached' });
        await page.getByRole('button', { name: labels.remove(target.title), exact: true }).waitFor({ state: 'detached' });
        assert.deepEqual(mutations().slice(before), [{ method: 'DELETE', path: `/api/projects/${target.id}` }],
          'accepted retained-delete confirmation makes exactly one DELETE and no other write');
        assert.deepEqual(retainedDeletes.at(-1), { method: 'DELETE', path: `/api/projects/${target.id}`,
          body: { confirmed: true, preservePlatformRecords: true } });
        assert.equal(retainedDeletePermit, undefined, 'accepted DELETE consumes its one-use permission');
        assert.ok(!(await list()).some((project) => project.id === target.id), 'only explicitly selected local fixture is deleted');
        if (target.id === other.id) {
          assert.equal(await page.evaluate(() => localStorage.getItem('novel-project')), current.id,
            'retained deletion of noncurrent project preserves current selection');
          assert.ok((await list()).some((project) => project.id === current.id && project.title === current.title),
            'noncurrent retained deletion preserves current project');
        }
      }
      assert.equal(retainedDeletes.length, 2, 'one explicitly confirmed retained DELETE for each current/noncurrent fixture');
      assert.deepEqual(forbidden, [], 'no remote platform GET, platform write, clear or unexpected mutation attempted');
      const optionalFontWarnings = errors.filter((message) => message.includes('https://fonts.googleapis.com/css2?') && message.includes('Content Security Policy') && message.includes('stylesheet'));
      assert.deepEqual(errors.filter((message) => !optionalFontWarnings.includes(message)), [], 'no browser runtime or unexpected console errors');
      console.log(`PASS ${locale}: current/noncurrent unknown blocks DELETE/cancel/clear; missing ID + queued + legacy records; refresh and target results navigation; confirmed exact-hash mock cancel; removable never auto-deletes; fresh explicit deletion; retained-delete missing capability/busy fail closed, cancelled confirmation no write, exact-body one-use DELETE returns Project[] for current/noncurrent, noncurrent preserves selection; unchanged user titles; 390px screenshots/overflow; no remote requests/runtime errors.`);
    } catch (error) {
      if (failurePage && !failurePage.isClosed()) {
        const screenshot = path.join(screenshots, `${locale}-failure.png`);
        try {
          await failurePage.screenshot({ path: screenshot, fullPage: true });
          console.error(`Failure screenshot: ${screenshot}`);
          console.error('Failure UI state:', JSON.stringify(await failurePage.evaluate(() => ({
            pathname: location.pathname,
            activeSteps: Array.from(document.querySelectorAll('.platform-step-button[aria-current="step"]'),
              (element) => element.textContent),
            modalTitles: Array.from(document.querySelectorAll('[role="dialog"] h2'),
              (element) => element.textContent),
          }))));
        } catch (captureError) {
          console.error('Failure screenshot capture failed:', captureError.message);
        }
      }
      throw error;
    } finally { await context.close(); }
  }
  console.log(`Screenshots: ${screenshots}`);
} finally {
  try { if (browser) await browser.close(); }
  finally {
    try {
      if (server && server.exitCode === null) {
        const exited = once(server, 'exit');
        server.kill();
        await exited;
      }
    } finally {
      // Exact OS-temporary directory created above, never the repository's data.
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}
