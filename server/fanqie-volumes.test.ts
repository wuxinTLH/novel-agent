import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, type Route } from 'playwright';
import { FanqieBrowser, fanqieTitlesEquivalent, reviewReceiptMatches } from './fanqie-browser.js';

const state = { cookies: [], origins: [] };
const snapshot = { chapterId: 'local', number: 2, revision: 1, title: '第 2 章新标题', content: '新正文', paragraphs: ['新正文'], contentHash: 'unchanged' };
const bookId = '7123456789012345678';
const draftId = '8123456789012345678';
const volumeId = '9123456789012345678';

test('numbered titles compare whitespace canonically without changing snapshots or receipts', () => {
  assert.equal(fanqieTitlesEquivalent('第 2 章新标题', '第2章 新标题'), true);
  assert.equal(fanqieTitlesEquivalent('第2章 新 标题', '第2章 新标题'), false);
  assert.equal(fanqieTitlesEquivalent('第2章 新标题', '第3章 新标题'), false);
  assert.equal(reviewReceiptMatches(JSON.stringify({ code: 0, data: { item_list: [{ item_id: draftId, title: '第2章 新标题', display_status: 4 }] } }), draftId, snapshot.title), true);
  assert.equal(snapshot.title, '第 2 章新标题');
});

async function fixture(mode = 'ok') {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const adapter = new FanqieBrowser();
  const requests: URL[] = [];
  let saves = 0;
  let title = '旧标题';
  let number = '1';
  let content = '旧正文';
  let selectedVolume = mode === 'missing-draft-volume' ? volumeId : 'volume-old';
  let editorVisits = 0;
  const json = (route: Route, data: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, data }) });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    assert.equal(url.origin, 'https://fanqienovel.com');
    assert.equal(route.request().method(), 'GET', 'all browser traffic is mocked and no direct write API is allowed');
    if (url.pathname === '/api/user/info/v2') return json(route, { id: mode === 'wrong-account' ? 'other' : 'author', name: '作者' });
    if (url.pathname === '/api/author/volume/volume_list/v1') {
      assert.equal(url.searchParams.get('book_id'), bookId);
      return route.fulfill({ contentType: 'application/json', body: `{"code":0,"data":{"volume_list":[{"volume_id":${volumeId},"volume_name":"第二卷","item_count":2}${mode === 'duplicate-volume' ? `,{"volume_id":"other-volume","volume_name":"第二卷","item_count":1}` : ''}]}}` });
    }
    if (url.pathname === '/api/author/chapter/draft_list/v1') {
      assert.equal(url.searchParams.get('book_id'), bookId);
      assert.equal(url.searchParams.get('page_count'), '15');
      assert.equal(url.searchParams.has('volume_id'), false, 'draft API is work-scoped; filter only after complete read');
      const index = Number(url.searchParams.get('page_index'));
      if (mode === 'incomplete') return json(route, { total_count: 2, draft_list: index ? [] : [{ item_id: draftId, title: '旧标题', volume_id: volumeId }] });
      if (mode === 'duplicate-page') return json(route, { total_count: 2, draft_list: [{ item_id: draftId, title: '旧标题', volume_id: volumeId }] });
      return json(route, { total_count: mode === 'not-draft' ? 0 : 1, draft_list: mode === 'not-draft' ? [] : [{ item_id: draftId, title: '旧标题', ...(mode === 'missing-draft-volume' ? {} : { volume_id: volumeId }) }] });
    }
    if (url.pathname === '/api/author/chapter/chapter_list/v1') {
      assert.equal(url.searchParams.get('book_id'), bookId);
      const index = Number(url.searchParams.get('page_index'));
      if (mode.startsWith('receipt-')) {
        if (mode === 'receipt-business-error') return route.fulfill({ contentType: 'application/json', body: '{"code":401,"message":"PRIVATE_COOKIE_SECRET","data":{}}' });
        const status = mode === 'receipt-scheduled' ? 10 : mode === 'receipt-status-string' ? '4' : 4;
        const item = { item_id: mode === 'receipt-wrong-id' ? 'other' : draftId, title: mode === 'receipt-wrong-title' ? '其他标题' : '第2章 新标题', ...(mode === 'receipt-publish-only' ? { publish_status: 1 } : { display_status: status }) };
        const items = mode === 'receipt-duplicate' ? [item, item] : [item];
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, data: { total_count: items.length, item_list: items } }).replace(`"${draftId}"`, draftId) });
      }
      if (mode === 'pagination') {
        return json(route, { total_count: 16, item_list: Array.from({ length: index ? 1 : 15 }, (_, i) => ({ item_id: `chapter-${index * 15 + i}`, title: `章节${index * 15 + i}`, volume_id: volumeId, display_status: 1 })) });
      }
      return json(route, { total_count: 1, item_list: [{ item_id: 'published-id', title: '已发布', volume_id: volumeId, display_status: 1 }] });
    }
    if (url.pathname === '/api/author/edit_article/v0/') {
      assert.equal(url.searchParams.get('item_id'), draftId);
      assert.equal(url.searchParams.get('book_id'), bookId);
      assert.equal(url.searchParams.get('from_source'), '0');
      return json(route, { item_id: draftId, book_id: mode === 'wrong-work' ? 'other' : bookId, title, content, publish_status: mode === 'published' ? 1 : 0, volume_id: mode === 'wrong-saved-volume' ? 'wrong-volume' : selectedVolume, volume_data: [{ volume_id: volumeId, volume_name: '第二卷' }], latest_version: 1 });
    }
    if (url.pathname === '/mock-save') {
      saves++;
      title = url.searchParams.get('title')!;
      number = url.searchParams.get('number')!;
      content = url.searchParams.get('content')!;
      selectedVolume = url.searchParams.get('volume')!;
      return json(route, {});
    }
    if (url.pathname.includes('/publish')) {
      editorVisits++;
      if (mode === 'redirect') return route.fulfill({ status: 302, headers: { location: `https://fanqienovel.com/main/writer/other/publish/${draftId}/` } });
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<html><body>
        <div class="serial-editor-title"><div class="left-input"><input value="${number}"></div><div class="serial-editor-title-right"><input class="serial-editor-input-hint-area" value="${title}"></div></div>
        <div class="ProseMirror" contenteditable="true">${content}</div>
        <a class="muye-link-text" onclick="document.querySelector('.editor-volume').style.display='block'"><span class="publish-header-volume-name">${selectedVolume === volumeId ? '第二卷' : '第一卷'}</span></a>
        <div class="editor-volume" style="display:none"><h2>分卷</h2><div class="editor-volume-list-item-normal"><span onclick="window.selected='${volumeId}'">第二卷</span><i onclick="window.bad=true">编辑</i></div>
        <div class="editor-volume-footer-buttons"><button onclick="document.querySelector('.publish-header-volume-name').textContent='第二卷';this.closest('.editor-volume').style.display='none'">确定</button></div></div>
        <button class="auto-editor-save-btn" onclick="fetch('/mock-save?'+new URLSearchParams({title:document.querySelector('.serial-editor-input-hint-area').value,number:document.querySelector('.left-input input').value,content:document.querySelector('.ProseMirror').innerText,volume:window.selected||'${selectedVolume}'}))">存草稿</button>
      </body></html>` });
    }
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<html><body><script type="application/json">{"bookList":[{"book_id":"${bookId}","title":"作品"}]}</script></body></html>` });
  });
  await page.goto('https://fanqienovel.com/main/writer/book-manage');
  Reflect.get(adapter, 'sessions').set('connection', { browser, context, page });
  return { adapter, page, requests, saves: () => saves, editorVisits: () => editorVisits, close: () => browser.close() };
}


test('review reconciliation reads exact immediate receipt without editor navigation or writes', async () => {
  for (const mode of ['receipt-ok', 'receipt-scheduled', 'receipt-wrong-id', 'receipt-wrong-title', 'receipt-status-string', 'receipt-publish-only', 'receipt-duplicate', 'receipt-business-error', 'wrong-account']) {
    const f = await fixture(mode);
    try {
      const run = () => f.adapter.verifyReviewReceipt('connection', state, 'author', bookId, draftId, snapshot);
      if (['receipt-status-string', 'receipt-publish-only', 'receipt-duplicate', 'wrong-account'].includes(mode)) await assert.rejects(run());
      else if (mode === 'receipt-business-error') await assert.rejects(run(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /endpoint=\/api\/author\/chapter\/chapter_list\/v1; http=200; code=401; json=true/);
        assert.equal(error.message.includes('PRIVATE_COOKIE_SECRET'), false);
        assert.equal(error.message.includes(bookId), false);
        return true;
      });
      else assert.equal(await run(), mode === 'receipt-ok', mode);
      assert.equal(f.editorVisits(), 0, mode);
      assert.equal(f.saves(), 0, mode);
      assert.equal(f.requests.some((url) => /edit_article|publish|post_article|new_article|delete/.test(url.pathname)), false, mode);
    } finally { await f.close(); }
  }
});

test('real Chromium reads lossless volumes and fully paginated scoped chapter/draft catalogs', async () => {
  const f = await fixture('pagination');
  try {
    assert.deepEqual(await f.adapter.listVolumes('connection', state, bookId), [{ id: volumeId, name: '第二卷', itemCount: 2 }]);
    const items = await f.adapter.listChapters('connection', state, bookId, volumeId);
    assert.equal(items.length, 17);
    assert.equal(items.filter((item) => item.kind === 'chapter').length, 16);
    assert.equal(items.find((item) => item.id === draftId)?.kind, 'draft');
    assert.equal(f.requests.filter((url) => url.pathname.endsWith('chapter_list/v1')).length, 2);
    for (const url of f.requests.filter((url) => url.pathname.endsWith('chapter_list/v1'))) assert.equal(url.searchParams.get('volume_id'), volumeId);
    assert.equal(f.editorVisits(), 0);
    assert.equal(f.saves(), 0);
  } finally { await f.close(); }
});

test('real Chromium enriches missing draft volume with read-only edit GET even for an unfiltered catalog', async () => {
  const f = await fixture('missing-draft-volume');
  try {
    const items = await f.adapter.listChapters('connection', state, bookId);
    assert.equal(items.find((item) => item.id === draftId)?.volumeId, volumeId);
    assert.equal(f.requests.filter((url) => url.pathname === '/api/author/edit_article/v0/').length, 1);
    assert.equal(f.editorVisits(), 0);
    assert.equal(f.saves(), 0);
  } finally { await f.close(); }
});

test('real Chromium overwrites only the same draft, selects volume, saves once and reads back canonical title', async () => {
  const f = await fixture();
  try {
    const actual = await f.adapter.overwriteDraft('connection', state, 'author', bookId, draftId, snapshot, volumeId);
    assert.equal(actual.id, draftId);
    assert.equal(actual.title, '第2章 新标题');
    assert.equal(actual.content, snapshot.content);
    assert.equal(actual.volumeId, volumeId);
    assert.equal(actual.publishStatus, 0);
    assert.equal(f.saves(), 1);
    assert.equal(f.editorVisits(), 2);
    assert.equal(f.requests.some((url) => /new_article|delete/.test(url.pathname)), false);
    assert.equal(await f.page.evaluate(() => (window as unknown as { bad?: boolean }).bad), undefined);
    assert.equal(snapshot.title, '第 2 章新标题');
  } finally { await f.close(); }
});

test('real Chromium overwrite rejects published, unrelated, incomplete and duplicate catalogs before mutation', async () => {
  for (const mode of ['published', 'not-draft', 'incomplete', 'duplicate-page', 'duplicate-volume', 'wrong-work', 'wrong-account']) {
    const f = await fixture(mode);
    try {
      await assert.rejects(f.adapter.overwriteDraft('connection', state, 'author', bookId, draftId, snapshot, volumeId), () => true, mode);
      assert.equal(f.saves(), 0, mode);
      assert.equal(f.requests.some((url) => /new_article|delete/.test(url.pathname)), false);
    } finally { await f.close(); }
  }
});

test('real Chromium overwrite fails closed when saved volume differs', async () => {
  const f = await fixture('wrong-saved-volume');
  try {
    await assert.rejects(f.adapter.overwriteDraft('connection', state, 'author', bookId, draftId, snapshot, volumeId), /回读内容或分卷不匹配/);
    assert.equal(f.saves(), 1);
  } finally { await f.close(); }
});
