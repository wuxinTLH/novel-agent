import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Chapter } from '../shared/types.js';
import type {
  DraftOperation,
  DraftPreparation,
  DraftReceipt,
  DraftSnapshot,
  PlatformConnection,
  PlatformLogin,
  PlatformSession,
  PlatformWork,
} from '../shared/platforms.js';
import type { Store } from './store.js';
import { PlatformStore, type ConnectionRecord, type DraftOperationRecord } from './platform-store.js';
import { SecretStore } from './secrets.js';
import { createPlatformRegistry } from './platform-registry.js';
import { FanqieBrowser } from './fanqie-browser.js';
import { ExtensionBridge } from './extension-bridge.js';
import { literalIssues, resolveRequirements } from './generation.js';
import {
  PlatformError,
  type BrowserSessionState,
  type DraftBrowserAdapter,
  type VerifiedDraft,
} from './platforms-types.js';

export const draftHash = (title: string, content: string) =>
  createHash('sha256')
    .update(JSON.stringify([title, content]))
    .digest('hex');
export const draftParagraphs = (content: string) => content.replace(/\r\n?/g, '\n').split('\n');
const now = () => new Date().toISOString();
const businessHash = (values: unknown[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
export function publicOperation(record: DraftOperationRecord): DraftOperation {
  const {
    snapshot: _snapshot,
    businessKey: _businessKey,
    preparationId: _preparationId,
    requestKeys: _keys,
    ...value
  } = record;
  return value;
}
export interface PlatformRuntimeOptions {
  browser?: DraftBrowserAdapter;
}

/** One instance per application; owns all platform state, browser sessions and task locks. */
export class PlatformRuntime {
  readonly csrfToken = randomBytes(32).toString('hex');
  readonly extension = new ExtensionBridge();
  readonly browser: DraftBrowserAdapter;
  readonly registry: ReturnType<typeof createPlatformRegistry>;
  private platformStore?: PlatformStore;
  private secretStore?: SecretStore;
  private unavailableReason?: string;
  private projectLocks = new Set<string>();
  private accountLocks = new Set<string>();
  private logins = new Map<string, PlatformLogin>();
  private loginTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private tasks = new Set<Promise<void>>();
  private loginStarting = false;
  private closing = false;

  constructor(
    readonly store: Store,
    options: PlatformRuntimeOptions = {},
  ) {
    this.browser = options.browser ?? new FanqieBrowser();
    try {
      // Validate encryption before doing any platform migration; wrong keys preserve both files.
      this.secretStore = new SecretStore(store.dir);
      this.platformStore = new PlatformStore(store.dir);
    } catch {
      this.unavailableReason =
        '平台存储或密钥不可用，请检查 PLATFORM_SECRETS_KEY 与数据文件；原文件不会被覆盖。写作功能仍可使用。';
    }
    this.registry = createPlatformRegistry(this.platformStore, this.browser);
  }
  get platforms() {
    if (!this.platformStore)
      throw new PlatformError(503, 'PLATFORM_STORAGE_UNAVAILABLE', this.unavailableReason!);
    return this.platformStore;
  }
  get secrets() {
    if (!this.secretStore || this.unavailableReason)
      throw new PlatformError(503, 'PLATFORM_STORAGE_UNAVAILABLE', this.unavailableReason!);
    return this.secretStore;
  }
  status(): PlatformSession {
    return {
      csrfToken: this.csrfToken,
      available: !this.unavailableReason && !this.closing,
      persistentCredentials: this.secretStore?.persistent ?? false,
      reason: this.unavailableReason,
      legacyArchived: this.platformStore?.legacyArchived ?? false,
      browser: {
        readiness: this.browser.readiness,
        reason: this.browser.reason,
        manualLogin: !this.closing && !this.unavailableReason,
      },
    };
  }
  isProjectBusy(projectId: string) {
    return (
      this.projectLocks.has(projectId) ||
      [...this.logins.values()].some(
        (login) =>
          login.projectId === projectId &&
          ['waiting', 'needs_verification'].includes(login.status) &&
          Date.parse(login.expiresAt) > Date.now() &&
          this.browser.loginOpen(login.id),
      )
    );
  }
  assertProjectIdle(projectId: string) {
    if (this.isProjectBusy(projectId))
      throw new PlatformError(409, 'PLATFORM_BUSY', '平台任务或人工登录正在进行，请先结束任务或关闭登录。');
  }
  private assertWritable(projectId: string) {
    if (this.closing) throw new PlatformError(503, 'PLATFORM_CLOSING', '平台服务正在关闭。');
    if (!this.status().available)
      throw new PlatformError(503, 'PLATFORM_STORAGE_UNAVAILABLE', this.unavailableReason!);
    const project = this.store.get(projectId);
    if (!project) throw new PlatformError(404, 'PROJECT_NOT_FOUND', '项目不存在。');
    if (project.run?.status === 'running')
      throw new PlatformError(409, 'PROJECT_RUNNING', '工作流运行期间不能进行平台操作。');
  }
  private accountKey(record: ConnectionRecord) {
    return `${record.providerId}:${record.accountId}`;
  }
  private acquire(projectId: string, record?: ConnectionRecord, completingLoginId?: string) {
    this.assertWritable(projectId);
    const key = record ? this.accountKey(record) : undefined;
    const activeLogin = [...this.logins.values()].some(
      (login) =>
        login.id !== completingLoginId &&
        ['waiting', 'needs_verification'].includes(login.status) &&
        Date.parse(login.expiresAt) > Date.now() &&
        this.browser.loginOpen(login.id),
    );
    if (
      this.loginStarting ||
      this.projectLocks.has(projectId) ||
      (key && this.accountLocks.has(key)) ||
      activeLogin
    )
      throw new PlatformError(
        409,
        'PLATFORM_BUSY',
        '该项目或账号有平台操作或人工登录正在进行，请先结束再继续。',
      );
    this.projectLocks.add(projectId);
    if (key) this.accountLocks.add(key);
    return () => {
      this.projectLocks.delete(projectId);
      if (key) this.accountLocks.delete(key);
    };
  }
  async withLock<T>(
    projectId: string,
    record: ConnectionRecord | undefined,
    fn: () => Promise<T>,
    completingLoginId?: string,
  ): Promise<T> {
    const release = this.acquire(projectId, record, completingLoginId);
    const operation = Promise.resolve().then(fn);
    const settled = operation.then(
      () => {},
      () => {},
    );
    this.tasks.add(settled);
    try {
      return await operation;
    } finally {
      release();
      this.tasks.delete(settled);
    }
  }
  connection(projectId: string, id: string) {
    const record = this.platforms.connection(projectId, id);
    if (!record)
      throw new PlatformError(
        404,
        'PLATFORM_CONNECTION_NOT_FOUND',
        '平台连接不存在；旧番茄模拟连接已归档，不能用于真实平台。',
      );
    return record;
  }
  publicConnection(record: ConnectionRecord): PlatformConnection {
    const hasCredential = this.secrets.has(record.credentialRef);
    return {
      id: record.id,
      projectId: record.projectId,
      providerId: record.providerId,
      accountId: record.accountId,
      accountName: record.accountName,
      createdAt: record.createdAt,
      lastCheckedAt: record.lastCheckedAt,
      capabilities: record.capabilities,
      hasCredential,
      status:
        !hasCredential || record.needsReauth
          ? 'needs_reauth'
          : record.providerId === 'tomato' && this.browser.readiness !== 'ready'
            ? 'needs_verification'
            : 'connected',
    };
  }
  credential(record: ConnectionRecord) {
    const token = this.secrets.get(record.credentialRef);
    if (!token || record.needsReauth)
      throw new PlatformError(
        401,
        'PLATFORM_REAUTH_REQUIRED',
        '会话缺失或已过期，请在原连接下重新人工登录。',
      );
    return { token };
  }
  private state(record: ConnectionRecord): BrowserSessionState {
    if (record.providerId !== 'tomato' || record.authKind !== 'manual_browser')
      throw new PlatformError(409, 'PLATFORM_IDENTITY_INVALID', '该连接不是已核验的浏览器账号。');
    try {
      const parsed = JSON.parse(this.credential(record).token);
      if (
        parsed.version !== 1 ||
        !Array.isArray(parsed.state?.cookies) ||
        !Array.isArray(parsed.state?.origins)
      )
        throw new Error();
      return parsed.state;
    } catch {
      throw new PlatformError(
        401,
        'PLATFORM_REAUTH_REQUIRED',
        '浏览器会话缺失或无效，请重新人工登录；无需粘贴 Cookie。',
      );
    }
  }
  private requireBrowser() {
    if (this.browser.readiness !== 'ready')
      throw new PlatformError(503, 'PLATFORM_DOM_VERIFICATION_REQUIRED', this.browser.reason);
  }
  private async verify(record: ConnectionRecord, state: BrowserSessionState) {
    try {
      const account = await this.browser.verifyAccount(record.id, state);
      if (!account.accountId || account.accountId !== record.accountId)
        throw new PlatformError(
          409,
          'PLATFORM_ACCOUNT_MISMATCH',
          '浏览器账号与绑定账号不同。请关闭窗口，以原账号重新登录；若需更换账号，请新建连接并显式重新绑定。',
        );
    } catch (error) {
      if (
        error instanceof PlatformError &&
        ['PLATFORM_REAUTH_REQUIRED', 'PLATFORM_ACCOUNT_MISMATCH'].includes(error.code)
      ) {
        this.platforms.putConnection({ ...record, needsReauth: true });
        await this.browser.closeConnection(record.id);
      }
      throw error;
    }
  }
  async listWorks(record: ConnectionRecord): Promise<PlatformWork[]> {
    if (record.providerId !== 'tomato')
      return this.registry.get(record.providerId).listWorks(this.credential(record), record.id);
    const state = this.state(record);
    await this.verify(record, state);
    const works = await this.browser.listWorks(record.id, state);
    if (
      works.some((work) => work.providerId !== 'tomato' || !work.id || !work.title) ||
      new Set(works.map((work) => work.id)).size !== works.length
    )
      throw new PlatformError(
        502,
        'PLATFORM_DOM_MISMATCH',
        '作品页身份或条目不唯一，请停止操作并重新核验页面。',
      );
    return works;
  }
  async work(record: ConnectionRecord, workId: string) {
    const work = (await this.listWorks(record)).find((item) => item.id === workId);
    if (!work)
      throw new PlatformError(
        404,
        'PLATFORM_WORK_NOT_FOUND',
        '当前账号下找不到选定作品，请重新读取并显式选择。',
      );
    return work;
  }
  async testConnection(record: ConnectionRecord) {
    if (record.providerId === 'tomato') {
      await this.verify(record, this.state(record));
    } else await this.registry.get(record.providerId).connect(this.credential(record));
    const next = { ...record, lastCheckedAt: now(), needsReauth: false };
    this.platforms.putConnection(next);
    return this.publicConnection(next);
  }
  async startLogin(projectId: string, connectionId?: string) {
    this.assertWritable(projectId);
    this.assertProjectIdle(projectId);
    const record = connectionId ? this.connection(projectId, connectionId) : undefined;
    if (record && record.providerId !== 'tomato')
      throw new PlatformError(400, 'PLATFORM_LOGIN_INVALID', '此登录入口仅适用于番茄浏览器账号。');
    if (this.loginStarting || this.accountLocks.size || this.projectLocks.size)
      throw new PlatformError(409, 'PLATFORM_LOGIN_BUSY', '有平台操作正在进行，请完成后再开始人工登录。');
    const operation = this.withLock(projectId, record, async () => {
      const login: PlatformLogin = {
        id: randomUUID(),
        projectId,
        connectionId,
        status: 'waiting',
        createdAt: now(),
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        message: '请在独立浏览器内自行登录，不要在应用中输入密码或 Cookie。登录不代表账号验证已完成。',
      };
      await this.browser.startLogin(login.id);
      this.logins.set(login.id, login);
      const timer = setTimeout(() => {
        const current = this.logins.get(login.id);
        if (current && ['waiting', 'needs_verification'].includes(current.status)) {
          current.status = 'closed';
          current.message = '登录已超时，隔离浏览器已关闭；请重新开始。';
          void this.browser.closeLogin(login.id).catch(() => {});
        }
        this.loginTimers.delete(login.id);
      }, 15 * 60_000);
      timer.unref();
      this.loginTimers.set(login.id, timer);
      return login;
    });
    this.loginStarting = true;
    try {
      return await operation;
    } finally {
      this.loginStarting = false;
    }
  }
  login(projectId: string, loginId: string) {
    const login = this.logins.get(loginId);
    if (!login || login.projectId !== projectId)
      throw new PlatformError(404, 'PLATFORM_LOGIN_NOT_FOUND', '本次登录不存在或服务已重启，请重新开始。');
    if (
      ['waiting', 'needs_verification'].includes(login.status) &&
      (Date.parse(login.expiresAt) <= Date.now() || !this.browser.loginOpen(loginId))
    ) {
      login.status = 'closed';
      login.message = '登录已超时或浏览器已关闭，请重新开始。';
      void this.browser.closeLogin(loginId).catch(() => {});
    }
    return structuredClone(login);
  }
  async completeLogin(projectId: string, loginId: string) {
    const login = this.login(projectId, loginId);
    if (!['waiting', 'needs_verification'].includes(login.status))
      throw new PlatformError(410, 'PLATFORM_LOGIN_CLOSED', '本次登录已结束，请重新开始。');
    const previous = login.connectionId ? this.connection(projectId, login.connectionId) : undefined;
    return this.withLock(
      projectId,
      previous,
      async () => {
        let result: Awaited<ReturnType<DraftBrowserAdapter['completeLogin']>>;
        try {
          result = await this.browser.completeLogin(loginId);
        } catch (error) {
          if (error instanceof PlatformError && error.code === 'PLATFORM_DOM_VERIFICATION_REQUIRED')
            this.logins.set(loginId, { ...login, status: 'needs_verification', message: error.message });
          throw error;
        }
        if (this.login(login.projectId, login.id).status === 'closed' || this.closing)
          throw new PlatformError(410, 'PLATFORM_LOGIN_CLOSED', '登录已经结束，未保存会话；请重新开始。');
        if (
          !result.account.accountId?.trim() ||
          !result.account.accountName?.trim() ||
          !Array.isArray(result.state.cookies) ||
          !Array.isArray(result.state.origins)
        )
          throw new PlatformError(
            502,
            'PLATFORM_IDENTITY_INVALID',
            '页面没有已核验的稳定作者身份，未保存会话。',
          );
        if (previous && previous.accountId !== result.account.accountId)
          throw new PlatformError(
            409,
            'PLATFORM_ACCOUNT_MISMATCH',
            '本次登录账号与原连接不同；不会改写绑定。请使用原账号，或取消后新建连接。',
          );
        const duplicate = this.platforms
          .connections(projectId)
          .find(
            (item) =>
              item.providerId === 'tomato' &&
              item.accountId === result.account.accountId &&
              item.id !== previous?.id,
          );
        if (duplicate)
          throw new PlatformError(
            409,
            'PLATFORM_ACCOUNT_EXISTS',
            '该账号已有连接，请取消并在原连接下重新登录。',
          );
        const record: ConnectionRecord = {
          id: previous?.id ?? randomUUID(),
          projectId,
          providerId: 'tomato',
          ...result.account,
          capabilities: { paired: true, accountVerified: true, listWorks: true, saveDraft: false },
          createdAt: previous?.createdAt ?? now(),
          lastCheckedAt: now(),
          authKind: 'manual_browser',
          credentialRef: randomUUID(),
          needsReauth: false,
        };
        // Stage a new encrypted value, then atomically publish the reference; preserve old creds on disk errors.
        this.secrets.set(record.credentialRef, JSON.stringify({ version: 1, state: result.state }));
        try {
          this.platforms.putConnection(record);
        } catch (error) {
          this.secrets.delete(record.credentialRef);
          throw error;
        }
        if (previous) this.secrets.delete(previous.credentialRef);
        this.logins.set(loginId, { ...login, status: 'completed', message: '账号身份已核验，会话已保存。' });
        clearTimeout(this.loginTimers.get(loginId));
        this.loginTimers.delete(loginId);
        await this.browser.closeLogin(loginId);
        return this.publicConnection(record);
      },
      loginId,
    );
  }
  async cancelLogin(projectId: string, loginId: string) {
    const login = this.login(projectId, loginId);
    if (this.projectLocks.has(projectId))
      throw new PlatformError(409, 'PLATFORM_BUSY', '登录验证正在进行，请稍后再关闭。');
    await this.browser.closeLogin(loginId);
    clearTimeout(this.loginTimers.get(loginId));
    this.loginTimers.delete(loginId);
    this.logins.set(loginId, { ...login, status: 'closed', message: '人工登录已关闭；没有上传章节。' });
  }
  private snapshot(projectId: string, chapterId: string): DraftSnapshot {
    const project = this.store.get(projectId);
    const chapter = project?.chapters.find((item) => item.id === chapterId);
    if (!project || !chapter)
      throw new PlatformError(404, 'CHAPTER_NOT_FOUND', '请选择已保存的正式本地章节；候选稿不能同步。');
    if (
      !Number.isSafeInteger(chapter.number) ||
      chapter.number < 1 ||
      !Number.isSafeInteger(chapter.revision) ||
      chapter.revision < 1 ||
      !chapter.title.trim() ||
      !chapter.content.trim()
    )
      throw new PlatformError(400, 'CHAPTER_INVALID', '章节号、版本、标题或正文无效，请先保存有效章节。');
    if (chapter.content.length > 500_000 || chapter.title.length > 300)
      throw new PlatformError(
        400,
        'CHAPTER_TOO_LARGE',
        '章节超出草稿预览安全上限（标题 300 字，正文 500000 字），请先拆分。',
      );
    let issues: string[];
    try {
      issues = literalIssues(chapter.content, resolveRequirements(project, chapter.number));
    } catch {
      throw new PlatformError(
        400,
        'CHAPTER_REQUIREMENTS_INVALID',
        '当前创作要求有冲突或超限，请先修正再同步。',
      );
    }
    if (issues.length)
      throw new PlatformError(
        409,
        'CHAPTER_REQUIREMENTS_FAILED',
        `正文未通过原文要求检查：${issues.join('；')}`,
      );
    return {
      chapterId,
      number: chapter.number,
      revision: chapter.revision,
      title: chapter.title,
      content: chapter.content,
      paragraphs: draftParagraphs(chapter.content),
      contentHash: draftHash(chapter.title, chapter.content),
    };
  }
  chapterChoices(projectId: string) {
    return (this.store.get(projectId)?.chapters ?? []).map((chapter: Chapter) => ({
      id: chapter.id,
      number: chapter.number,
      revision: chapter.revision,
      title: chapter.title,
      updatedAt: chapter.updatedAt,
      contentHash: draftHash(chapter.title, chapter.content),
    }));
  }
  private priorDraft(accountId: string, workId: string, chapterId: string) {
    return this.platforms
      .draftOperations()
      .filter(
        (operation) =>
          operation.providerId === 'tomato' &&
          operation.accountId === accountId &&
          operation.remoteWorkId === workId &&
          operation.chapterId === chapterId &&
          (operation.mutationStarted ||
            ['queued', 'running', 'unknown', 'verified'].includes(operation.state)),
      );
  }
  async prepare(projectId: string, linkId: string, chapterId: string): Promise<DraftPreparation> {
    this.assertWritable(projectId);
    const link = this.platforms.links(projectId).find((item) => item.id === linkId);
    if (!link) throw new PlatformError(404, 'PLATFORM_LINK_NOT_FOUND', '请明确选择已绑定的作品。');
    const record = this.connection(projectId, link.connectionId);
    if (record.providerId !== 'tomato')
      throw new PlatformError(
        501,
        'PLATFORM_CAPABILITY_UNSUPPORTED',
        'Mock 不产生真实草稿；请选择已核验番茄账号。',
      );
    this.requireBrowser();
    return this.withLock(projectId, record, async () => {
      if (record.accountId !== link.accountId)
        throw new PlatformError(409, 'PLATFORM_ACCOUNT_MISMATCH', '绑定身份已变化，请重新显式绑定。');
      const snapshot = this.snapshot(projectId, chapterId);
      const previous = this.priorDraft(record.accountId, link.remoteWorkId, chapterId);
      if (
        previous.some(
          (operation) =>
            operation.contentHash !== snapshot.contentHash || operation.revision !== snapshot.revision,
        )
      )
        throw new PlatformError(
          409,
          'PLATFORM_DRAFT_UPDATE_BLOCKED',
          '此章节已有草稿或结果未知，当前版本有变化。尚未核验安全更新能力，禁止另建重复草稿；请先核对原草稿并在作者页面处理。',
        );
      const work = await this.work(record, link.remoteWorkId); // Read-only before approval; never enter an editor.
      const preparation: DraftPreparation = {
        id: randomUUID(),
        projectId,
        connectionId: record.id,
        providerId: record.providerId,
        accountId: record.accountId,
        accountName: record.accountName,
        linkId,
        remoteWorkId: work.id,
        workTitle: work.title,
        snapshot,
        createdAt: now(),
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        warning:
          '确认后才允许打开可能自动存稿的编辑器并填写本章。仅保存草稿，不正式发布。语义和风格要求仍需作者确认。',
      };
      this.platforms.putPreparation(preparation);
      return preparation;
    });
  }
  execute(
    projectId: string,
    preparationId: string,
    contentHash: string,
    idempotencyKey: string,
  ): DraftOperation {
    this.assertWritable(projectId);
    this.requireBrowser();
    const preparation = this.platforms.preparation(projectId, preparationId);
    if (!preparation)
      throw new PlatformError(404, 'PLATFORM_PREVIEW_NOT_FOUND', '预览不存在，请重新选择并预览。');
    if (preparation.snapshot.contentHash !== contentHash)
      throw new PlatformError(409, 'PLATFORM_PREVIEW_CHANGED', '确认内容与预览不一致。');
    const requestKey = businessHash([projectId, idempotencyKey]);
    const businessKey = businessHash([
      preparation.providerId,
      preparation.accountId,
      preparation.remoteWorkId,
      preparation.snapshot.chapterId,
      preparation.snapshot.revision,
      contentHash,
    ]);
    const operations = this.platforms.draftOperations();
    const replay = operations.find((operation) => operation.requestKeys.includes(requestKey));
    if (replay && replay.businessKey !== businessKey)
      throw new PlatformError(409, 'IDEMPOTENCY_CONFLICT', '此幂等键已用于不同章节或目标。');
    const previous =
      replay ??
      [...operations].reverse().find(
        (operation) =>
          operation.businessKey === businessKey &&
          // A known pre-write failure may be retried only through a freshly approved preview.
          !(
            operation.state === 'failed' &&
            !operation.mutationStarted &&
            operation.preparationId !== preparationId
          ),
      );
    if (previous) {
      if (previous.projectId !== projectId)
        throw new PlatformError(409, 'PLATFORM_DRAFT_EXISTS', '该账号作品章节已存在操作，请先核对原记录。');
      if (!previous.requestKeys.includes(requestKey)) {
        previous.requestKeys.push(requestKey);
        this.platforms.putDraftOperation(previous);
      }
      return publicOperation(previous);
    }
    if (Date.parse(preparation.expiresAt) <= Date.now())
      throw new PlatformError(410, 'PLATFORM_PREVIEW_EXPIRED', '预览已过期，请重新预览并确认。');
    const current = this.snapshot(projectId, preparation.snapshot.chapterId);
    if (current.contentHash !== contentHash || current.revision !== preparation.snapshot.revision)
      throw new PlatformError(
        409,
        'PLATFORM_PREVIEW_CHANGED',
        '本地章节在预览后已改变，请重新预览；未上传任何内容。',
      );
    const record = this.connection(projectId, preparation.connectionId);
    const link = this.platforms.links(projectId).find((item) => item.id === preparation.linkId);
    if (
      !link ||
      link.remoteWorkId !== preparation.remoteWorkId ||
      link.accountId !== preparation.accountId ||
      record.accountId !== preparation.accountId
    )
      throw new PlatformError(409, 'PLATFORM_BINDING_CHANGED', '账号或作品绑定已改变，请重新选择。');
    if (this.priorDraft(record.accountId, preparation.remoteWorkId, current.chapterId).length)
      throw new PlatformError(
        409,
        'PLATFORM_DRAFT_UPDATE_BLOCKED',
        '该章节已有草稿或未知操作，不能再次创建，请先只读核对。',
      );
    this.credential(record);
    const release = this.acquire(projectId, record);
    const operation: DraftOperationRecord = {
      id: randomUUID(),
      projectId,
      connectionId: record.id,
      providerId: 'tomato',
      accountId: record.accountId,
      remoteWorkId: preparation.remoteWorkId,
      chapterId: current.chapterId,
      chapterNumber: current.number,
      revision: current.revision,
      contentHash,
      title: current.title,
      state: 'queued',
      mutationStarted: false,
      createdAt: now(),
      updatedAt: now(),
      snapshot: current,
      businessKey,
      preparationId,
      requestKeys: [requestKey],
    };
    try {
      this.platforms.putDraftOperation(operation);
    } catch (error) {
      release();
      throw error;
    }
    // A single explicit task, not a background upload queue. Nothing resumes automatically on startup.
    let task: Promise<void>;
    task = Promise.resolve()
      .then(() => this.runDraft(operation, record))
      .catch(() => {
        // Disk failure leaves durable queued/running intent; restart maps it to unknown. Never log secrets.
      })
      .finally(() => {
        release();
        this.tasks.delete(task);
      });
    this.tasks.add(task);
    return publicOperation(operation);
  }
  private async runDraft(operation: DraftOperationRecord, record: ConnectionRecord) {
    try {
      operation.state = 'running';
      operation.updatedAt = now();
      this.platforms.putDraftOperation(operation);
      const state = this.state(record);
      await this.verify(record, state);
      await this.work(record, operation.remoteWorkId);
      const current = this.snapshot(operation.projectId, operation.chapterId);
      if (current.contentHash !== operation.contentHash || current.revision !== operation.revision)
        throw new PlatformError(409, 'PLATFORM_PREVIEW_CHANGED', '章节内容已变化；操作停止，未进入编辑器。');
      operation.mutationStarted = true;
      operation.updatedAt = now();
      // Intent including approval snapshot is durable BEFORE even opening an autosaving editor.
      this.platforms.putDraftOperation(operation);
      const { draftId } = await this.browser.createDraft(
        record.id,
        state,
        record.accountId,
        operation.remoteWorkId,
        operation.snapshot,
        (id) => {
          if (!id || (operation.remoteDraftId && operation.remoteDraftId !== id))
            throw new PlatformError(502, 'PLATFORM_DRAFT_ID_MISMATCH', '草稿身份不一致。');
          operation.remoteDraftId = id;
          operation.updatedAt = now();
          this.platforms.putDraftOperation(operation);
        },
      );
      if (!draftId || (operation.remoteDraftId && operation.remoteDraftId !== draftId))
        throw new PlatformError(502, 'PLATFORM_DRAFT_ID_MISMATCH', '保存后未获得稳定且一致的草稿 ID。');
      operation.remoteDraftId = draftId;
      operation.updatedAt = now();
      this.platforms.putDraftOperation(operation);
      await this.verify(record, state);
      const actual = await this.browser.readDraft(record.id, state, operation.remoteWorkId, draftId);
      this.persistVerified(operation, actual);
    } catch (error) {
      operation.state = operation.mutationStarted ? 'unknown' : 'failed';
      operation.errorCode = error instanceof PlatformError ? error.code : 'PLATFORM_OPERATION_INTERRUPTED';
      operation.error =
        error instanceof PlatformError ? error.message : '浏览器操作中断或超时；请先只读核对，不要重复发送。';
      operation.updatedAt = now();
      this.platforms.putDraftOperation(operation);
    }
  }
  private matches(operation: DraftOperationRecord, actual: VerifiedDraft) {
    return (
      actual.accountId === operation.accountId &&
      actual.workId === operation.remoteWorkId &&
      (!operation.remoteDraftId || actual.id === operation.remoteDraftId) &&
      !!actual.id &&
      actual.title === operation.snapshot.title &&
      draftHash(actual.title, actual.content) === operation.contentHash &&
      JSON.stringify(actual.paragraphs) === JSON.stringify(operation.snapshot.paragraphs)
    );
  }
  private persistVerified(operation: DraftOperationRecord, actual: VerifiedDraft) {
    if (!this.matches(operation, actual))
      throw new PlatformError(
        409,
        'PLATFORM_DRAFT_VERIFICATION_FAILED',
        '重新打开的草稿与批准的账号、作品、标题、正文或段落不一致。结果未知，请人工核对；不会自动覆盖。',
      );
    const verifiedAt = now();
    operation.state = 'verified';
    operation.remoteDraftId = actual.id;
    operation.verifiedAt = verifiedAt;
    operation.updatedAt = verifiedAt;
    delete operation.error;
    delete operation.errorCode;
    const receipt: DraftReceipt = {
      id: randomUUID(),
      operationId: operation.id,
      projectId: operation.projectId,
      connectionId: operation.connectionId,
      providerId: operation.providerId,
      accountId: operation.accountId,
      remoteWorkId: operation.remoteWorkId,
      remoteDraftId: actual.id,
      chapterId: operation.chapterId,
      revision: operation.revision,
      contentHash: operation.contentHash,
      title: operation.title,
      verifiedAt,
    };
    this.platforms.verifyDraft(operation, receipt);
  }
  async reconcile(projectId: string, operationId: string) {
    const operation = this.platforms.draftOperation(projectId, operationId);
    if (!operation) throw new PlatformError(404, 'PLATFORM_OPERATION_NOT_FOUND', '草稿操作不存在。');
    if (operation.state === 'verified') return publicOperation(operation);
    if (operation.state !== 'unknown')
      throw new PlatformError(
        409,
        'PLATFORM_RECONCILE_INVALID',
        '仅结果未知的操作需要核对；其他状态不会触发补写。',
      );
    const record = this.connection(projectId, operation.connectionId);
    this.requireBrowser();
    return this.withLock(projectId, record, async () => {
      const state = this.state(record);
      await this.verify(record, state);
      await this.work(record, operation.remoteWorkId);
      let draftId = operation.remoteDraftId;
      if (!draftId) {
        const matches = (
          await this.browser.findDrafts(
            record.id,
            state,
            operation.accountId,
            operation.remoteWorkId,
            operation.snapshot,
          )
        ).filter((draft) => this.matches(operation, draft));
        if (matches.length !== 1)
          throw new PlatformError(
            409,
            'PLATFORM_OPERATION_UNKNOWN',
            '没有找到唯一一致的草稿，仍为未知；不会自动重新创建。请到官方作者页核对。',
          );
        draftId = matches[0].id;
      }
      const actual = await this.browser.readDraft(record.id, state, operation.remoteWorkId, draftId);
      this.persistVerified(operation, actual);
      return publicOperation(operation);
    });
  }
  async removeConnection(projectId: string, connectionId: string) {
    const record = this.connection(projectId, connectionId);
    this.assertProjectIdle(projectId);
    if (this.platforms.links(projectId).some((link) => link.connectionId === connectionId))
      throw new PlatformError(
        409,
        'PLATFORM_CONNECTION_LINKED',
        '请先解除作品绑定；删除不会删除远端作品或草稿。',
      );
    if (
      this.platforms
        .draftOperations(projectId)
        .some(
          (operation) =>
            operation.connectionId === connectionId &&
            ['unknown', 'queued', 'running'].includes(operation.state),
        )
    )
      throw new PlatformError(
        409,
        'PLATFORM_OPERATION_UNKNOWN',
        '此连接仍有未核对的操作，请先核对再删除，以免丢失恢复入口。',
      );
    await this.withLock(projectId, record, async () => {
      await this.browser.closeConnection(record.id);
      this.platforms.deleteConnection(record.id);
      this.secrets.delete(record.credentialRef);
    });
  }
  async removeProject(projectId: string) {
    if (!this.platformStore) return;
    this.assertProjectIdle(projectId);
    if (
      this.platforms
        .draftOperations(projectId)
        .some((operation) => ['unknown', 'queued', 'running'].includes(operation.state))
    )
      throw new PlatformError(
        409,
        'PLATFORM_OPERATION_UNKNOWN',
        '项目有结果未知的草稿，请先核对再删除；不会远端删除。',
      );
    const connections = this.platforms.connections(projectId);
    await this.withLock(projectId, undefined, async () => {
      for (const connection of connections) {
        await this.browser.closeConnection(connection.id);
        this.secrets.delete(connection.credentialRef);
      }
      this.platforms.removeProject(projectId);
    });
  }
  async waitForIdle() {
    await Promise.all([...this.tasks]);
  }
  async close() {
    this.closing = true;
    for (const timer of this.loginTimers.values()) clearTimeout(timer);
    this.loginTimers.clear();
    await this.browser.close();
    await this.waitForIdle();
    this.secretStore?.clearMemory();
    this.logins.clear();
  }
}
