import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { FanqieBrowser, parseCurrentUser, reviewReceiptMatches } from './fanqie-browser.js';

function fixture(mode: 'success' | 'missing' | 'redirect' | 'failure') {
  const adapter = new FanqieBrowser();
  const payloads = [JSON.stringify({ user: { id: 'stale-id', name: 'stale' } })];
  const visits: string[] = [];
  let url = 'https://fanqienovel.com/main/writer/book-manage';
  let saves = 0;
  const page = {
    isClosed: () => false,
    url: () => url,
    bringToFront: async () => {},
    waitForTimeout: async () => {},
    goto: async (target: string) => {
      visits.push(target);
      assert.equal(payloads.length, 0, 'old response evidence must be cleared');
      if (mode === 'failure') throw new Error('navigation failure');
      url = mode === 'redirect' ? 'https://example.com/' : target;
      if (mode === 'success') payloads.push(JSON.stringify({ user: { id: 'fresh-id', name: 'Fresh author' } }));
    },
    evaluate: async (_callback: unknown, endpoint?: string) => endpoint
      ? { status: 200, body: mode === 'success'
        ? '{"code":0,"data":{"id":"fresh-id","name":"Fresh author"}}'
        : '{"code":401,"data":{"id":"stale-id","name":"stale"}}' }
      : { bodyText: '', scripts: [], globals: [], storage: payloads, links: [], accountNodes: [] },
  };
  // Inject only a test session; the production adapter still owns navigation/evidence parsing.
  Reflect.get(adapter, 'sessions').set('login', {
    browser: { isConnected: () => true }, page, pages: new Set([page]), responsePayloads: payloads,
    context: { storageState: async () => { saves++; return { cookies: [], origins: [] }; } },
  });
  return { adapter, visits, saves: () => saves };
}

test('verification navigates to author home and verifies the current-user endpoint', async () => {
  const f = fixture('success');
  const result = await f.adapter.completeLogin('login');
  assert.deepEqual(f.visits, ['https://fanqienovel.com/main/writer/home']);
  assert.deepEqual(result.account, { accountId: 'fresh-id', accountName: 'Fresh author' });
  assert.equal(f.saves(), 1);
});

test('current-user parser handles portal data scope and preserves 64-bit IDs', () => {
  assert.deepEqual(parseCurrentUser('{"code":0,"data":{"id":7123456789012345678,"name":"smkikku"}}'),
    { accountId: '7123456789012345678', accountName: 'smkikku' });
  assert.deepEqual(parseCurrentUser('{"code":0,"data":{"id":"7123456789012345678","name":"数字123与\\\"引号\\\""}}'),
    { accountId: '7123456789012345678', accountName: '数字123与"引号"' });
});

test('current-user parser rejects logged-out, malformed and unrelated identity evidence', () => {
  for (const payload of [
    '{"code":401,"data":{"id":"old-id","name":"Old author"}}',
    '{"data":{"id":"old-id","name":"Old author"}}',
    '{"code":0,"data":{"book":{"id":"book-id","name":"Book"}}}',
    '{"code":0,"data":{"id":"0","name":"Anonymous"}}',
    '{"code":0,"data":{"id":"author-id"}}',
    '<html>Login</html>', 'null',
  ]) assert.equal(parseCurrentUser(payload), undefined);
});

test('real Chromium reads same-origin user identity on login and later verification, rejects expired sessions', async () => {
  const browser = await chromium.launch({ headless: true });
  const adapter = new FanqieBrowser();
  try {
    const context = await browser.newContext();
    let loggedIn = true;
    let userReads = 0;
    await context.route('https://fanqienovel.com/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/user/info/v2') {
        userReads++;
        assert.equal(route.request().method(), 'GET');
        await route.fulfill({ contentType: 'application/json', body: loggedIn
          ? '{"code":0,"data":{"id":7123456789012345678,"name":"smkikku"}}'
          : '{"code":401,"data":{"id":"stale-id","name":"stale"}}' });
      } else {
        await route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<html><body>作者后台</body></html>' });
      }
    });
    const page = await context.newPage();
    await page.goto('https://fanqienovel.com/main/writer/home');
    Reflect.get(adapter, 'sessions').set('live', { browser, context, page });
    const result = await adapter.completeLogin('live');
    assert.equal(result.account.accountId, '7123456789012345678');
    assert.deepEqual(await adapter.verifyAccount('live', result.state), result.account);
    assert.equal(userReads, 2);
    loggedIn = false;
    await assert.rejects(adapter.completeLogin('live'), /业务码 401/);
  } finally {
    await adapter.close();
    await browser.close();
  }
});


test('review receipt requires exact known ID, title, unique item and immediate status', () => {
  const reply = (item: unknown, code = 0) => JSON.stringify({ code, data: { item_list: [item] } });
  for (const display_status of [1, 4, 5])
    assert.equal(reviewReceiptMatches(reply({ item_id: 'draft-1', title: '标题', display_status }), 'draft-1', '标题'), true);
  for (const item of [
    { item_id: 'other', title: '标题', display_status: 4 },
    { item_id: 'draft-1', title: '另一标题', display_status: 4 },
    { item_id: 'draft-1', title: '标题', display_status: 10 },
    { item_id: 'draft-1', title: '标题', display_status: '4' },
    { item_id: 'draft-1', title: '标题' },
  ]) assert.equal(reviewReceiptMatches(reply(item), 'draft-1', '标题'), false);
  assert.equal(reviewReceiptMatches('{"code":0,"data":{"item_list":[{"item_id":7123456789012345678,"title":"标题","display_status":4}]}}', '7123456789012345678', '标题'), true);
  assert.equal(reviewReceiptMatches('{"code":1,"data":{"item_list":[]}}', 'draft-1', '标题'), false);
  assert.equal(reviewReceiptMatches(JSON.stringify({ code: 0, data: { item_list: [
    { item_id: 'draft-1', title: '标题', display_status: 4 },
    { item_id: 'draft-1', title: '标题', display_status: 4 },
  ] } }), 'draft-1', '标题'), false);
  assert.equal(reviewReceiptMatches('not JSON', 'draft-1', '标题'), false);
});

test('UI review selects explicit AI and proves exact chapter-list receipt; warnings fail closed', async () => {
  const browser = await chromium.launch({ headless: true });
  const snapshot = { chapterId: 'local', number: 1, revision: 1, title: '第1章 标题', content: '正文', paragraphs: ['正文'], contentHash: 'hash' };
  try {
    for (const mode of ['success', 'ai-no', 'missing-ai', 'wrong-content', 'wrong-account', 'warning', 'timer', 'consent', 'wrong-title', 'scheduled', 'wrong-work', 'wrong-id'] as const) {
      const context = await browser.newContext();
      const page = await context.newPage();
      let finalClicks = 0;
      let selected = '';
      const adapter = new FanqieBrowser();
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        assert.equal(route.request().method(), 'GET', 'adapter must not directly issue mutation requests');
        if (url.pathname === '/api/user/info/v2') {
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, data: { id: mode === 'wrong-account' ? 'other-author' : 'author', name: '作者' } }) });
        } else if (url.pathname === '/api/author/chapter/chapter_list/v1') {
          finalClicks++;
          selected = url.searchParams.get('test_ai') || '';
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, data: { item_list: [{ item_id: mode === 'wrong-id' ? 'other' : 'draft-1', title: mode === 'wrong-title' ? '错标题' : snapshot.title, display_status: mode === 'scheduled' ? 10 : 4 }] } }) });
        } else if (url.pathname.includes('/publish/')) {
          await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<html><body>
            <div class="serial-editor-title"><div class="left-input"><input value="1"></div><div class="serial-editor-title-right"><input class="serial-editor-input-hint-area" value="标题"></div></div>
            <div class="ProseMirror" contenteditable="true">${mode === 'wrong-content' ? '变更' : '正文'}</div>
            <button class="publish-button auto-editor-next" onclick="document.querySelector('.publish-confirm-container-new').style.display='block'">下一步</button>
            <div role="dialog" class="publish-confirm-container-new" style="display:none"><h2>发布设置</h2>
              ${mode === 'warning' ? '<div class="publish-confirm-audit-alert">夜间风险</div>' : ''}
              <div class="card-content-line"><div class="card-content-line-label">是否使用AI</div><label><input type="radio" name="ai" value="1">是</label><label><input type="radio" name="ai" value="2">否</label></div>
              <div class="card-content-line"><div class="card-content-line-label">定时发布</div><button role="switch" aria-checked="${mode === 'timer'}">开关</button></div>
              ${mode === 'consent' ? '<label><input type="checkbox">我同意</label>' : ''}
              <button id="confirm" onclick="window.finalClicks=(window.finalClicks||0)+1;window.selected=document.querySelector('input[name=ai]:checked')?.value;this.closest('[role=dialog]').style.display='none';fetch('/api/author/chapter/chapter_list/v1?book_id=${mode === 'wrong-work' ? 'other' : 'book-1'}&test_ai='+window.selected)">确认发布</button>
            </div></body></html>` });
        } else {
          await route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<html><body><script type="application/json">{"bookList":[{"book_id":"book-1","title":"作品"}]}</script></body></html>' });
        }
      });
      await page.goto('https://fanqienovel.com/main/writer/book-manage');
      Reflect.get(adapter, 'sessions').set('connection', { browser, context, page });
      const run = () => adapter.submitReview('connection', { cookies: [], origins: [] }, 'author', 'book-1', 'draft-1', snapshot, mode === 'missing-ai' ? undefined : mode === 'ai-no' ? 2 : 1);
      if (mode === 'success' || mode === 'ai-no') await run();
      else await assert.rejects(run());
      const earlyFailure = ['missing-ai', 'wrong-content', 'wrong-account', 'warning', 'timer', 'consent'].includes(mode);
      assert.equal(finalClicks, earlyFailure ? 0 : 1);
      if (!earlyFailure) assert.equal(selected, mode === 'ai-no' ? '2' : '1');
      await context.close();
    }
  } finally { await browser.close(); }
});

test('draft writer uses evidenced split title and exact 存草稿; unsupported title never fills', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const title of ['第2章 正文标题', '第一章 任意标题', '第3章 序号错误']) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const adapter = new FanqieBrowser();
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/user/info/v2') {
          await route.fulfill({ contentType: 'application/json', body: '{"code":0,"data":{"id":"author","name":"Author"}}' });
        } else if (url.pathname.includes('/publish/')) {
          await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<html><body>
            <div class="serial-editor-title"><div class="left-input"><input value="1"></div><div class="serial-editor-title-right"><input class="serial-editor-input-hint-area" value="初始"></div></div>
            <div class="ProseMirror" contenteditable="true">初始正文</div>
            <button class="auto-editor-save-btn" onclick="window.saves=(window.saves||0)+1;history.replaceState({},'', '/main/writer/book-1/publish/draft-1')">存草稿</button>
            <button onclick="window.wrongSave=true">保存并发布</button></body></html>` });
        } else {
          await route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<script type="application/json">{"bookList":[{"book_id":"book-1","title":"作品"}]}</script>' });
        }
      });
      await page.goto('https://fanqienovel.com/main/writer/book-manage');
      Reflect.get(adapter, 'sessions').set('connection', { browser, context, page });
      const snapshot = { chapterId: 'local', number: 2, revision: 1, title, content: '新正文', paragraphs: ['新正文'], contentHash: 'hash' };
      let identified = '';
      const run = () => adapter.createDraft('connection', { cookies: [], origins: [] }, 'author', 'book-1', snapshot, (id) => { identified = id; });
      if (title === '第2章 正文标题') {
        assert.deepEqual(await run(), { draftId: 'draft-1' });
        assert.equal(identified, 'draft-1');
        assert.equal(await page.locator('.left-input input').inputValue(), '2');
        assert.equal(await page.locator('.serial-editor-input-hint-area').inputValue(), '正文标题');
        assert.equal(await page.locator('.ProseMirror').innerText(), '新正文');
        assert.equal(await page.evaluate(() => (window as unknown as { saves: number }).saves), 1);
      } else {
        await assert.rejects(run(), /不支持的格式不会写入编辑器/);
        assert.equal(await page.locator('.left-input input').inputValue(), '1');
        assert.equal(await page.locator('.serial-editor-input-hint-area').inputValue(), '初始');
        assert.equal(await page.locator('.ProseMirror').innerText(), '初始正文');
        assert.equal(identified, '');
      }
      assert.equal(await page.evaluate(() => (window as unknown as { wrongSave?: boolean }).wrongSave), undefined);
      await context.close();
    }
  } finally { await browser.close(); }
});

test('readDraft preserves real paragraphs, blank lines and title-in-body without CSS margin newlines', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const adapter = new FanqieBrowser();
    let markup = '';
    let status = 0;
    let reads = 0;
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      assert.equal(route.request().method(), 'GET');
      if (url.pathname === '/api/user/info/v2') return route.fulfill({ contentType: 'application/json', body: '{"code":0,"data":{"id":"author","name":"作者"}}' });
      if (url.pathname === '/api/author/edit_article/v0/') {
        reads++;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, data: { publish_status: status, item_id: 'draft-1', book_id: 'book-1' } }) });
      }
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<div class="serial-editor-title free"><div class="serial-editor-free-title"><textarea>第1章 标题</textarea></div></div><div class="ProseMirror" contenteditable="true">${markup}</div>` });
    });
    await page.goto('https://fanqienovel.com/main/writer/book-manage');
    Reflect.get(adapter, 'sessions').set('connection', { browser, context, page });
    for (const [html, expected] of [
      ['<p>第1章 标题</p><p>第一段</p><p>第二段</p>', '第1章 标题\n第一段\n第二段'],
      ['<p>第一段<strong>粗体</strong></p><p><br></p><p>第二段<br>段内换行</p>', '第一段粗体\n\n第二段\n段内换行'],
      ['第一段\n第二段', '第一段\n第二段'],
      ['<div>第一段</div><div><br></div><div>第二段</div>', '第一段\n\n第二段'],
    ]) {
      markup = html;
      const draft = await adapter.readDraft('connection', { cookies: [], origins: [] }, 'book-1', 'draft-1');
      assert.equal(draft.content, expected);
      assert.deepEqual(draft.paragraphs, expected.split('\n'));
      assert.equal(draft.publishStatus, status);
      status = 1; // Known submitted IDs must remain readable for reconciliation body proof.
    }
    assert.equal(reads, 4);
  } finally { await browser.close(); }
});

for (const mode of ['missing', 'redirect', 'failure'] as const) {
  test(`verification does not save browser state on ${mode}`, async () => {
    const f = fixture(mode);
    await assert.rejects(f.adapter.completeLogin('login'));
    assert.equal(f.visits.length, 1);
    assert.equal(f.saves(), 0);
  });
}
