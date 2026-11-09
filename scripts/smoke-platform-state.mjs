import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

// Component-level production bundle; all APIs are intercepted fixtures. No backend,
// user DATA_DIR, real browser profile, credentials, or remote platform is opened.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(root, '.tmp-build/platform-state-'));
let browser;
let server;
try {
  const component = path.join(root, 'packages/web/src/components/platforms/PlatformPanel.tsx').replaceAll('\\', '/');
  fs.writeFileSync(path.join(temporary, 'index.html'), '<div id="root"></div><script type="module" src="/entry.tsx"></script>');
  fs.writeFileSync(path.join(temporary, 'entry.tsx'), `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import PlatformPanel from ${JSON.stringify(component)};function Harness(){const[platform,setPlatform]=useState('tomato');const[project,setProject]=useState('fixture');return <><button onClick={()=>setProject(project==='fixture'?'second':'fixture')}>Switch project fixture</button><PlatformPanel projectId={project} running={false} selectedPlatform={platform} onSelectPlatform={setPlatform} onBackToPlatforms={()=>setPlatform(null)}/></>};createRoot(document.getElementById('root')).render(<Harness/>);`);
  await build({ configFile: false, root: temporary, plugins: [react()], logLevel: 'warn', build: { outDir: path.join(temporary, 'output'), emptyOutDir: true } });
  server = createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    const target = path.join(temporary, 'output', name === '/' ? 'index.html' : name);
    if (!target.startsWith(path.join(temporary, 'output')) || !fs.existsSync(target)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', target.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(fs.readFileSync(target));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  const calls = [];
  page.on('pageerror', error => errors.push(error.message));
  const now = new Date().toISOString();
  const capabilities = Object.fromEntries(['manualLogin', 'listWorks', 'syncWork', 'saveDraft'].map(key => [key, true]));
  let operations = [];
  let receipts = [];
  let links = [];
  let connections = [{ id: 'account', providerId: 'tomato', accountId: 'author', accountName: 'Fixture account', status: 'connected', hasCredential: true, capabilities, projectId: 'fixture', createdAt: now }];
  const snapshot = { chapterId: 'chapter', number: 1, revision: 1, title: 'Fixture chapter', content: 'Offline text', paragraphs: ['Offline text'], contentHash: 'fixture-hash' };
  const target = { projectId: 'fixture', connectionId: 'account', providerId: 'tomato', accountId: 'author', accountName: 'Fixture account', linkId: 'link', remoteWorkId: 'work', workTitle: 'Fixture work', workRevision: '1' };
  let batches = [{ id: 'batch', state: 'failed', items: [{ id: 'item', snapshot, state: 'failed', mutationStarted: false }], preview: { id: 'preview', target, action: 'save_draft', chapters: [snapshot], createdAt: now, hash: 'hash' }, startRequestIds: [], pauseRequested: false, createdAt: now, updatedAt: now, error: 'OLD OFFLINE QUEUE ERROR' }];
  let failWork;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, base, 'no external network');
    if (!url.pathname.startsWith('/api/')) return route.continue();
    calls.push(`${route.request().method()} ${url.pathname}`);
    assert.equal(route.request().method(), 'GET', 'automatic synchronization must not mutate');
    const endpoint = url.pathname.split('/').at(-1);
    let body;
    if (url.pathname === '/api/platforms/session') body = { csrfToken: 'fixture', available: true, persistentCredentials: false, legacyArchived: false };
    else if (endpoint === 'providers') body = [{ id: 'tomato', name: '番茄测试平台', available: true, capabilities, readiness: 'mock', description: 'Offline fixture' }];
    else if (endpoint === 'platform-connections') body = connections;
    else if (endpoint === 'platform-links') body = links;
    else if (endpoint === 'platform-chapters') body = [{ id: 'chapter', number: 1, title: 'Fixture chapter', revision: 1, contentHash: 'fixture-hash', updatedAt: now }];
    else if (endpoint === 'platform-operations') body = operations;
    else if (endpoint === 'platform-draft-receipts') body = receipts;
    else if (endpoint === 'platform-publication-batches') body = batches;
    // Local diagnostic added to results refresh: exact fixture paths, still GET-only
    // above, and fulfilled here rather than falling through to any platform/server.
    else if (/^\/api\/projects\/(fixture|second)\/platform-deletion-blockers$/.test(url.pathname)) body = {
      removable: false, busy: false,
      batches: batches.map(batch => ({ id: batch.id, state: batch.state,
        approvalHash: batch.preview.hash, canCancel: false,
        items: batch.items.map(item => ({ number: item.snapshot.number, state: item.state,
          mutationStarted: item.mutationStarted, hasRemoteDraftId: Boolean(item.remoteDraftId) })) })),
      legacyOperations: [],
    };
    else if (endpoint === 'platform-extension-pairings' || endpoint === 'volumes') body = [];
    else if (endpoint === 'platform-works') {
      await new Promise(resolve => { failWork = resolve; });
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'STALE WORK NOT FOUND' }) });
    } else throw new Error(`unexpected API ${url.pathname}`);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(base);
  await page.getByText('Fixture account', { exact: true }).waitFor();
  await page.getByRole('button', { name: /核对结果/ }).click();
  await page.getByText('OLD OFFLINE QUEUE ERROR', { exact: true }).waitFor();
  operations = [{ id: 'operation', ...target, chapterId: 'chapter', chapterNumber: 1, revision: 1, contentHash: 'fixture-hash', title: 'Externally added draft', state: 'verified', mutationStarted: true, remoteDraftId: 'remote-draft', createdAt: now, updatedAt: now }];
  receipts = [{ id: 'receipt', operationId: 'operation', ...target, chapterId: 'chapter', revision: 1, contentHash: 'fixture-hash', remoteDraftId: 'remote-draft', title: 'Externally added draft', verifiedAt: now }];
  batches = [{ ...batches[0], state: 'unknown', error: 'EXTERNAL QUEUE UPDATE', items: [{ ...batches[0].items[0], state: 'unknown', mutationStarted: true, remoteDraftId: 'remote-queue', reconciliation: { checkedAt: now, outcome: 'unproven' } }] }];
  await page.getByText('Externally added draft', { exact: false }).waitFor({ timeout: 12000 });
  await page.getByText('EXTERNAL QUEUE UPDATE', { exact: true }).waitFor({ timeout: 12000 });
  await page.getByText(/只读核验：未证实，保持未知且不重发/).waitFor();
  await page.getByText(/草稿已核实（非发布）/).waitFor();
  assert.equal(calls.some(call => /platform-works|\/sync|\/reconcile/.test(call)), false);
  await page.getByRole('button', { name: /绑定作品/ }).click();
  await page.getByRole('combobox').first().selectOption('account');
  links = [{ id: 'link', ...target, title: 'Externally bound work', revision: '1', lastSyncedAt: now }];
  await page.getByRole('option', { name: /Externally bound work/ }).waitFor({ state: 'attached', timeout: 12000 });
  await page.getByLabel('本次操作的目标作品').selectOption('link:link');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForResponse(response => response.url().endsWith('/platform-draft-receipts'));
  assert.equal(await page.getByRole('combobox').first().inputValue(), 'account');
  assert.equal(await page.getByLabel('本次操作的目标作品').inputValue(), 'link:link');
  const remoteReadsBeforeFocus = calls.filter(call => /platform-works|\/volumes|\/sync|\/reconcile/.test(call)).length;
  const focusRead = page.waitForResponse(response => response.url().endsWith('/platform-draft-receipts'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await focusRead;
  assert.equal(calls.filter(call => /platform-works|\/volumes|\/sync|\/reconcile/.test(call)).length, remoteReadsBeforeFocus, 'background refresh never repeats remote reads');
  await page.getByRole('button', { name: '只读读取作品', exact: true }).click();
  await page.getByRole('button', { name: '← 返回平台作品' }).click();
  await page.getByRole('button', { name: /进入平台/ }).click();
  assert.ok(failWork, 'delayed work read started');
  failWork();
  await page.getByText('Fixture account', { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.platform-loading'));
  assert.equal(await page.getByText(/STALE WORK NOT FOUND/).count(), 0, 'old selection failures cannot replace current UI');
  assert.deepEqual(errors, []);
  console.log('PASS offline open-page synchronization: external draft/receipt/link/queue, preserved selections, stale selection error, GET-only automatic reads');
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  fs.rmSync(temporary, { recursive: true, force: true });
}
