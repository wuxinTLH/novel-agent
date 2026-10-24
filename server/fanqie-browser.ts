import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import type { DraftSnapshot } from '../shared/platforms.js';
import {
  PlatformError,
  type BrowserSessionState,
  type DraftBrowserAdapter,
  type VerifiedAccount,
  type VerifiedDraft,
  type FanqieVolume,
  type FanqieChapter,
} from './platforms-types.js';

export const FANQIE_PORTAL = 'https://fanqienovel.com/main/writer/';
const FANQIE_ORIGIN = 'https://fanqienovel.com';
const FANQIE_BOOKS = `${FANQIE_PORTAL}book-manage`;
const FANQIE_HOME = `${FANQIE_PORTAL}home`;
export const FANQIE_VERIFICATION_REASON =
  '番茄作者页结构尚未完成当前版本核验，未找到稳定的账号、作品或编辑器定位；不会写入或删除远端内容。';
const IDENTITY_KEYS = ['authorId', 'author_id', 'userId', 'user_id', 'uid', 'user_id_str'];
const ACCOUNT_NAME_KEYS = ['authorName', 'author_name', 'nickName', 'nick_name', 'nickname', 'name', 'userName', 'user_name'];
const WORK_LIST_KEYS = ['bookList', 'book_list', 'books', 'works', 'workList', 'novelList'];
const WAIT_AFTER_NAVIGATION_MS = 1200;

/** Exact public origin only. New login redirects require observed evidence, not a wildcard. */
export function allowedFanqieNavigation(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'fanqienovel.com' &&
      !url.port &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function readIdentifier(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && /^[A-Za-z0-9_-]{2,160}$/.test(value.trim())) return value.trim();
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  }
  return '';
}
function readDisplayString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() && !/[\u0000-\u001f]/.test(value))
      return value.trim().slice(0, 120);
  }
  return '';
}
export function findAccount(value: unknown, seen = new Set<unknown>(), scope = ''): VerifiedAccount | undefined {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAccount(item, seen, scope);
      if (found) return found;
    }
    return;
  }
  const record = value as Record<string, unknown>;
  const accountScope = /author|user|account|profile/i.test(scope);
  const accountId = readIdentifier(record, accountScope ? [...IDENTITY_KEYS, 'id'] : IDENTITY_KEYS);
  const accountName = readDisplayString(
    record,
    accountScope ? [...ACCOUNT_NAME_KEYS, 'displayName', 'display_name', 'name'] : ACCOUNT_NAME_KEYS,
  );
  if (accountId && accountName) return { accountId, accountName };
  for (const [key, item] of Object.entries(record)) {
    const found = findAccount(item, seen, scope ? `${scope}.${key}` : key);
    if (found) return found;
  }
}
function workFromRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const work = value as Record<string, unknown>;
  const id = readIdentifier(work, ['bookId', 'book_id', 'workId', 'work_id', 'id']);
  const title = readDisplayString(work, ['title', 'bookName', 'book_name', 'name']);
  if (!id || !title) return;
  return { id, title: title.slice(0, 120) };
}
function findWorks(value: unknown, seen = new Set<unknown>()): { id: string; title: string }[] {
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap((item) => findWorks(item, seen));
  const record = value as Record<string, unknown>;
  for (const key of WORK_LIST_KEYS) {
    const list = record[key];
    if (!Array.isArray(list)) continue;
    const works = list.map(workFromRecord).filter((item): item is { id: string; title: string } => !!item);
    if (works.length) return works;
  }
  return Object.values(record).flatMap((item) => findWorks(item, seen));
}
function uniqueWorks(items: { id: string; title: string }[]) {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}
function parseEmbeddedPayload(payload: string) {
  const start = payload.indexOf('{');
  const end = payload.lastIndexOf('}');
  if (start < 0 || end <= start) return;
  try {
    return JSON.parse(payload.slice(start, end + 1)) as unknown;
  } catch {
    /* Embedded scripts can contain non-JSON; DOM evidence is handled separately. */
  }
}
function routeWorkFromHref(href: string, text: string) {
  try {
    const url = new URL(href);
    const match = /\/chapter-manage\/([^/?#&]+)(?:&([^/?#]+))?/.exec(url.pathname + url.search);
    if (!match) return;
    const id = decodeURIComponent(match[1]);
    const title = decodeURIComponent(match[2] || text).trim();
    if (id && title) return { id, title: title.slice(0, 120) };
  } catch {
    /* Ignore malformed third-party links. */
  }
}
// The portal login provider stores response.data directly as loginInfo (id/name).
// Keep 64-bit numeric IDs intact before JSON.parse can round them.
export function parseCurrentUser(payload: string): VerifiedAccount | undefined {
  try {
    const lossless = payload.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (token) =>
      /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token,
    );
    const result = JSON.parse(lossless) as { code?: unknown; data?: Record<string, unknown> };
    if (result?.code !== 0 || !result.data || Array.isArray(result.data)) return;
    const accountId = readIdentifier(result.data, ['id']);
    const accountName = readDisplayString(result.data, ['name']);
    if (accountId && accountId !== '0' && accountName) return { accountId, accountName };
  } catch {
    // Invalid or non-JSON replies cannot prove a logged-in account.
  }
}
function parseLosslessJson(payload: string): unknown {
  return JSON.parse(payload.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (token) =>
    /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token));
}
export function fanqieSnapshotTitle(snapshot: Pick<DraftSnapshot, 'title' | 'number'>): string {
  const title = snapshot.title.trim();
  if (!Number.isSafeInteger(snapshot.number) || snapshot.number < 1 || !title)
    verificationRequired('章节必须包含有效序号和非空标题，未进入编辑器。');
  const match = /^第\s*([1-9]\d*)\s*章\s*(.+)$/.exec(title);
  if (match) {
    if (Number(match[1]) !== snapshot.number) verificationRequired('标题中的章节序号与本地章节序号不一致，未进入编辑器。');
    return `第${snapshot.number}章 ${match[2].trim()}`;
  }
  if (/^第\s*[\d一二三四五六七八九十百千万零〇两]+\s*章/.test(title)) verificationRequired('章节标题格式无效，未进入编辑器。');
  return `第${snapshot.number}章 ${title}`;
}
export function fanqieTitlesEquivalent(left: string, right: string): boolean {
  const parse = (value: string) => /^第\s*([1-9]\d*)\s*章\s*(.+)$/.exec(value.trim());
  const a = parse(left), b = parse(right);
  return a && b ? a[1] === b[1] && a[2].trim() === b[2].trim() : left.trim() === right.trim();
}
async function readApi(page: Page, pathname: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  if (!allowedFanqieNavigation(page.url())) verificationRequired('只允许从番茄同源页面读取目录。');
  const reply = await page.evaluate(async (url) => {
    try {
      const response = await fetch(url, { method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000) });
      const body = await response.text();
      return { status: response.status, body: body.length <= 2_000_000 ? body : '' };
    } catch { return { status: 0, body: '' }; }
  }, `${pathname}?${new URLSearchParams(params)}`);
  let businessCode: number | undefined;
  let validJson = false;
  try {
    const result = parseLosslessJson(reply.body) as { code?: unknown; data?: unknown };
    validJson = true;
    if (typeof result?.code === 'number' && Number.isSafeInteger(result.code)) businessCode = result.code;
    if (reply.status === 200 && result?.code === 0 && result.data && typeof result.data === 'object' && !Array.isArray(result.data))
      return result.data as Record<string, unknown>;
  } catch { /* Never leak remote response bodies. */ }
  return verificationRequired(`番茄只读接口失败，未确认远端结果（endpoint=${pathname}; http=${reply.status}; code=${businessCode ?? 'unknown'}; json=${validJson}）。`);
}
async function readCatalog(page: Page, workId: string, kind: 'draft' | 'chapter', volumeId?: string, reviewReceipt = false): Promise<FanqieChapter[]> {
  const result: FanqieChapter[] = [];
  const ids = new Set<string>();
  let expectedTotal: number | undefined;
  for (let index = 0; index < 100; index++) {
    const params: Record<string, string> = { book_id: workId, page_index: String(index), page_count: '15' };
    if (kind === 'chapter' && volumeId) params.volume_id = volumeId;
    const data = await readApi(page, `/api/author/chapter/${kind === 'draft' ? 'draft_list' : 'chapter_list'}/v1`, params);
    const items = data[kind === 'draft' ? 'draft_list' : 'item_list'];
    const total = data.total_count;
    if (!Array.isArray(items) || typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0 || total > 1500 ||
        (expectedTotal !== undefined && expectedTotal !== total) || items.length > 15)
      verificationRequired('章节目录分页格式异常或读取期间发生变化，未确认完整目录。');
    expectedTotal = total;
    for (const value of items) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) verificationRequired('章节目录项目格式异常。');
      const item = value as Record<string, unknown>;
      const id = readIdentifier(item, ['item_id']);
      const itemVolume = readIdentifier(item, ['volume_id']);
      const status = kind === 'draft' ? (item.publish_status ?? 0) : (reviewReceipt ? item.display_status : (item.display_status ?? item.publish_status));
      if (!id || ids.has(id) || typeof item.title !== 'string' || typeof status !== 'number' || !Number.isSafeInteger(status))
        verificationRequired('章节目录包含缺失、重复或无效身份，未确认完整目录。');
      ids.add(id);
      result.push({ id, title: item.title, ...(itemVolume ? { volumeId: itemVolume } : {}), status, kind });
    }
    if (result.length === total) return result;
    if (!items.length || result.length > total) verificationRequired('章节目录分页不完整，未执行操作。');
  }
  return verificationRequired('章节目录超过完整读取上限。');
}
async function readEditMetadata(page: Page, workId: string, draftId: string) {
  const data = await readApi(page, '/api/author/edit_article/v0/', { book_id: workId, item_id: draftId, from_source: '0' });
  for (const [key, expected] of [['book_id', workId], ['item_id', draftId]] as const) {
    if (data[key] !== undefined && readIdentifier(data, [key]) !== expected) verificationRequired('编辑接口返回了不同的作品或草稿身份。');
  }
  if (typeof data.publish_status !== 'number' || !Number.isSafeInteger(data.publish_status))
    verificationRequired(`编辑接口缺少明确发布状态（endpoint=/api/author/edit_article/v0/; publish_status_type=${typeof data.publish_status}）。`);
  const volumeId = readIdentifier(data, ['volume_id']);
  return { publishStatus: data.publish_status, ...(volumeId ? { volumeId } : {}) };
}
function assertEditorRoute(page: Page, workId: string, draftId: string) {
  const expected = new URL(editorPath(workId, draftId, 'draft_manage_modify'));
  const actual = new URL(page.url());
  if (!allowedFanqieNavigation(actual.href) || actual.pathname.replace(/\/$/, '') !== expected.pathname.replace(/\/$/, ''))
    verificationRequired('编辑页跳转到了不同作品或草稿，未执行操作。');
}
async function selectVolume(page: Page, volume: FanqieVolume) {
  const header = page.locator('.publish-header-volume-name');
  if (await header.count() !== 1) verificationRequired('编辑器分卷标题不唯一。');
  if ((await header.innerText()).trim() === volume.name) return;
  const trigger = header.locator('xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," muye-link-text ")][1]');
  if (await trigger.count() !== 1) verificationRequired('没有找到稳定的分卷选择入口。');
  await trigger.click();
  const dialog = page.locator('.editor-volume:visible');
  await dialog.waitFor({ state: 'visible', timeout: 5000 }).catch(() => verificationRequired('分卷选择弹窗未出现。'));
  if (await dialog.count() !== 1 || await dialog.getByText('分卷', { exact: true }).count() !== 1) verificationRequired('分卷选择弹窗结构不唯一。');
  const choices = dialog.locator('.editor-volume-list-item-normal:not(.unavailable) > span');
  const matches: Locator[] = [];
  for (const choice of await choices.all()) if ((await choice.innerText()).trim() === volume.name) matches.push(choice);
  if (matches.length !== 1) verificationRequired('目标分卷缺失、重名或不可选择。');
  await matches[0].click();
  const confirm = dialog.locator('.editor-volume-footer-buttons').getByRole('button', { name: '确定', exact: true });
  if (await confirm.count() !== 1 || await confirm.isDisabled()) verificationRequired('没有唯一可用的分卷确定按钮。');
  await confirm.click();
  if ((await header.innerText()).trim() !== volume.name) verificationRequired('分卷选择未保留。');
}
export function reviewReceiptMatches(payload: string, draftId: string, title: string): boolean {
  try {
    const lossless = payload.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (token) =>
      /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token,
    );
    const result = JSON.parse(lossless) as { code?: unknown; data?: { item_list?: unknown } };
    if (result?.code !== 0 || !Array.isArray(result.data?.item_list)) return false;
    const matches = result.data.item_list.filter((item: unknown) => item && typeof item === 'object' &&
      readIdentifier(item as Record<string, unknown>, ['item_id']) === draftId);
    if (matches.length !== 1) return false;
    const item = matches[0] as Record<string, unknown>;
    return typeof item.title === 'string' && fanqieTitlesEquivalent(item.title, title) && [1, 4, 5].includes(item.display_status as number);
  } catch { return false; }
}

async function readCurrentUser(page: Page) {
  if (!allowedFanqieNavigation(page.url())) return {};
  const reply = await page.evaluate(async (endpoint) => {
    try {
      const response = await fetch(endpoint, {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.text();
      return { status: response.status, body: body.length <= 256_000 ? body : '' };
    } catch {
      return { status: 0, body: '' };
    }
  }, '/api/user/info/v2');
  const account = reply.status === 200 ? parseCurrentUser(reply.body) : undefined;
  // Only transport/status diagnostics leave this reader; never expose response bodies or credentials.
  let detail = `当前用户接口 HTTP ${reply.status || '请求失败'}`;
  if (reply.status === 200) {
    try {
      const code: unknown = JSON.parse(reply.body).code;
      detail = typeof code === 'number' && Number.isSafeInteger(code)
        ? `当前用户接口业务码 ${code}${code === 0 ? '，缺少有效的 id/name' : ''}`
        : '当前用户接口返回格式异常';
    } catch {
      detail = '当前用户接口返回非 JSON 数据';
    }
  }
  return { account, detail };
}
async function readPageEvidence(page: Page, responsePayloads: Iterable<string> = []) {
  const identity = await readCurrentUser(page);
  const evidence = await page.evaluate(() => ({
    bodyText: (document.body.innerText || '').slice(0, 200_000),
    scripts: [...document.querySelectorAll('script')]
      .map((node) => node.textContent || '')
      .filter((item) => item.length > 20 && item.length < 2_000_000),
    globals: ['__NEXT_DATA__', '__INITIAL_STATE__', '__DATA__'].flatMap((key) => {
      const value = (window as unknown as Record<string, unknown>)[key];
      return value ? [JSON.stringify(value).slice(0, 2_000_000)] : [];
    }),
    storage: [window.localStorage, window.sessionStorage].flatMap((storage) => {
      const values: string[] = [];
      for (let index = 0; index < storage.length; index++) {
        const value = storage.getItem(storage.key(index) || '');
        if (value && value.length < 2_000_000) values.push(value);
      }
      return values;
    }),
    links: [...document.querySelectorAll('a')].map((node) => ({
      href: (node as HTMLAnchorElement).href,
      text: (node.textContent || '').trim().slice(0, 160),
    })),
    accountNodes: [...document.querySelectorAll('[data-user-id], [data-author-id], [data-uid]')].map((node) => ({
      id: node.getAttribute('data-user-id') || node.getAttribute('data-author-id') || node.getAttribute('data-uid') || '',
      name: (node.textContent || '').trim().slice(0, 120),
    })),
  }));
  const account = identity.account;
  let works: { id: string; title: string }[] = [];
  for (const payload of [...evidence.scripts, ...evidence.globals, ...evidence.storage, ...responsePayloads]) {
    const parsed = parseEmbeddedPayload(payload);
    if (!parsed) continue;
    if (!works.length) works = findWorks(parsed);
  }
  if (!works.length)
    works = evidence.links.map((link) => routeWorkFromHref(link.href, link.text)).filter(
      (item): item is { id: string; title: string } => !!item,
    );
  return { account, identityDetail: identity.detail, works: uniqueWorks(works), bodyText: evidence.bodyText };
}
async function waitForAccount(page: Page, attempts = 8, responsePayloads: string[] = []) {
  let evidence = await readPageEvidence(page, responsePayloads);
  for (let attempt = 1; !evidence.account && attempt < attempts; attempt++) {
    await page.waitForTimeout(750);
    evidence = await readPageEvidence(page, responsePayloads);
  }
  return evidence;
}
function verificationRequired(detail = FANQIE_VERIFICATION_REASON): never {
  throw new PlatformError(503, 'PLATFORM_DOM_VERIFICATION_REQUIRED', detail);
}
async function waitForPortal(page: Page) {
  await page.waitForTimeout(WAIT_AFTER_NAVIGATION_MS);
  if (!allowedFanqieNavigation(page.url()))
    throw new PlatformError(409, 'PLATFORM_LOGIN_ORIGIN_UNVERIFIED', '页面跳转到了未核验的番茄域名，未执行平台操作。');
}
async function gotoPortal(page: Page, url: string) {
  if (!allowedFanqieNavigation(url)) throw new PlatformError(400, 'PLATFORM_NAVIGATION_INVALID', '平台页面地址未通过域名核验。');
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitForPortal(page);
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    throw new PlatformError(502, 'PLATFORM_PAGE_LOAD_FAILED', '番茄作者页加载失败，未执行平台操作。');
  }
}
async function visibleLocator(page: Page, selectors: string[]) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count() && await locator.isVisible().catch(() => false)) return locator;
  }
  return undefined;
}
function workPath(workId: string, title = '') {
  return `${FANQIE_ORIGIN}/main/writer/chapter-manage/${encodeURIComponent(workId)}&${encodeURIComponent(title)}`;
}
function editorPath(workId: string, draftId = '', source: 'draft_manage_create' | 'draft_manage_modify' = 'draft_manage_create') {
  const suffix = draftId ? `/${encodeURIComponent(draftId)}` : '/';
  return `${FANQIE_ORIGIN}/main/writer/${encodeURIComponent(workId)}/publish${suffix}?enter_from=${source}`;
}
function draftIdFromHref(href: string, workId: string) {
  try {
    const url = new URL(href);
    const path = decodeURIComponent(url.pathname);
    const publish = /\/publish\/([^/?#&]+)/.exec(path);
    if (publish?.[1]) return publish[1];
    for (const key of ['item_id', 'itemId', 'draft_id', 'draftId', 'id']) {
      const value = url.searchParams.get(key);
      if (value) return value;
    }
    const marker = `${workId}&`;
    const raw = `${path}${url.search}`;
    const index = raw.indexOf(marker);
    if (index >= 0) return raw.slice(index + marker.length).split(/[/?#&]/, 1)[0];
  } catch {
    /* Ignore malformed third-party links. */
  }
  return '';
}
async function draftEntries(page: Page, workId: string) {
  const entries = await page.locator('a').evaluateAll(
    (anchors, id) =>
      anchors
        .map((anchor) => ({
          href: (anchor as HTMLAnchorElement).href,
          title: (anchor.textContent || '').trim(),
          isDraftLink: !!anchor.querySelector('.auto-editor-draft-edit'),
        }))
        .filter((item) => item.isDraftLink || item.href.includes(`${id}&`) || /\/publish\//.test(item.href)),
    workId,
  );
  return [...new Map(
    entries
      .map((entry) => ({ id: draftIdFromHref(entry.href, workId), title: entry.title, href: entry.href }))
      .filter((entry) => entry.id)
      .map((entry) => [entry.id, entry]),
  ).values()];
}
async function openDraftList(page: Page, workId: string, workTitle = '') {
  await gotoPortal(page, workPath(workId, workTitle));
  const tab = page.getByText('草稿箱', { exact: true }).first();
  if (!(await tab.count()) || !(await tab.isVisible().catch(() => false)))
    verificationRequired('作品管理页没有显示草稿箱入口，未执行草稿操作。');
  await tab.click();
  try {
    await page.locator('.draft-table.auto-editor-draft').waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    verificationRequired('未能确认已进入番茄草稿箱列表，未执行草稿操作。');
  }
  const entries = new Map<string, { id: string; title: string; href: string }>();
  for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
    for (const entry of await draftEntries(page, workId)) entries.set(entry.id, entry);
    const next = page.locator('.arco-pagination-next').last();
    if (!(await next.count()) || !(await next.isVisible().catch(() => false))) break;
    const className = (await next.getAttribute('class')) || '';
    if (className.split(/\s+/).some((name) => name.endsWith('disabled'))) break;
    const activeBefore = await page.locator('.arco-pagination-item-active').last().innerText().catch(() => '');
    await next.click();
    await page.waitForTimeout(350);
    const activeAfter = await page.locator('.arco-pagination-item-active').last().innerText().catch(() => '');
    if (activeAfter === activeBefore) verificationRequired('草稿列表分页没有响应，未确认完整列表。');
    if (pageIndex === 99) verificationRequired('草稿数量超过核对上限，未执行草稿删除。');
  }
  return [...entries.values()];
}
function editorTitle(page: Page) {
  return visibleLocator(page, [
    '.serial-editor-title.free .serial-editor-free-title textarea',
    '.serial-editor-title:not(.free) .serial-editor-title-right input.serial-editor-input-hint-area',
    '.serial-editor-title-inner[contenteditable="true"]',
    '.serial-editor-title [contenteditable="true"]',
    'input.serial-editor-title',
    'input[class*="title"]',
  ]);
}
async function editorBody(page: Page) {
  return visibleLocator(page, [
    '.syl-editor-container .ProseMirror[contenteditable="true"]',
    '.syl-editor .ProseMirror[contenteditable="true"]',
    '.ProseMirror[contenteditable="true"]',
  ]);
}
async function readEditor(page: Page, workId: string, draftId: string): Promise<VerifiedDraft> {
  const title = await editorTitle(page);
  const body = await editorBody(page);
  if (!title || !body) verificationRequired('已打开番茄编辑页，但没有找到稳定的标题或正文编辑器。');
  const values = await Promise.all([
    title.evaluate((node) =>
      node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? node.value : node.textContent || '',
    ),
    body.evaluate((node) => {
      // innerText inserts CSS paragraph margins as extra blank lines. The official editor
      // persists <p> blocks; one block boundary is one logical newline, not two.
      const serializer = { serialize(parent: Node): string {
        const children = [...parent.childNodes];
        if (children.length === 1 && children[0] instanceof HTMLBRElement) return '';
        let text = '';
        for (let index = 0; index < children.length; index++) {
          const child = children[index];
          if (child.nodeType === Node.TEXT_NODE) text += child.textContent || '';
          else if (child instanceof HTMLBRElement) text += '\n';
          else {
            const block = child instanceof HTMLElement && /^(P|DIV)$/.test(child.tagName);
            const previous = children[index - 1];
            const previousBlock = previous instanceof HTMLElement && /^(P|DIV)$/.test(previous.tagName);
            if (index && (block || previousBlock)) text += '\n';
            text += this.serialize(child);
          }
        }
        return text;
      } };
      return serializer.serialize(node);
    }),
  ]);
  const number = page.locator('.serial-editor-title:not(.free) .left-input input');
  if (await number.count()) {
    if (await number.count() !== 1) verificationRequired('章节序号输入不唯一。');
    values[0] = `第${await number.inputValue()}章 ${values[0]}`;
  } else if (await page.locator('.serial-editor-title:not(.free)').count()) {
    verificationRequired('不支持没有数字序号的番外章节标题。');
  }
  const identity = (await readPageEvidence(page)).account;
  if (!identity) verificationRequired('编辑器页面没有稳定的作者身份，未保存读取结果。');
  return {
    id: draftId,
    workId,
    accountId: identity.accountId,
    title: values[0].trim(),
    content: values[1].replace(/ /g, ' ').replace(/\r\n?/g, '\n').trim(),
    paragraphs: values[1].replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').trim().split('\n'),
  };
}
async function waitForDraftEditor(page: Page) {
  const button = page.locator('button.auto-editor-save-btn').filter({ hasText: /^\s*存草稿\s*$/ });
  try {
    await button.waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForFunction(() => {
      const buttons = [...document.querySelectorAll<HTMLButtonElement>('button.auto-editor-save-btn')]
        .filter(item => item.textContent?.trim() === '存草稿');
      return buttons.length === 1 && !buttons[0].disabled && !buttons[0].classList.contains('arco-btn-loading');
    }, undefined, { timeout: 15_000 });
  } catch {
    verificationRequired('草稿编辑器未就绪：存草稿按钮缺失、不可用或仍在加载。请先处理官方页面的缓存恢复或权限提示；未点击保存。');
  }
}
async function fillEditor(page: Page, snapshot: DraftSnapshot) {
  await waitForDraftEditor(page);
  const title = await editorTitle(page);
  const body = await editorBody(page);
  if (!title || !body) verificationRequired('已打开番茄编辑页，但没有找到稳定的标题或正文编辑器。');
  const number = page.locator('.serial-editor-title:not(.free) .left-input input');
  let titleValue = fanqieSnapshotTitle(snapshot);
  if (await number.count()) {
    const match = /^第\s*([1-9]\d*)\s*章\s*(.+)$/.exec(titleValue);
    if (await number.count() !== 1 || !match || Number(match[1]) !== snapshot.number)
      verificationRequired('标准章节标题必须为与章节序号一致的“第N章 标题”；不支持的格式不会写入编辑器。');
    await number.fill(match[1]);
    titleValue = match[2];
  } else if (await page.locator('.serial-editor-title:not(.free)').count()) {
    verificationRequired('不支持没有数字序号的番外章节标题。');
  }
  await title.click();
  await title.press('ControlOrMeta+A');
  await title.fill(titleValue);
  await body.click();
  await body.press('ControlOrMeta+A');
  await body.fill(snapshot.content);
}
async function clickSave(page: Page) {
  await waitForDraftEditor(page);
  const button = page.locator('button.auto-editor-save-btn').filter({ hasText: /^\s*存草稿\s*$/ });
  if (await button.count() !== 1 || !(await button.isVisible()) || await button.isDisabled())
    verificationRequired('编辑器中没有找到唯一可用的“存草稿”操作。');
  const route = /\/writer\/([^/]+)\/publish\/([^/?#]+)/.exec(new URL(page.url()).pathname);
  if (!route) verificationRequired('保存前无法确定唯一作品和草稿身份。');
  const completion = page.waitForResponse(response => {
    const url = new URL(response.url());
    if (url.origin !== 'https://fanqienovel.com' || !['/api/author/publish_article/v0/', '/api/author/article/cover_article/v0/'].includes(url.pathname)) return false;
    const request = response.request();
    if (request.method() !== 'POST') return false;
    try {
      const raw = request.postData() ?? '';
      const data = request.headers()['content-type']?.includes('application/json') ? parseLosslessJson(raw) as Record<string, unknown> : Object.fromEntries(new URLSearchParams(raw));
      return String(data.book_id) === route![1] && String(data.item_id) === route![2] &&
        (url.pathname.includes('cover_article') || String(data.publish_status) === '0');
    } catch { return false; }
  }, { timeout: 20_000 }).then(async response => {
    const body = parseLosslessJson(await response.text()) as { code?: unknown };
    if (!response.ok() || body.code !== 0) verificationRequired('番茄未确认草稿保存成功；结果未知，请只读核对。');
  });
  // Attach a rejection handler before clicking; an interrupted click must not leak an unhandled waiter.
  void completion.catch(() => {});
  await button.click();
  try { await completion; }
  catch { verificationRequired('未收到当前作品与草稿的成功保存回执；结果未知，不会自动重传。'); }
}

export class FanqieBrowser implements DraftBrowserAdapter {
  readonly readiness = 'ready' as const;
  readonly reason = '已实现基于番茄作者页的人工登录、作品读取、草稿编辑器写入、回读核验和远端草稿删除；页面结构变化时会失败关闭。';
  private sessions = new Map<
    string,
    { browser: Browser; context: BrowserContext; page: Page; pages?: Set<Page>; responsePayloads?: string[] }
  >();
  private stopped = false;

  async startLogin(loginId: string) {
    if (this.stopped) throw new PlatformError(503, 'PLATFORM_CLOSING', '平台服务正在关闭。');
    // Idle verified contexts are not manual login windows. Runtime locks exclude active operations.
    if ([...this.sessions.values()].some((session) => session.pages !== undefined))
      throw new PlatformError(409, 'PLATFORM_LOGIN_BUSY', '请先完成或关闭当前人工登录窗口。');
    let browser: Browser | undefined;
    try {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: false });
      if (this.stopped) {
        await browser.close();
        return;
      }
      const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
      context.setDefaultTimeout(15_000);
      context.setDefaultNavigationTimeout(30_000);
      await context.route('**/*', async (route) => {
        const request = route.request();
        if (request.isNavigationRequest() && !allowedFanqieNavigation(request.url())) {
          await route.abort('blockedbyclient');
          return;
        }
        const url = new URL(request.url());
        if (
          !['https:', 'data:', 'blob:'].includes(url.protocol) ||
          /^(localhost|127\.|0\.|169\.254\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::)/i.test(
            url.hostname,
          )
        ) {
          await route.abort('blockedbyclient');
          return;
        }
        await route.continue();
      });
      const page = await context.newPage();
      const pages = new Set<Page>([page]);
      const responsePayloads: string[] = [];
      const captureResponse = (response: import('playwright').Response) => {
        if (!allowedFanqieNavigation(response.url())) return;
        const contentType = response.headers()['content-type'] || '';
        if (!response.ok() || !/json/i.test(contentType)) return;
        void response.text().then((body) => {
          if (body.length > 20 && body.length < 256_000) {
            responsePayloads.push(body);
            if (responsePayloads.length > 32) responsePayloads.shift();
          }
        }).catch(() => {});
      };
      this.sessions.set(loginId, { browser, context, page, pages, responsePayloads });
      page.on('response', captureResponse);
      context.on('page', (popup) => {
        pages.add(popup);
        popup.on('response', captureResponse);
        popup.on('close', () => pages.delete(popup));
        popup.on('dialog', (dialog) => {
          void dialog.dismiss().catch(() => {});
        });
      });
      page.on('dialog', (dialog) => {
        void dialog.dismiss().catch(() => {});
      });
      await page.goto(FANQIE_PORTAL, { waitUntil: 'domcontentloaded' });
      await page.bringToFront();
    } catch {
      this.sessions.delete(loginId);
      await browser?.close().catch(() => {});
      throw new PlatformError(
        503,
        'PLATFORM_BROWSER_UNAVAILABLE',
        '无法打开隔离浏览器。请安装 Playwright Chromium（npx playwright install chromium），检查桌面会话和网络。若官方登录跳转被阻止，需要先核验该域名；不会自动放宽限制。',
      );
    }
  }
  loginOpen(loginId: string) {
    const session = this.sessions.get(loginId);
    return !!session && session.browser.isConnected() && !session.page.isClosed();
  }
  async completeLogin(loginId: string): Promise<{ account: VerifiedAccount; state: BrowserSessionState }> {
    const session = this.sessions.get(loginId);
    if (!session || !this.loginOpen(loginId))
      throw new PlatformError(410, 'PLATFORM_LOGIN_CLOSED', '登录窗口已关闭，请重新开始人工登录。');
    const candidates = [...(session.pages ?? new Set([session.page]))].filter(
      (candidate) => !candidate.isClosed() && allowedFanqieNavigation(candidate.url()),
    );
    const verifiedPage = candidates.find((item) => item === session.page) ?? candidates[0];
    if (!verifiedPage)
      throw new PlatformError(409, 'PLATFORM_LOGIN_ORIGIN_UNVERIFIED', '登录尚未返回番茄作者页；请完成网页登录后再次核验。');
    const responsePayloads = session.responsePayloads ?? [];
    // Explicit verification is read-only: navigate before parsing, rather than trusting stale login-page state.
    responsePayloads.length = 0;
    await verifiedPage.bringToFront();
    await gotoPortal(verifiedPage, FANQIE_HOME);
    const { account, identityDetail } = await waitForAccount(verifiedPage, 3, responsePayloads);
    if (!allowedFanqieNavigation(verifiedPage.url()))
      throw new PlatformError(409, 'PLATFORM_LOGIN_ORIGIN_UNVERIFIED', '核验页面已离开番茄域名，未保存会话。');
    if (!account)
      verificationRequired(`已自动打开番茄作者后台首页，但未能读取稳定作者身份（${identityDetail || '当前用户接口不可用'}）。请确认该窗口已完成登录后再次核验；无需手动切换页面。`);
    const state = await session.context.storageState();
    return { account, state: { cookies: state.cookies, origins: state.origins } };
  }
  async closeLogin(loginId: string) {
    const session = this.sessions.get(loginId);
    this.sessions.delete(loginId);
    await session?.browser.close().catch(() => {});
  }
  private async openVerified(connectionId: string, state: BrowserSessionState) {
    const existing = this.sessions.get(connectionId);
    if (existing && existing.browser.isConnected() && !existing.page.isClosed()) return existing.page;
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      storageState: { cookies: state.cookies as never, origins: state.origins as never },
      acceptDownloads: false,
      serviceWorkers: 'block',
    });
    context.setDefaultTimeout(15_000);
    context.setDefaultNavigationTimeout(30_000);
    await context.route('**/*', async (route) => {
      const request = route.request();
      if (request.isNavigationRequest() && !allowedFanqieNavigation(request.url())) {
        await route.abort('blockedbyclient');
        return;
      }
      const url = new URL(request.url());
      if (!['https:', 'data:', 'blob:'].includes(url.protocol)) {
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    this.sessions.set(connectionId, { browser, context, page });
    try {
      await gotoPortal(page, FANQIE_BOOKS);
    } catch (error) {
      await browser.close().catch(() => {});
      this.sessions.delete(connectionId);
      throw error;
    }
    return page;
  }
  async sessionState(connectionId: string): Promise<BrowserSessionState | undefined> {
    const session = this.sessions.get(connectionId);
    if (!session || !session.browser.isConnected() || session.page.isClosed()) return;
    const state = await session.context.storageState();
    return { cookies: state.cookies, origins: state.origins };
  }
  async verifyAccount(connectionId: string, state: BrowserSessionState): Promise<VerifiedAccount> {
    const evidence = await waitForAccount(await this.openVerified(connectionId, state));
    if (!evidence.account) verificationRequired('番茄作者页没有解析到稳定作者身份，请重新人工登录。');
    return evidence.account;
  }
  async listWorks(connectionId: string, state: BrowserSessionState) {
    const page = await this.openVerified(connectionId, state);
    await gotoPortal(page, FANQIE_BOOKS);
    const evidence = await waitForAccount(page);
    if (!evidence.account) verificationRequired('作品页没有解析到稳定作者身份，请重新人工登录。');
    return evidence.works.map((work) => ({
      id: work.id,
      providerId: 'tomato' as const,
      title: work.title,
      description: '',
      genre: '',
      revision: 'verified',
      chapterCount: 0,
      updatedAt: new Date(0).toISOString(),
    }));
  }
  private async workTitle(connectionId: string, state: BrowserSessionState, workId: string) {
    const works = await this.listWorks(connectionId, state);
    const work = works.find((item) => item.id === workId);
    if (!work) throw new PlatformError(404, 'PLATFORM_WORK_NOT_FOUND', '当前账号下找不到选定作品，请重新读取并显式选择。');
    return work.title;
  }
  async listVolumes(connectionId: string, state: BrowserSessionState, workId: string): Promise<FanqieVolume[]> {
    await this.workTitle(connectionId, state, workId);
    const page = await this.openVerified(connectionId, state);
    const data = await readApi(page, '/api/author/volume/volume_list/v1', { book_id: workId });
    if (!Array.isArray(data.volume_list) || data.volume_list.length > 1500) verificationRequired('分卷目录返回格式异常。');
    const seen = new Set<string>();
    return data.volume_list.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) verificationRequired('分卷项目格式异常。');
      const item = value as Record<string, unknown>;
      const id = readIdentifier(item, ['volume_id']);
      if (!id || seen.has(id) || typeof item.volume_name !== 'string' || !item.volume_name.trim() ||
          (item.item_count !== undefined && (typeof item.item_count !== 'number' || !Number.isSafeInteger(item.item_count) || item.item_count < 0)))
        verificationRequired('分卷目录身份缺失或重复。');
      seen.add(id);
      return { id, name: item.volume_name.trim(), ...(item.item_count === undefined ? {} : { itemCount: item.item_count as number }) };
    });
  }
  async listChapters(connectionId: string, state: BrowserSessionState, workId: string, volumeId?: string): Promise<FanqieChapter[]> {
    await this.workTitle(connectionId, state, workId);
    const page = await this.openVerified(connectionId, state);
    const chapterEntries = await readCatalog(page, workId, 'chapter', volumeId);
    const chapters: FanqieChapter[] = [];
    for (const entry of chapterEntries) {
      const metadata = entry.volumeId ? undefined : await readEditMetadata(page, workId, entry.id);
      const chapter = { ...entry, ...(metadata ? { volumeId: metadata.volumeId } : {}) };
      if (!chapter.volumeId) verificationRequired('章节缺少可核验分卷，未确认完整目录。');
      if (!volumeId || chapter.volumeId === volumeId) chapters.push(chapter);
    }
    const draftEntries = await readCatalog(page, workId, 'draft');
    const drafts: FanqieChapter[] = [];
    for (const entry of draftEntries) {
      const metadata = entry.volumeId ? undefined : await readEditMetadata(page, workId, entry.id);
      const draft = { ...entry, ...(metadata ? { volumeId: metadata.volumeId, status: metadata.publishStatus } : {}) };
      if (!draft.volumeId) verificationRequired('草稿缺少可核验分卷，未确认完整目录。');
      if (!volumeId || draft.volumeId === volumeId) drafts.push(draft);
    }
    // A draft can also be represented in chapter_list; the verified draft-list classification wins.
    const draftIds = new Set(draftEntries.map((item) => item.id));
    return [...chapters.filter((item) => !draftIds.has(item.id)), ...drafts];
  }
  private async selectedVolume(connectionId: string, state: BrowserSessionState, workId: string, volumeId?: string) {
    if (!volumeId) return undefined;
    const volumes = await this.listVolumes(connectionId, state, workId);
    const volume = volumes.find((item) => item.id === volumeId);
    if (!volume || volumes.filter((item) => item.name === volume.name).length !== 1)
      verificationRequired('目标分卷不存在或名称不唯一，未写入编辑器。');
    return volume;
  }
  async overwriteDraft(
    connectionId: string, state: BrowserSessionState, accountId: string, workId: string,
    draftId: string, snapshot: DraftSnapshot, volumeId?: string,
  ): Promise<VerifiedDraft> {
    await this.workTitle(connectionId, state, workId);
    const volume = await this.selectedVolume(connectionId, state, workId, volumeId);
    const page = await this.openVerified(connectionId, state);
    const drafts = await readCatalog(page, workId, 'draft');
    if (!drafts.some((item) => item.id === draftId))
      throw new PlatformError(409, 'PLATFORM_OVERWRITE_DRAFT_REQUIRED', '目标不是已确认的草稿；已发布章节不支持覆盖。');
    const metadata = await readEditMetadata(page, workId, draftId);
    if (metadata.publishStatus !== 0) throw new PlatformError(409, 'PLATFORM_OVERWRITE_DRAFT_REQUIRED', '只有明确未发布的草稿允许覆盖。');
    await gotoPortal(page, editorPath(workId, draftId, 'draft_manage_modify'));
    assertEditorRoute(page, workId, draftId);
    const actual = await readEditor(page, workId, draftId);
    const fresh = await readEditMetadata(page, workId, draftId);
    if (actual.accountId !== accountId || fresh.publishStatus !== 0) verificationRequired('草稿作者或发布状态发生变化，未写入。');
    if (volume) await selectVolume(page, volume);
    await fillEditor(page, snapshot);
    await clickSave(page);
    const saved = await this.readDraft(connectionId, state, workId, draftId);
    if (saved.accountId !== accountId || saved.publishStatus !== 0 || !fanqieTitlesEquivalent(saved.title, fanqieSnapshotTitle(snapshot)) ||
        saved.content !== snapshot.content.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').trim() || (volumeId && saved.volumeId !== volumeId))
      throw new PlatformError(409, 'PLATFORM_DRAFT_OVERWRITE_UNVERIFIED', '同一草稿已保存但回读内容或分卷不匹配，结果未知。');
    return saved;
  }
  async createDraft(
    connectionId: string,
    state: BrowserSessionState,
    accountId: string,
    workId: string,
    snapshot: DraftSnapshot,
    onIdentified: (draftId: string) => void,
    volumeId?: string,
  ): Promise<{ draftId: string }> {
    fanqieSnapshotTitle(snapshot);
    const page = await this.openVerified(connectionId, state);
    const title = await this.workTitle(connectionId, state, workId);
    const volume = await this.selectedVolume(connectionId, state, workId, volumeId);
    if ((await readCurrentUser(page)).account?.accountId !== accountId) verificationRequired('当前作者与批准账号不一致，未创建草稿。');
    // Entering the no-ID editor itself creates a remote article. Caller must checkpoint first.
    await gotoPortal(page, editorPath(workId, '', 'draft_manage_create'));
    const createdId = /\/publish\/([^/?#]+)/.exec(new URL(page.url()).pathname)?.[1];
    if (createdId) {
      const identified = decodeURIComponent(createdId);
      assertEditorRoute(page, workId, identified);
      onIdentified(identified);
    }
    if (volume) await selectVolume(page, volume);
    await fillEditor(page, snapshot);
    await clickSave(page);
    const idMatch = /\/publish\/([^/?#]+)/.exec(new URL(page.url()).pathname);
    let draftId = idMatch?.[1] ? decodeURIComponent(idMatch[1]) : '';
    if (draftId) assertEditorRoute(page, workId, draftId);
    if (createdId && draftId !== decodeURIComponent(createdId)) verificationRequired('保存后草稿身份发生变化，结果未知。');
    if (!draftId) {
      const entries = await openDraftList(page, workId, title);
      const matches = entries.filter((entry) => fanqieTitlesEquivalent(entry.title, fanqieSnapshotTitle(snapshot)));
      if (matches.length !== 1)
        throw new PlatformError(409, 'PLATFORM_DRAFT_ID_UNKNOWN', '草稿已提交但未找到唯一远端草稿 ID，结果未知，请到作者页核对。');
      draftId = matches[0].id;
    }
    if (!draftId || !accountId) verificationRequired('保存后未获得稳定的账号或草稿身份。');
    onIdentified(draftId);
    if (volumeId) {
      const metadata = await readEditMetadata(page, workId, draftId);
      if (metadata.volumeId !== volumeId || metadata.publishStatus !== 0)
        throw new PlatformError(409, 'PLATFORM_DRAFT_VOLUME_UNVERIFIED', '草稿已保存但分卷回读不匹配，结果未知。');
    }
    return { draftId };
  }
  async readDraft(
    connectionId: string,
    state: BrowserSessionState,
    workId: string,
    draftId: string,
  ): Promise<VerifiedDraft> {
    const page = await this.openVerified(connectionId, state);
    await gotoPortal(page, editorPath(workId, draftId, 'draft_manage_modify'));
    assertEditorRoute(page, workId, draftId);
    const metadata = await readEditMetadata(page, workId, draftId);
    return { ...await readEditor(page, workId, draftId), ...metadata };
  }
  async findDrafts(
    connectionId: string,
    state: BrowserSessionState,
    accountId: string,
    workId: string,
    snapshot: DraftSnapshot,
  ): Promise<VerifiedDraft[]> {
    const page = await this.openVerified(connectionId, state);
    const title = await this.workTitle(connectionId, state, workId);
    const entries = await openDraftList(page, workId, title);
    const drafts: VerifiedDraft[] = [];
    for (const entry of entries) {
      const actual = await this.readDraft(connectionId, state, workId, entry.id);
      if (actual.accountId === accountId && fanqieTitlesEquivalent(actual.title, fanqieSnapshotTitle(snapshot))) drafts.push(actual);
    }
    return drafts;
  }
  async deleteDraft(connectionId: string, state: BrowserSessionState, workId: string, draftId: string) {
    const page = await this.openVerified(connectionId, state);
    const title = await this.workTitle(connectionId, state, workId);
    const entries = await openDraftList(page, workId, title);
    const index = entries.findIndex((entry) => entry.id === draftId);
    if (index < 0) return;
    const target = page.locator('a').filter({ has: page.locator('.auto-editor-draft-edit') }).filter({ hasText: entries[index].title }).first();
    const anchor = (await target.count()) ? target : page.locator(`a[href="${entries[index].href}"]`).first();
    if (!(await anchor.count()))
      throw new PlatformError(502, 'PLATFORM_DRAFT_DOM_MISMATCH', '未找到目标草稿链接，未执行删除。');
    let row = anchor.locator('xpath=ancestor::tr[1]');
    if (!(await row.count())) row = anchor.locator('xpath=ancestor::*[contains(@class,"table-row")][1]');
    if (!(await row.count())) throw new PlatformError(502, 'PLATFORM_DRAFT_DOM_MISMATCH', '未找到目标草稿所在的列表行，未执行删除。');
    const remove = row.locator('.tomato-delete').first();
    if (!(await remove.count()) || !(await remove.isVisible().catch(() => false)))
      throw new PlatformError(502, 'PLATFORM_DRAFT_DOM_MISMATCH', '未找到目标草稿的删除操作，未执行删除。');
    await remove.click();
    const confirm = page.getByRole('button', { name: /^删除$/ }).last();
    if (!(await confirm.count()) || !(await confirm.isVisible().catch(() => false)))
      throw new PlatformError(502, 'PLATFORM_DRAFT_DELETE_CONFIRM_MISSING', '删除确认框未出现，未执行删除。');
    await confirm.click();
    await page.waitForTimeout(1200);
    const remaining = await openDraftList(page, workId, title);
    if (remaining.some((entry) => entry.id === draftId))
      throw new PlatformError(409, 'PLATFORM_DRAFT_DELETE_UNVERIFIED', '删除请求已完成但远端列表仍有该草稿，结果未知。');
  }
  async verifyReviewReceipt(
    connectionId: string, state: BrowserSessionState, accountId: string,
    workId: string, draftId: string, snapshot: DraftSnapshot,
  ): Promise<boolean> {
    const page = await this.openVerified(connectionId, state);
    await this.workTitle(connectionId, state, workId);
    if ((await readCurrentUser(page)).account?.accountId !== accountId)
      verificationRequired('当前作者与送审批准账号不一致，未确认送审回执。');
    const entries = await readCatalog(page, workId, 'chapter', undefined, true);
    // Same code=0 / item_id / title / immediate display_status proof as submitReview.
    return reviewReceiptMatches(JSON.stringify({ code: 0, data: { item_list: entries.map((entry) => ({
      item_id: entry.id, title: entry.title, display_status: entry.status,
    })) } }), draftId, fanqieSnapshotTitle(snapshot));
  }
  async submitReview(
    connectionId: string, state: BrowserSessionState, accountId: string,
    workId: string, draftId: string, snapshot: DraftSnapshot, useAi?: 1 | 2,
  ): Promise<void> {
    if (useAi !== 1 && useAi !== 2)
      throw new PlatformError(400, 'PLATFORM_AI_DECLARATION_REQUIRED', '送审需要用户明确选择是否使用 AI。');
    const page = await this.openVerified(connectionId, state);
    const workTitle = await this.workTitle(connectionId, state, workId);
    const expectedEditor = editorPath(workId, draftId, 'draft_manage_modify');
    await gotoPortal(page, expectedEditor);
    if (new URL(page.url()).pathname !== new URL(expectedEditor).pathname)
      verificationRequired('编辑器跳转到了不同作品或草稿，未执行送审。');
    const actual = await readEditor(page, workId, draftId);
    const accountMatches = actual.accountId === accountId;
    const titleMatches = fanqieTitlesEquivalent(actual.title, fanqieSnapshotTitle(snapshot));
    const contentMatches = actual.content === snapshot.content.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').trim();
    if (!accountMatches || !titleMatches || !contentMatches)
      throw new PlatformError(409, 'PLATFORM_REVIEW_DRAFT_MISMATCH', `账号、标题或正文与已批准的草稿不一致，未执行送审（account_match=${accountMatches}; title_match=${titleMatches}; content_match=${contentMatches}）。`);
    const unexpectedDialog = async () => page.locator('.arco-modal:visible, [role="dialog"]:visible').evaluateAll(
      (nodes) => nodes.some((node) => !node.matches('.publish-confirm-container-new') &&
        !node.closest('.publish-confirm-container-new') && !node.querySelector('.publish-confirm-container-new')),
    );
    if (await unexpectedDialog()) verificationRequired('编辑器存在未核验对话框，未执行送审。');
    const next = page.locator('.publish-button.auto-editor-next').filter({ hasText: /^下一步$/ });
    if (await next.count() !== 1 || !await next.isVisible() || await next.isDisabled())
      verificationRequired('未找到唯一可用的“下一步”，未执行送审。');
    await next.click();
    const modal = page.locator('.publish-confirm-container-new:visible');
    await modal.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => verificationRequired('发布设置未出现；不会自动确认错别字、风险或授权提示。'));
    if (await modal.count() !== 1 || await unexpectedDialog() ||
        await modal.getByText('发布设置', { exact: true }).count() !== 1)
      verificationRequired('发布设置结构不唯一或存在额外对话框，未执行送审。');
    if (await modal.locator('.publish-confirm-audit-alert:visible, .publish-confirm-default-book-cover, .publish-confirm-default-book-name-help').count())
      verificationRequired('发布设置包含审核风险提示或默认作品资料修改，需人工处理。');
    const ai = modal.locator('.card-content-line').filter({ has: page.locator('.card-content-line-label').filter({ hasText: /^是否使用AI/ }) });
    const radio = ai.getByRole('radio', { name: useAi === 1 ? '是' : '否', exact: true });
    if (await ai.count() !== 1 || await radio.count() !== 1 || await radio.getAttribute('value') !== String(useAi))
      verificationRequired('无法核验 AI 声明选项，未执行送审。');
    await radio.check();
    const schedule = modal.locator('.card-content-line').filter({ has: page.locator('.card-content-line-label').filter({ hasText: /^定时发布/ }) });
    const timer = schedule.getByRole('switch');
    if (await schedule.count() !== 1 || await timer.count() !== 1 || await timer.getAttribute('aria-checked') !== 'false')
      verificationRequired('无法确认定时发布已关闭，未执行送审。');
    // Never tick consent/declarations or accept extra warnings on the user's behalf.
    if (await modal.getByRole('checkbox').count() || await unexpectedDialog())
      verificationRequired('发布设置出现额外声明或风险确认，需人工处理。');
    if (!await radio.isChecked()) verificationRequired('AI 声明没有保留，未执行送审。');
    const confirm = modal.getByRole('button', { name: /^(确认发布|确认提交)$/ });
    if (await confirm.count() !== 1 || await confirm.isDisabled()) verificationRequired('没有唯一可用的最终送审按钮。');
    // Observe only the official chapter-list GET response, never a write API or toast.
    // Register before clicking so a fast receipt cannot be missed; no retries of the final click.
    const receipt = page.waitForResponse((response) => {
      try {
        const url = new URL(response.url());
        return allowedFanqieNavigation(url.href) && url.pathname === '/api/author/chapter/chapter_list/v1' &&
          url.searchParams.get('book_id') === workId && response.request().method() === 'GET' && response.ok();
      } catch { return false; }
    }, { timeout: 10_000 }).then(async (response) =>
      reviewReceiptMatches(await response.text(), draftId, fanqieSnapshotTitle(snapshot)),
    ).catch(() => false);
    await confirm.click();
    await page.waitForTimeout(1200);
    if (await unexpectedDialog() || await modal.locator('.publish-confirm-audit-alert:visible').count()) {
      // Settle the observer without ever confirming a second warning.
      void receipt;
      throw new PlatformError(409, 'PLATFORM_REVIEW_UNVERIFIED', '提交后出现额外提示，未自动接受，送审结果未知。');
    }
    await gotoPortal(page, workPath(workId, workTitle));
    const verified = await receipt;
    if (!verified)
      throw new PlatformError(409, 'PLATFORM_REVIEW_UNVERIFIED', '未获得匹配作品、草稿 ID、标题和即时送审状态的章节列表回执，结果未知；请人工核对，勿盲目重试。');
  }
  async closeConnection(connectionId: string) {
    const session = this.sessions.get(connectionId);
    this.sessions.delete(connectionId);
    await session?.browser.close().catch(() => {});
  }
  async close() {
    this.stopped = true;
    await Promise.all([...this.sessions.keys()].map((id) => this.closeLogin(id)));
  }
}
