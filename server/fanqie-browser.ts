import type { Browser, BrowserContext, Page } from 'playwright';
import type { DraftSnapshot } from '../shared/platforms.js';
import {
  PlatformError,
  type BrowserSessionState,
  type DraftBrowserAdapter,
  type VerifiedAccount,
  type VerifiedDraft,
} from './platforms-types.js';

export const FANQIE_PORTAL = 'https://fanqienovel.com/main/writer/';
export const FANQIE_VERIFICATION_REASON =
  '账号和作品身份已可核验，但草稿编辑器与回读定位仍未开放。连接成功不会自动填写正文。';
const IDENTITY_KEYS = ['authorId', 'author_id', 'userId', 'user_id', 'uid'];
const WORK_LIST_KEYS = ['bookList', 'books', 'works', 'workList', 'novelList'];
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

function readString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && /^[A-Za-z0-9_-]{2,80}$/.test(value)) return value;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  }
  return '';
}
function findAccount(value: unknown, seen = new Set<unknown>()): VerifiedAccount | undefined {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAccount(item, seen);
      if (found) return found;
    }
    return;
  }
  const record = value as Record<string, unknown>;
  const accountId = readString(record, IDENTITY_KEYS);
  const accountName = readString(record, ['authorName', 'nickName', 'nickname', 'name', 'userName']);
  if (accountId && accountName) return { accountId, accountName };
  for (const item of Object.values(record)) {
    const found = findAccount(item, seen);
    if (found) return found;
  }
}
function findWorks(value: unknown, seen = new Set<unknown>()): { id: string; title: string }[] {
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap((item) => findWorks(item, seen));
  const record = value as Record<string, unknown>;
  for (const key of WORK_LIST_KEYS) {
    const list = record[key];
    if (!Array.isArray(list)) continue;
    const works = list.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const work = item as Record<string, unknown>;
      const id = readString(work, ['bookId', 'book_id', 'workId', 'id']);
      const title =
        typeof work.title === 'string'
          ? work.title.trim()
          : typeof work.bookName === 'string'
            ? work.bookName.trim()
            : typeof work.name === 'string'
              ? work.name.trim()
              : '';
      return id && title ? [{ id, title: title.slice(0, 120) }] : [];
    });
    if (works.length) return works;
  }
  return Object.values(record).flatMap((item) => findWorks(item, seen));
}
async function readPageIdentity(page: Page) {
  const payloads = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('script')].map((node) => node.textContent || '');
    const globals = ['__NEXT_DATA__', '__INITIAL_STATE__', '__DATA__'].flatMap((key) => {
      const value = (window as unknown as Record<string, unknown>)[key];
      return value ? [JSON.stringify(value).slice(0, 2_000_000)] : [];
    });
    return [...nodes, ...globals].filter((item) => item.length > 20 && item.length < 2_000_000);
  });
  let account: VerifiedAccount | undefined;
  let works: { id: string; title: string }[] = [];
  for (const payload of payloads) {
    const start = payload.indexOf('{');
    const end = payload.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(payload.slice(start, end + 1));
      account ||= findAccount(parsed);
      if (!works.length) works = findWorks(parsed);
    } catch {
      /* Embedded scripts can contain non-JSON; identity must come from a parseable payload. */
    }
  }
  if (!account) return verificationRequired();
  return { account, works };
}

function verificationRequired(): never {
  throw new PlatformError(503, 'PLATFORM_DOM_VERIFICATION_REQUIRED', FANQIE_VERIFICATION_REASON);
}

/**
 * Production boundary deliberately fails closed. Only the public writer portal is evidenced.
 * No authenticated DOM selectors, private APIs, remote success, or login identities are invented.
 * Runtime tests inject DraftBrowserAdapter; that never changes this production capability gate.
 */
export class FanqieBrowser implements DraftBrowserAdapter {
  readonly readiness = 'ready' as const;
  readonly reason = FANQIE_VERIFICATION_REASON;
  private sessions = new Map<string, { browser: Browser; context: BrowserContext; page: Page }>();
  private stopped = false;

  async startLogin(loginId: string) {
    if (this.stopped) throw new PlatformError(503, 'PLATFORM_CLOSING', '平台服务正在关闭。');
    if (this.sessions.size)
      throw new PlatformError(409, 'PLATFORM_LOGIN_BUSY', '请先完成或关闭当前人工登录窗口。');
    let browser: Browser | undefined;
    try {
      // No startup launch, persistent profile, trace, HAR, screenshot, passwords, or state path.
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
        // A portal must never turn the local browser into an intranet/localhost proxy.
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
      this.sessions.set(loginId, { browser, context, page });
      context.on('page', (popup) => {
        // Unverified popup/login origins are not silently adopted as account evidence.
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
      // Raw Playwright errors can contain URLs/query tokens. Never expose/log them.
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
    if (!allowedFanqieNavigation(session.page.url()))
      throw new PlatformError(
        409,
        'PLATFORM_LOGIN_ORIGIN_UNVERIFIED',
        '登录后的页面不在已核验的番茄域名内，未保存会话。',
      );
    const identity = await readPageIdentity(session.page);
    const state = await session.context.storageState();
    return { account: identity.account, state: { cookies: state.cookies, origins: state.origins } };
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
    const page = await context.newPage();
    this.sessions.set(connectionId, { browser, context, page });
    await page.goto(FANQIE_PORTAL, { waitUntil: 'domcontentloaded' });
    if (!allowedFanqieNavigation(page.url()))
      throw new PlatformError(
        409,
        'PLATFORM_LOGIN_ORIGIN_UNVERIFIED',
        '会话跳转到了未核验域名，请重新人工登录。',
      );
    return page;
  }
  async verifyAccount(connectionId: string, state: BrowserSessionState): Promise<VerifiedAccount> {
    return (await readPageIdentity(await this.openVerified(connectionId, state))).account;
  }
  async listWorks(connectionId: string, state: BrowserSessionState) {
    const works = (await readPageIdentity(await this.openVerified(connectionId, state))).works;
    return works.map((work) => ({
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
  async createDraft(
    _connectionId: string,
    _state: BrowserSessionState,
    _accountId: string,
    _workId: string,
    _snapshot: DraftSnapshot,
    _onIdentified: (draftId: string) => void,
  ): Promise<{ draftId: string }> {
    throw new PlatformError(
      501,
      'PLATFORM_DRAFT_DOM_UNVERIFIED',
      '草稿编辑器定位尚未核验，已连接账号不会自动填写正文。',
    );
  }
  async readDraft(
    _connectionId: string,
    _state: BrowserSessionState,
    _workId: string,
    _draftId: string,
  ): Promise<VerifiedDraft> {
    return verificationRequired();
  }
  async findDrafts(
    _connectionId: string,
    _state: BrowserSessionState,
    _accountId: string,
    _workId: string,
    _snapshot: DraftSnapshot,
  ): Promise<VerifiedDraft[]> {
    return verificationRequired();
  }
  async closeConnection(_connectionId: string) {
    /* No verified production connections can exist yet. */
  }
  async close() {
    this.stopped = true;
    await Promise.all([...this.sessions.keys()].map((id) => this.closeLogin(id)));
  }
}
