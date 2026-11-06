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
  let closed = false;
  let connected = true;
  let closes = 0;
  let closeOnNavigation = false;
  const page = {
    isClosed: () => closed,
    url: () => url,
    bringToFront: async () => {},
    waitForTimeout: async () => {},
    goto: async (target: string) => {
      visits.push(target);
      assert.equal(payloads.length, 0, 'old response evidence must be cleared');
      if (closeOnNavigation) { closed = true; throw new Error('page closed'); }
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
    browser: { isConnected: () => connected, close: async () => { closes++; connected = false; } },
    page, pages: new Set([page]), responsePayloads: payloads,
    context: { storageState: async () => { saves++; return { cookies: [], origins: [] }; } },
  });
  return {
    adapter, page, payloads, visits, saves: () => saves, closes: () => closes,
    closePage: () => { closed = true; }, disconnect: () => { connected = false; },
    closeDuringNavigation: () => { closeOnNavigation = true; },
  };
}

test('verification navigates to author home and verifies the current-user endpoint', async () => {
  const f = fixture('success');
  const result = await f.adapter.completeLogin('login');
  assert.deepEqual(f.visits, ['https://fanqienovel.com/main/writer/home']);
  assert.deepEqual(result.account, { accountId: 'fresh-id', accountName: 'Fresh author' });
  assert.equal(f.saves(), 1);
});

test('retaining a verified login transfers the live browser without closing it', async () => {
  const f = fixture('success');
  const sessions = Reflect.get(f.adapter, 'sessions');
  const session = sessions.get('login');
  await f.adapter.completeLogin('login');
  await f.adapter.retainLogin('login', 'connection');
  assert.equal(sessions.has('login'), false);
  assert.equal(sessions.get('connection'), session);
  assert.equal(session.page, f.page);
  assert.equal(session.pages, undefined, 'retained contexts must no longer block manual login');
  assert.equal(f.adapter.loginOpen('connection'), true);
  await f.adapter.closeLogin('login');
  assert.equal(f.closes(), 0, 'old login cleanup must not close the retained browser');
  await f.adapter.closeConnection('connection');
  assert.equal(f.closes(), 1);
});

test('manual login transfers only the selected live verified session and preserves evidence and tombstone', async (t) => {
  const f = fixture('success');
  await f.adapter.completeLogin('login');
  await f.adapter.retainLogin('login', 'connection');
  const sessions = Reflect.get(f.adapter, 'sessions');
  const session = sessions.get('connection');
  const payloads = session.responsePayloads;
  t.mock.method(chromium, 'launch', async () => { throw new Error('must not launch'); });
  await f.adapter.startLogin('relogin', 'connection');
  assert.equal(sessions.has('connection'), false);
  assert.equal(sessions.get('relogin'), session);
  assert.deepEqual([...session.pages], [f.page]);
  assert.equal(session.responsePayloads, payloads);
  assert.equal(f.saves(), 1, 'transfer must not capture or restore secrets');
  assert.equal(f.visits.length, 1, 'transfer must not navigate');
  await assert.rejects(f.adapter.verifyAccount('connection', { cookies: [], origins: [] }), { code: 'PLATFORM_LOGIN_CLOSED' });
  assert.deepEqual((await f.adapter.completeLogin('relogin')).account, { accountId: 'fresh-id', accountName: 'Fresh author' });
  await f.adapter.retainLogin('relogin', 'connection');
  assert.equal(sessions.get('connection'), session);
  assert.equal(session.pages, undefined);
  assert.equal(f.closes(), 0);
});

test('manual login refuses target collisions without losing either session', async (t) => {
  const f = fixture('success');
  await f.adapter.retainLogin('login', 'connection');
  const sessions = Reflect.get(f.adapter, 'sessions');
  const session = sessions.get('connection');
  const target = { other: true };
  sessions.set('target', target);
  t.mock.method(chromium, 'launch', async () => { throw new Error('must not launch'); });
  await assert.rejects(f.adapter.startLogin('target', 'connection'), { code: 'PLATFORM_BUSY' });
  assert.equal(sessions.get('target'), target);
  assert.equal(sessions.get('connection'), session);
  assert.equal(session.pages, undefined);
  assert.equal(f.closes(), 0);
});

test('closed retained windows fall back to a new isolated manual login, never restored state', async (t) => {
  let launches = 0;
  const page = { on: () => {}, goto: async () => {}, bringToFront: async () => {}, isClosed: () => false };
  const context = {
    setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {}, route: async () => {},
    newPage: async () => page, on: () => {},
  };
  const browser = { newContext: async (options: unknown) => {
    assert.deepEqual(options, { acceptDownloads: false, serviceWorkers: 'block' });
    return context;
  } };
  t.mock.method(chromium, 'launch', async (options: Parameters<typeof chromium.launch>[0]) => {
    assert.deepEqual(options, { headless: false });
    launches++;
    return browser;
  });
  for (const action of ['closePage', 'disconnect'] as const) {
    const f = fixture('success');
    await f.adapter.retainLogin('login', 'connection');
    f[action]();
    await f.adapter.startLogin('relogin', 'connection');
    const session = Reflect.get(f.adapter, 'sessions').get('relogin');
    assert.equal(session.browser, browser);
    assert.equal(session.context, context);
    assert.deepEqual([...session.pages], [page]);
    assert.equal(f.closes(), 0);
    assert.equal(Reflect.get(f.adapter, 'retainedConnections').has('connection'), true);
  }
  assert.equal(launches, 2);
});

test('verification retains the selected allowed popup rather than the previous page', async () => {
  const f = fixture('success');
  const session = Reflect.get(f.adapter, 'sessions').get('login');
  session.page = { isClosed: () => false, url: () => 'https://example.com/' };
  session.pages.add(session.page);
  await f.adapter.completeLogin('login');
  await f.adapter.retainLogin('login', 'connection');
  assert.equal(session.page, f.page);
});

test('retention rejects closed logins and refuses to overwrite another live connection', async () => {
  for (const action of ['closePage', 'disconnect'] as const) {
    const f = fixture('success');
    f[action]();
    await assert.rejects(f.adapter.retainLogin('login', 'connection'), { code: 'PLATFORM_LOGIN_CLOSED' });
    assert.equal(Reflect.get(f.adapter, 'sessions').has('connection'), false);
    assert.equal(f.closes(), 0);
  }
  const f = fixture('success');
  const sessions = Reflect.get(f.adapter, 'sessions');
  const existing = { other: true };
  sessions.set('connection', existing);
  await assert.rejects(f.adapter.retainLogin('login', 'connection'), { code: 'PLATFORM_BUSY' });
  assert.equal(sessions.get('connection'), existing);
  assert.equal(sessions.has('login'), true);
  await assert.rejects(f.adapter.retainLogin('missing', 'new'), { code: 'PLATFORM_LOGIN_CLOSED' });
});

test('closed retained connections reject business reads before timer and after cleanup until fresh retain', async () => {
  for (const close of ['closePage', 'disconnect'] as const) {
    const f = fixture('success');
    await f.adapter.retainLogin('login', 'connection');
    f[close]();
    const state = { cookies: [], origins: [] };
    for (const read of [() => f.adapter.verifyAccount('connection', state), () => f.adapter.listWorks('connection', state)])
      await assert.rejects(read(), { code: 'PLATFORM_LOGIN_CLOSED' });
    await f.adapter.closeConnection('connection');
    for (const read of [() => f.adapter.verifyAccount('connection', state), () => f.adapter.listWorks('connection', state)])
      await assert.rejects(read(), { code: 'PLATFORM_LOGIN_CLOSED' });
    assert.equal(f.visits.length, 0);
    const fresh = fixture('success');
    Reflect.get(f.adapter, 'sessions').set('new-login', Reflect.get(fresh.adapter, 'sessions').get('login'));
    await f.adapter.retainLogin('new-login', 'connection');
    assert.deepEqual(await f.adapter.verifyAccount('connection', state), { accountId: 'fresh-id', accountName: 'Fresh author' });
  }
});

test('cold saved connection IDs still restore without a retained window marker', async (t) => {
  const f = fixture('success');
  f.payloads.length = 0;
  let launches = 0;
  const context = {
    setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {}, route: async () => {},
    newPage: async () => f.page,
  };
  t.mock.method(chromium, 'launch', async () => {
    launches++;
    return { newContext: async () => context };
  });
  assert.deepEqual(await f.adapter.verifyAccount('cold', { cookies: [], origins: [] }), { accountId: 'fresh-id', accountName: 'Fresh author' });
  assert.equal(launches, 1);
});

test('resident refresh navigates author home and returns fresh verified identity without restoring state', async () => {
  const f = fixture('success');
  await f.adapter.completeLogin('login');
  await f.adapter.retainLogin('login', 'connection');
  f.payloads.push('stale evidence');
  const unusedState = { get cookies(): unknown[] { throw new Error('must not restore cookies'); }, origins: [] };
  assert.deepEqual(await f.adapter.refreshSession('connection', unusedState), { accountId: 'fresh-id', accountName: 'Fresh author' });
  assert.deepEqual(f.visits, Array(2).fill('https://fanqienovel.com/main/writer/home'));
  assert.equal(f.saves(), 1, 'runtime captures refreshed state separately');
  assert.equal(f.closes(), 0);
});

test('resident refresh never reopens missing, closed or disconnected contexts, including mid-navigation close', async () => {
  for (const action of ['missing', 'closePage', 'disconnect', 'closeDuringNavigation'] as const) {
    const f = fixture('success');
    await f.adapter.retainLogin('login', 'connection');
    if (action === 'missing') Reflect.get(f.adapter, 'sessions').delete('connection');
    else f[action]();
    await assert.rejects(f.adapter.refreshSession('connection', { cookies: [], origins: [] }), { code: 'PLATFORM_LOGIN_CLOSED' });
    assert.equal(f.visits.length, action === 'closeDuringNavigation' ? 1 : 0);
    assert.equal(f.closes(), 0);
    assert.equal(f.saves(), 0);
  }
});

for (const mode of ['missing', 'redirect', 'failure'] as const) {
  test(`resident refresh fails closed on ${mode} without saving state`, async () => {
    const f = fixture(mode);
    await f.adapter.retainLogin('login', 'connection');
    await assert.rejects(f.adapter.refreshSession('connection', { cookies: [], origins: [] }));
    assert.equal(f.visits.length, 1);
    assert.equal(f.saves(), 0);
    assert.equal(f.closes(), 0);
  });
}

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

test('real Chromium reads same-origin user identity on login and later verification, rejects expired sessions', async (t) => {
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
    await adapter.retainLogin('live', 'resident');
    await page.goto('https://fanqienovel.com/main/writer/book-manage');
    assert.deepEqual(await adapter.refreshSession('resident', result.state), result.account);
    assert.equal(page.url(), 'https://fanqienovel.com/main/writer/home');
    assert.equal(userReads, 3);
    const popup = await context.newPage();
    await popup.goto('https://fanqienovel.com/main/writer/home');
    const session = Reflect.get(adapter, 'sessions').get('resident');
    const forbidLaunch = t.mock.method(chromium, 'launch', async () => { throw new Error('must reuse live Chromium'); });
    await adapter.startLogin('relogin', 'resident');
    assert.equal(forbidLaunch.mock.callCount(), 0);
    assert.equal(Reflect.get(adapter, 'sessions').get('relogin'), session);
    assert.equal(session.browser, browser);
    assert.equal(session.context, context);
    assert.deepEqual(session.pages, new Set([page, popup]));
    assert.equal(browser.contexts().length, 1);
    assert.equal(browser.isConnected(), true);
    assert.deepEqual((await adapter.completeLogin('relogin')).account, result.account);
    await adapter.retainLogin('relogin', 'resident');
    assert.equal(Reflect.get(adapter, 'sessions').get('resident'), session);
    assert.equal(session.pages, undefined);
    loggedIn = false;
    await assert.rejects(adapter.refreshSession('resident', result.state), /业务码 401/);
    await context.close();
    await assert.rejects(adapter.refreshSession('resident', result.state), { code: 'PLATFORM_LOGIN_CLOSED' });
  } finally {
    await adapter.close();
    await browser.close();
  }
});


test('resident refresh retries after offline transport and 5xx but never falls back to stale identity', async () => {
  const browser = await chromium.launch({ headless: true });
  const adapter = new FanqieBrowser();
  try {
    const context = await browser.newContext();
    let mode: 'success' | 'offline' | 'server' | 'unauthorized' | 'malformed' = 'success';
    await context.route('**/*', async route => {
      assert.equal(route.request().method(), 'GET');
      if (new URL(route.request().url()).pathname === '/api/user/info/v2') {
        if (mode === 'offline') return route.abort('internetdisconnected');
        return route.fulfill({ status: mode === 'server' ? 503 : mode === 'unauthorized' ? 401 : 200,
          contentType: 'application/json', body: mode === 'success'
            ? '{"code":0,"data":{"id":"fresh-author","name":"Fresh author"}}'
            : mode === 'malformed' ? '{"code":0,"data":{}}' : '{"code":401}' });
      }
      return route.fulfill({ contentType: 'text/html', body: '<script type="application/json">{"user":{"id":"stale-author","name":"Old author"}}</script>' });
    });
    const page = await context.newPage();
    await page.goto('https://fanqienovel.com/main/writer/home');
    Reflect.get(adapter, 'sessions').set('login', { browser, context, page, pages: new Set([page]) });
    await adapter.retainLogin('login', 'resident');
    const state = { cookies: [], origins: [] };
    for (const transient of ['offline', 'server'] as const) {
      mode = transient;
      await assert.rejects(adapter.refreshSession('resident', state), { code: 'PLATFORM_PAGE_LOAD_FAILED' });
      assert.equal(browser.isConnected(), true);
      assert.equal(page.isClosed(), false);
      mode = 'success';
      assert.deepEqual(await adapter.refreshSession('resident', state), { accountId: 'fresh-author', accountName: 'Fresh author' });
    }
    for (const invalid of ['unauthorized', 'malformed'] as const) {
      mode = invalid;
      await assert.rejects(adapter.refreshSession('resident', state), { code: 'PLATFORM_DOM_VERIFICATION_REQUIRED' });
    }
  } finally { await adapter.close(); await browser.close(); }
});

test('works wait for delayed SPA list evidence, preserve numeric IDs and distinguish empty from unavailable offline', async () => {
  const browser = await chromium.launch({ headless: true });
  const adapter = new FanqieBrowser();
  const state = { cookies: [], origins: [] };
  try {
    for (const mode of ['response', 'dom', 'embedded', 'empty', 'unavailable', 'unrelated', 'placeholder', 'failed', 'malformed', 'expired'] as const) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const page = await context.newPage();
      let identityReads = 0;
      let listReads = 0;
      await context.route('**/*', async (route) => {
        const request = route.request();
        assert.equal(request.method(), 'GET', 'readiness/reconciliation must never retry writes');
        const url = new URL(request.url());
        if (url.pathname === '/api/user/info/v2') {
          identityReads++;
          return route.fulfill({ contentType: 'application/json', body: mode === 'expired'
            ? '{"code":401}' : '{"code":0,"data":{"id":"author","name":"Author"}}' });
        }
        if (url.pathname === '/api/author/book_list/v1/' || url.pathname === '/recommendations') {
          listReads++;
          return route.fulfill({ contentType: 'application/json', body: mode === 'failed'
            ? '{"code":500,"data":{"bookList":[]}}' : mode === 'malformed'
              ? '{"code":0,"data":{"bookList":[{"book_id":7123456789012345678}]}}'
              : mode === 'empty' || mode === 'unrelated' ? '{"code":0,"data":{"bookList":[]}}'
                : '{"code":0,"data":{"bookList":[{"book_id":7123456789012345678,"title":"Offline book"}]}}' });
        }
        // This stored stale list must not authorize a work or prove a truthful empty result.
        const stale = '<script>localStorage.setItem("old",\'{"bookList":[{"book_id":"stale-work","title":"Old"}]}\')</script>';
        const delayed = mode === 'dom'
          ? '<script>setTimeout(()=>{const a=document.createElement("a");a.href="/main/writer/chapter-manage/7123456789012345678&Offline%20book";a.textContent="Offline book";document.body.append(a)},1800)</script>'
          : mode === 'embedded' ? '<script type="application/json">{"bookList":[{"book_id":7123456789012345678,"title":"Offline book"}]}</script>'
            : mode === 'unavailable' ? '<div>Loading</div>'
              : mode === 'placeholder' ? '<script type="application/json">{"bookList":[]}</script>'
                : `<script>setTimeout(()=>fetch("${mode === 'unrelated' ? '/recommendations' : '/api/author/book_list/v1/'}"),1800)</script>`;
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<html><body>${stale}${delayed}</body></html>` });
      });
      Reflect.get(adapter, 'sessions').set(mode, { browser, context, page,
        responsePayloads: ['{"code":0,"data":{"bookList":[{"book_id":"stale-response","title":"Old"}]}}'] });
      if (['unavailable', 'unrelated', 'placeholder', 'failed', 'malformed', 'expired'].includes(mode)) {
        await assert.rejects(adapter.listWorks(mode, state), { code: 'PLATFORM_DOM_VERIFICATION_REQUIRED' });
      } else if (mode === 'empty') {
        assert.deepEqual(await adapter.listWorks(mode, state), []);
        await assert.rejects(Reflect.get(adapter, 'workTitle').call(adapter, mode, state, '7123456789012345678'), { code: 'PLATFORM_WORK_NOT_FOUND' });
      } else {
        const works = await adapter.listWorks(mode, state);
        assert.deepEqual(works.map(({ id, title }) => ({ id, title })), [{ id: '7123456789012345678', title: 'Offline book' }]);
        if (mode !== 'embedded') assert.ok(identityReads >= 2, 'account readiness must not short-circuit work readiness');
        if (mode === 'response') assert.equal(listReads, 1, 'only the page read is observed, no guessed endpoint request');
      }
      assert.equal(Reflect.get(page, 'listenerCount').call(page, 'response'), 0, 'navigation capture must always be removed');
      Reflect.get(adapter, 'sessions').delete(mode);
      await context.close();
    }
  } finally { await browser.close(); }
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
        } else if (url.pathname === '/api/author/publish_article/v0/') {
          await route.fulfill({ contentType: 'application/json', body: '{"code":0,"data":{}}' });
        } else if (url.pathname.includes('/publish/')) {
          await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<html><body><script>history.replaceState({},'', '/main/writer/book-1/publish/draft-1')</script>
            <div class="serial-editor-title"><div class="left-input"><input value="1"></div><div class="serial-editor-title-right"><input class="serial-editor-input-hint-area" value="初始"></div></div>
            <div class="ProseMirror" contenteditable="true">初始正文</div>
            <button class="auto-editor-save-btn" onclick="window.saves=(window.saves||0)+1;fetch('/api/author/publish_article/v0/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({book_id:'book-1',item_id:'draft-1',publish_status:0})})">存草稿</button>
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
        await assert.rejects(run(), /未进入编辑器/);
        assert.equal(page.url(), 'https://fanqienovel.com/main/writer/book-manage');
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

function automaticDraftFixture(mode = 'success') {
  const adapter = new FanqieBrowser();
  const events: string[] = [];
  let url = 'https://fanqienovel.com/main/writer/book-manage';
  let navigated = false;
  let routeReads = 0;
  const exact = 'https://fanqienovel.com/main/writer/book-1/publish/draft-1';
  const locator = (selector: string) => {
    const blocker = mode === 'dialog' ? selector.includes('[role="dialog"]:visible')
      : mode === 'challenge' && selector.includes('.secsdk-captcha-drag-wrapper:visible');
    const absent = selector.includes('.left-input') || selector === '.serial-editor-title:not(.free)';
    return {
      first() { return this; }, filter() { return this; },
      count: async () => selector.includes('[aria-modal=') ? Number(blocker) : absent ? 0 : mode === 'duplicate-editor' && selector.includes('textarea') ? 2 : 1,
      isVisible: async () => true, isDisabled: async () => false, isEditable: async () => true,
      waitFor: async () => { events.push('ready'); if (mode === 'not-ready') throw new Error('timeout'); },
      click: async () => { events.push(selector.includes('save-btn') ? 'save' : 'click'); },
      press: async () => { events.push('press'); },
      fill: async () => { events.push('fill'); },
    };
  };
  const page = {
    url: () => {
      if (mode === 'unstable' && navigated && ++routeReads > 2) return exact.replace('draft-1', 'draft-2');
      return url;
    },
    goto: async (target: string) => { events.push('navigate'); navigated = true; url = target; },
    waitForTimeout: async () => {},
    waitForURL: async (predicate: (value: URL) => boolean, options: { timeout: number }) => {
      events.push('route-wait');
      assert.equal(options.timeout, 8000);
      assert.equal(predicate(new URL(url)), false, 'no-ID editor must not establish identity');
      url = mode === 'wrong-work' ? exact.replace('book-1', 'book-2') : mode === 'missing-id' ? url : exact;
      if (!predicate(new URL(url))) throw new Error('timeout');
    },
    waitForFunction: async () => {},
    locator,
    evaluate: async (_fn: unknown, endpoint: string) => {
      assert.equal(endpoint, '/api/user/info/v2', 'identity reads only');
      events.push(navigated ? 'account-after-navigation' : 'account-before-navigation');
      return { status: 200, body: JSON.stringify({ code: 0, data: { id: navigated && mode === 'wrong-account' ? 'other' : 'author', name: 'Author' } }) };
    },
    waitForResponse: async () => ({ ok: () => true, text: async () => '{"code":0}' }),
  };
  Reflect.set(adapter, 'openVerified', async () => page);
  Reflect.set(adapter, 'workTitle', async () => 'Work');
  Reflect.set(adapter, 'selectedVolume', async () => undefined);
  const snapshot = { chapterId: 'local', number: 1, revision: 1, title: 'Title', content: '验证码 is ordinary prose', paragraphs: ['body'], contentHash: 'hash' };
  const run = (callback: (id: string) => void = id => { events.push(`identified:${id}`); }) =>
    adapter.createDraft('connection', { cookies: [], origins: [] }, 'author', 'book-1', snapshot, callback, undefined, { automaticVerification: true });
  return { run, events, page };
}

test('automatic draft waits for delayed exact route and checkpoints identity before fill or save', async () => {
  const f = automaticDraftFixture();
  assert.deepEqual(await f.run(), { draftId: 'draft-1' });
  assert.equal(f.events.filter(event => event === 'navigate').length, 1);
  assert.equal(f.events.filter(event => event === 'save').length, 1);
  const persisted = f.events.indexOf('identified:draft-1');
  assert.ok(f.events.indexOf('route-wait') < persisted);
  assert.ok(f.events.indexOf('account-after-navigation') < persisted);
  assert.ok(persisted < f.events.indexOf('ready'));
  assert.ok(persisted < f.events.indexOf('click'));
  assert.ok(persisted < f.events.indexOf('fill'));
  assert.ok(persisted < f.events.indexOf('save'));
});

test('automatic draft preserves durable callback failures before all editor mutations', async () => {
  for (const asynchronous of [false, true]) {
    const f = automaticDraftFixture();
    const failure = new Error('durable checkpoint failed');
    await assert.rejects(f.run(asynchronous ? async () => { throw failure; } : () => { throw failure; }), error => error === failure);
    assert.equal(f.events.includes('fill'), false);
    assert.equal(f.events.includes('click'), false);
    assert.equal(f.events.includes('save'), false);
  }
});

for (const mode of ['missing-id', 'wrong-work', 'wrong-account', 'unstable', 'not-ready', 'duplicate-editor', 'dialog', 'challenge']) {
  test(`automatic draft fails closed before fill or click on ${mode}`, async () => {
    const f = automaticDraftFixture(mode);
    await assert.rejects(f.run(), { code: 'PLATFORM_DOM_VERIFICATION_REQUIRED' });
    assert.equal(f.events.includes('fill'), false);
    assert.equal(f.events.includes('click'), false);
    assert.equal(f.events.includes('save'), false);
    assert.equal(f.events.includes('identified:draft-1'), ['not-ready', 'duplicate-editor', 'dialog', 'challenge'].includes(mode), 'retain known identity even when editor is blocked');
    assert.equal(f.events.filter(event => event === 'navigate').length, 1, 'never retry no-ID navigation');
  });
}

for (const mode of ['missing', 'redirect', 'failure'] as const) {
  test(`verification does not save browser state on ${mode}`, async () => {
    const f = fixture(mode);
    await assert.rejects(f.adapter.completeLogin('login'));
    assert.equal(f.visits.length, 1);
    assert.equal(f.saves(), 0);
  });
}
