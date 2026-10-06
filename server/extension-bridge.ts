import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Router, json, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { ExtensionPairing } from '../shared/platforms.js';
import { PlatformError } from './platforms-types.js';
import type { PlatformRuntime } from './platform-runtime.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const matches = (value: string, expected: string) => timingSafeEqual(Buffer.from(hash(value)), Buffer.from(expected));
const secret = z.string().regex(/^[a-f0-9]{64}$/);
const originPattern = /^chrome-extension:\/\/[a-p]{32}$/;
export interface ExtensionSessionState {
  kind: 'browser_extension';
  id: string;
  projectId: string;
  providerId: 'tomato';
  extensionOrigin: string;
  tabId: number;
  expiresAt: string;
  paired: true;
  accountVerified: false;
  listWorks: false;
  saveDraft: false;
}
interface PairingRecord {
  view: ExtensionPairing;
  challengeHash: string;
  claimHash?: string;
  tokenHash?: string;
}
interface SessionRecord { state: ExtensionSessionState; tokenHash: string }

/** Process-local pairing credentials. Never writes a token or browser authentication state to disk. */
export class ExtensionBridge {
  private pairings = new Map<string, PairingRecord>();
  private sessions = new Map<string, SessionRecord>();
  private stopped = false;
  constructor(private clock: () => number = Date.now) {}
  private prune() {
    for (const [id, entry] of this.sessions)
      if (Date.parse(entry.state.expiresAt) <= this.clock()) this.sessions.delete(id);
    for (const [id, entry] of this.pairings)
      if (Date.parse(entry.view.expiresAt) + 60_000 <= this.clock()) this.pairings.delete(id);
  }
  start(projectId: string, extensionId: string): ExtensionPairing {
    if (this.stopped) throw new PlatformError(503, 'PLATFORM_CLOSING', '扩展服务正在关闭。');
    if (!/^[a-p]{32}$/.test(extensionId)) throw new PlatformError(400, 'EXTENSION_ID_INVALID', '请输入扩展管理页显示的 32 位扩展 ID。');
    this.prune();
    if (this.pairings.size >= 100) throw new PlatformError(429, 'EXTENSION_PAIRING_LIMIT', '配对请求过多，请稍后再试。');
    this.revokeProject(projectId);
    const challenge = randomBytes(32).toString('hex');
    const view: ExtensionPairing = {
      id: randomUUID(), projectId, providerId: 'tomato', status: 'waiting', challenge,
      extensionOrigin: `chrome-extension://${extensionId}`,
      createdAt: new Date(this.clock()).toISOString(), expiresAt: new Date(this.clock() + 120_000).toISOString(),
      message: '在番茄标签页打开扩展，输入配对码并明确批准，然后返回本应用确认扩展 ID。',
    };
    // The readable challenge is returned once to the app, never retained by the broker.
    this.pairings.set(view.id, { view: { ...view, challenge: '' }, challengeHash: hash(challenge) });
    return view;
  }
  private entry(id: string) {
    const entry = this.pairings.get(id);
    if (this.stopped || !entry || entry.view.status === 'closed') throw new PlatformError(410, 'EXTENSION_PAIRING_CLOSED', '配对不存在或已关闭，请重新生成。');
    if (Date.parse(entry.view.expiresAt) <= this.clock()) throw new PlatformError(410, 'EXTENSION_PAIRING_EXPIRED', '配对码已过期，请重新生成。');
    return entry;
  }
  list(projectId: string) {
    this.prune();
    return [...this.pairings.values()].filter((entry) => entry.view.projectId === projectId).map(({ view }) => ({
      ...view, status: Date.parse(view.expiresAt) <= this.clock() && view.status !== 'closed' ? 'expired' as const : view.status,
    }));
  }
  allowsOrigin(origin: string) {
    this.prune();
    return !this.stopped && originPattern.test(origin) && (
      [...this.pairings.values()].some(({ view }) => view.extensionOrigin === origin && !['closed', 'expired'].includes(view.status) && Date.parse(view.expiresAt) > this.clock()) ||
      [...this.sessions.values()].some(({ state }) => state.extensionOrigin === origin)
    );
  }
  claim(origin: string, challenge: string, tabId: number) {
    const entry = [...this.pairings.values()].find((item) => item.view.extensionOrigin === origin && matches(challenge, item.challengeHash));
    if (!entry) throw new PlatformError(403, 'EXTENSION_PAIRING_INVALID', '配对码或扩展来源无效。');
    this.entry(entry.view.id);
    if (entry.view.status !== 'waiting') throw new PlatformError(409, 'EXTENSION_PAIRING_USED', '配对码已经使用，不能重复认领。');
    const claimToken = randomBytes(32).toString('hex');
    entry.claimHash = hash(claimToken);
    entry.view = { ...entry.view, status: 'claimed', tabId, message: '扩展已批准，尚未配对。请核对扩展 ID 与标签页编号并在应用确认。' };
    return { pairingId: entry.view.id, claimToken, projectId: entry.view.projectId, expiresAt: entry.view.expiresAt };
  }
  confirm(projectId: string, id: string) {
    const entry = this.entry(id);
    if (entry.view.projectId !== projectId) throw new PlatformError(404, 'EXTENSION_PAIRING_NOT_FOUND', '配对不属于当前项目。');
    if (entry.view.status !== 'claimed') throw new PlatformError(409, 'EXTENSION_POPUP_CONFIRM_REQUIRED', '请先在扩展中明确批准。');
    entry.view.status = 'confirmed';
    entry.view.message = '应用已确认，请返回扩展点击完成配对。配对不等于账号验证。';
    return { ...entry.view };
  }
  finish(origin: string, id: string, claimToken: string, token: string) {
    const entry = this.entry(id);
    if (entry.view.extensionOrigin !== origin || !entry.claimHash || !matches(claimToken, entry.claimHash)) throw new PlatformError(403, 'EXTENSION_AUTH_INVALID', '扩展配对凭据无效。');
    if (entry.view.status !== 'confirmed') throw new PlatformError(409, 'EXTENSION_APP_CONFIRM_REQUIRED', '请先返回应用明确确认配对。');
    // A repeated delivery with the SAME worker-generated token can recover a lost response.
    if (entry.view.sessionId) {
      const existing = this.sessions.get(entry.view.sessionId);
      if (existing && matches(token, existing.tokenHash)) return { ...existing.state };
      throw new PlatformError(409, 'EXTENSION_PAIRING_USED', '配对已完成，不能更换凭据。');
    }
    const state: ExtensionSessionState = {
      kind: 'browser_extension', id: randomUUID(), projectId: entry.view.projectId, providerId: 'tomato',
      extensionOrigin: origin, tabId: entry.view.tabId!, expiresAt: new Date(this.clock() + 30 * 60_000).toISOString(),
      paired: true, accountVerified: false, listWorks: false, saveDraft: false,
    };
    this.sessions.set(state.id, { state, tokenHash: hash(token) });
    entry.view.sessionId = state.id;
    entry.view.message = '扩展已配对；账号身份、作品读取和草稿保存仍待真实页面核验。';
    return { ...state };
  }
  authenticate(origin: string, token: string) {
    this.prune();
    const entry = [...this.sessions.values()].find((item) => item.state.extensionOrigin === origin && matches(token, item.tokenHash));
    if (this.stopped || !entry) throw new PlatformError(401, 'EXTENSION_SESSION_EXPIRED', '扩展配对已过期或断开，请重新配对。');
    return { ...entry.state };
  }
  sessionsFor(projectId: string) {
    this.prune();
    return [...this.sessions.values()].filter((entry) => entry.state.projectId === projectId).map((entry) => ({ ...entry.state }));
  }
  revokeSession(id: string) { this.sessions.delete(id); }
  cancel(projectId: string, id: string) {
    const entry = this.pairings.get(id);
    if (!entry || entry.view.projectId !== projectId) throw new PlatformError(404, 'EXTENSION_PAIRING_NOT_FOUND', '配对不存在。');
    if (entry.view.sessionId) this.sessions.delete(entry.view.sessionId);
    entry.view.status = 'closed';
    entry.view.message = '扩展配对已撤销。';
    delete entry.claimHash;
  }
  revokeProject(projectId: string) {
    for (const entry of this.pairings.values()) if (entry.view.projectId === projectId) this.cancel(projectId, entry.view.id);
    for (const [id, entry] of this.sessions) if (entry.state.projectId === projectId) this.sessions.delete(id);
  }
  close() { this.stopped = true; this.pairings.clear(); this.sessions.clear(); }
}

/** Mount ONLY at /api/platform-extension, before general app origin/CSRF guards. */
export function createExtensionBridgeRouter(runtime: PlatformRuntime) {
  const router = Router();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = req.get('origin') || '';
    if (req.get('host') !== `127.0.0.1:${process.env.PORT || '3001'}` || !runtime.extension.allowsOrigin(origin))
      throw new PlatformError(403, 'EXTENSION_ORIGIN_REJECTED', '仅允许本次配对指定的扩展来源和固定本机地址。');
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      if (!['GET', 'POST', 'DELETE'].includes(req.get('access-control-request-method') || '') ||
        (req.get('access-control-request-headers') || '').split(',').some((header) => header.trim() && !['authorization', 'content-type'].includes(header.trim().toLowerCase())))
        throw new PlatformError(403, 'EXTENSION_PREFLIGHT_REJECTED', '扩展请求不受支持。');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.status(204).end();
      return;
    }
    if (req.get('cookie')) throw new PlatformError(403, 'EXTENSION_COOKIE_REJECTED', '扩展桥不接受 Cookie。');
    if (req.method === 'POST' && !req.is('application/json')) throw new PlatformError(415, 'EXTENSION_JSON_REQUIRED', '扩展桥仅接受 JSON。');
    next();
  });
  router.use(json({ limit: '4kb' }));
  router.post('/claim', (req, res) => {
    const input = z.object({ challenge: secret, tabId: z.number().int().nonnegative(), approved: z.literal(true) }).strict().parse(req.body);
    res.json(runtime.extension.claim(req.get('origin')!, input.challenge, input.tabId));
  });
  router.post('/finish', (req, res) => {
    const input = z.object({ pairingId: z.string().uuid(), claimToken: secret, token: secret }).strict().parse(req.body);
    res.json(runtime.extension.finish(req.get('origin')!, input.pairingId, input.claimToken, input.token));
  });
  const session = (req: Request) => {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(req.get('authorization') || '')?.[1];
    if (!token) throw new PlatformError(401, 'EXTENSION_AUTH_REQUIRED', '需要有效的扩展配对凭据。');
    const state = runtime.extension.authenticate(req.get('origin')!, token);
    if (!runtime.store.get(state.projectId)) {
      runtime.extension.revokeSession(state.id);
      throw new PlatformError(410, 'PROJECT_NOT_FOUND', '项目已删除，扩展配对已撤销。');
    }
    return state;
  };
  router.get('/session', (req, res) => res.json(session(req)));
  router.delete('/session', (req, res) => { runtime.extension.revokeSession(session(req).id); res.json({ ok: true }); });
  router.use((_req, res) => res.status(404).json({ code: 'EXTENSION_ROUTE_NOT_FOUND', error: '扩展桥不提供此操作。' }));
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error instanceof PlatformError ? error.status : error instanceof z.ZodError ? 400 : 500).json({
      code: error instanceof PlatformError ? error.code : 'EXTENSION_REQUEST_INVALID',
      error: error instanceof PlatformError ? error.message : '扩展请求无效。', retryable: false,
    });
  });
  return router;
}
