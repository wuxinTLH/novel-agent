import fs from 'node:fs';
import path from 'node:path';
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  scryptSync,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { accountStateSchema, type AccountEmailTransport } from './account-state.js';
import { AccountExtension } from './account.js';
import type {
  AuthUser,
  AuthPrincipal,
  AuthSession,
  AuthSessionInfo,
  AuthStatus,
  TurnstileAdminSettings,
} from '../../../../../shared/auth.js';

import {
  ROLE_IDS,
  normalizeRole,
  hasPermission,
  canManageUser,
  type Permission,
  type RoleId,
} from '../../../../../shared/permissions.js';

// Only persisted identities accept the legacy role; request schemas require canonical roles.
const storedRoleSchema = z.preprocess((value) => normalizeRole(value) ?? value, z.enum(ROLE_IDS));
const userSchema = z.object({
  id: z.string().uuid(),
  username: z.string().regex(/^[a-z0-9][a-z0-9_.-]{2,63}$/),
  role: storedRoleSchema,
  disabled: z.boolean(),
  createdAt: z.string().datetime(),
  passwordHash: z.string().regex(/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/),
});
const sessionSchema = z.object({
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  userId: z.string().uuid(),
  csrfToken: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().finite(),
});
const turnstileSchema = z.object({
  enabled: z.boolean(),
  siteKey: z.string().max(256),
  action: z.string().max(64),
  hostname: z.string().max(253),
  encryptedSecret: z.string().max(4096),
});
const documentSchema = z.object({
  version: z.literal(1),
  users: z.array(userSchema).max(10000),
  sessions: z.array(sessionSchema).max(20000),
  turnstile: turnstileSchema,
  account: accountStateSchema.optional(),
});
export type AuthDocument = z.infer<typeof documentSchema>;
/** Must atomically persist before returning; owner/global metadata, never a tenant-selected file. Single writer required. */
export interface AuthPersistence {
  read(): unknown;
  write(value: AuthDocument): void;
  close?(): Promise<void>;
}
export interface AuthServiceOptions {
  dataDir: string;
  enabled?: boolean;
  secureCookies?: boolean;
  persistence?: AuthPersistence;
  /** Stable 32-byte encryption key from an owner-controlled secret store. Never send to clients. */
  secretKey?: Buffer;
  now?: () => number;
  fetch?: typeof fetch;
  sessionTtlMs?: number;
  /** Owner-provided delivery transport; required before enabling email features. */
  emailTransport?: AccountEmailTransport;
}
export class AuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}
const fail = (status: number, code: string): never => {
  throw new AuthError(status, code);
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const empty = (): AuthDocument => ({
  version: 1,
  users: [],
  sessions: [],
  turnstile: { enabled: false, siteKey: '', action: 'login', hostname: '', encryptedSecret: '' },
});
const publicUser = (user: AuthDocument['users'][number]): AuthUser => ({
  id: user.id,
  username: user.username,
  role: user.role,
  disabled: user.disabled,
  createdAt: user.createdAt,
});
function safeDirectory(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink())
    fail(503, 'AUTH_STORAGE_UNAVAILABLE');
}
function readPrivate(file: string): Buffer {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024)
    fail(503, 'AUTH_STORAGE_UNAVAILABLE');
  fs.chmodSync(file, 0o600);
  return fs.readFileSync(file);
}
function atomicWrite(file: string, value: string) {
  safeDirectory(path.dirname(file));
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) fail(503, 'AUTH_STORAGE_UNAVAILABLE');
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, value);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function localPersistence(dir: string): AuthPersistence {
  const file = path.join(dir, 'auth.json');
  return {
    read() {
      try {
        return JSON.parse(readPrivate(file).toString('utf8'));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },
    write(value) {
      atomicWrite(file, JSON.stringify(value) + '\n');
    },
  };
}
function loadKey(dir: string): Buffer {
  const file = path.join(dir, 'auth.key');
  try {
    const key = readPrivate(file);
    if (key.length !== 32) fail(503, 'AUTH_KEY_INVALID');
    return key;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    safeDirectory(dir);
    const key = randomBytes(32);
    // Exclusive creation: never replace an existing encryption key.
    fs.writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(file, 0o600);
    return key;
  }
}
function password(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || Buffer.byteLength(value) > 1024)
    fail(400, 'AUTH_PASSWORD_INVALID');
  return value as string;
}
function username(value: unknown): string {
  if (typeof value !== 'string') return fail(400, 'AUTH_USERNAME_INVALID');
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(normalized)) fail(400, 'AUTH_USERNAME_INVALID');
  return normalized;
}
function derive(value: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(value, salt, 64, { N: 16384, r: 8, p: 1 }, (error, key) => (error ? reject(error) : resolve(key))),
  );
}
function cookie(req: Request, name: string): string {
  const entries = (req.headers.cookie ?? '')
    .split(';')
    .map((v) => v.trim())
    .filter((v) => v.startsWith(`${name}=`));
  return entries.length === 1 ? entries[0].slice(name.length + 1) : '';
}
const SESSION_COOKIE = 'novel_session';
const PREFLIGHT_COOKIE = 'novel_prelogin';

/** Authentication is default-off and immutable for the lifetime of this process. */
export class AuthService {
  readonly enabled: boolean;
  readonly router: Router;
  private state: AuthDocument = empty();
  private readonly persistence: AuthPersistence;
  private key: Buffer;
  private initialized = false;
  private readonly options: AuthServiceOptions;
  private readonly clock: () => number;
  private readonly fetcher: typeof fetch;
  private readonly secure: boolean;
  private readonly ttl: number;
  private readonly attempts = new Map<string, { count: number; until: number }>();
  private readonly pending = new Set<Promise<unknown>>();
  /** Caller must first quiesce new HTTP requests. Tracks actual async work, not socket lifetime. */
  async waitForIdle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
  constructor(options: AuthServiceOptions) {
    this.options = options;
    this.enabled = options.enabled === true;
    this.clock = options.now ?? Date.now;
    this.fetcher = options.fetch ?? fetch;
    this.secure = options.secureCookies ?? false;
    this.ttl = options.sessionTtlMs ?? 12 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(this.ttl) || this.ttl < 1000 || this.ttl > 30 * 86400000)
      fail(400, 'AUTH_TTL_INVALID');
    this.persistence = options.persistence ?? localPersistence(options.dataDir);
    this.key = Buffer.alloc(32);
    if (this.enabled) this.initialize();
    this.router = this.makeRouter();
  }
  private initialize() {
    if (this.initialized) return;
    this.key = Buffer.from(this.options.secretKey ?? loadKey(this.options.dataDir));
    if (this.key.length !== 32) fail(503, 'AUTH_KEY_INVALID');
    try {
      const saved = this.persistence.read();
      this.state = saved == null ? empty() : documentSchema.parse(saved);
      const ids = new Set(this.state.users.map((u) => u.id));
      if (
        ids.size !== this.state.users.length ||
        new Set(this.state.users.map((u) => u.username)).size !== this.state.users.length ||
        this.state.sessions.some((s) => !ids.has(s.userId))
      )
        throw new Error('invalid identity');
      if (this.state.turnstile.encryptedSecret) this.decrypt(this.state.turnstile.encryptedSecret);
      const account = this.state.account;
      if (account) {
        if (
          new Set(account.profiles.map((p) => p.userId)).size !== account.profiles.length ||
          account.profiles.some((p) => !ids.has(p.userId))
        )
          throw new Error('invalid account identity');
        const emails = account.profiles.flatMap((p) => (p.email ? [p.email] : []));
        const subjects = account.profiles.flatMap((p) =>
          p.oidcSubject ? [JSON.stringify([p.oidcIssuer, p.oidcSubject])] : [],
        );
        if (new Set(emails).size !== emails.length || new Set(subjects).size !== subjects.length)
          throw new Error('duplicate account identity');
        if (account.config.oidc.encryptedClientSecret)
          this.decrypt(account.config.oidc.encryptedClientSecret);
        for (const profile of account.profiles)
          if (profile.encryptedTotp) this.decrypt(profile.encryptedTotp);
      }
    } catch {
      fail(503, 'AUTH_STORAGE_UNAVAILABLE');
    }
    this.initialized = true;
  }
  private save(next: AuthDocument) {
    if (next.account) {
      const changed = new Set(
        this.state.users
          .filter((old) => {
            const current = next.users.find((u) => u.id === old.id);
            return (
              !current ||
              current.disabled !== old.disabled ||
              current.role !== old.role ||
              current.passwordHash !== old.passwordHash
            );
          })
          .map((u) => u.id),
      );
      next = {
        ...next,
        account: {
          ...next.account,
          tokens: next.account.tokens.filter((t) => !t.userId || !changed.has(t.userId)),
        },
      };
    }
    try {
      this.persistence.write(structuredClone(documentSchema.parse(next)));
    } catch {
      return fail(503, 'AUTH_STORAGE_UNAVAILABLE');
    }
    this.state = next;
  }
  private encrypt(secret: string): string {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv);
    return Buffer.concat([iv, cipher.update(secret, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString(
      'base64',
    );
  }
  private decrypt(secret: string): string {
    const bytes = Buffer.from(secret, 'base64');
    if (bytes.length < 29) return fail(503, 'AUTH_SECRET_INVALID');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
  }
  /** Call only after management authorization; public auth-off status stays side-effect free. */
  managementConfigured(): boolean {
    if (!this.initialized) {
      try {
        if (this.persistence.read() == null) return false;
      } catch {
        return fail(503, 'AUTH_STORAGE_UNAVAILABLE');
      }
      this.initialize();
    }
    return this.hasSuperadmin();
  }
  hasSuperadmin(): boolean {
    return this.state.users.some((user) => user.role === 'superadmin' && !user.disabled);
  }
  session(req: Request): AuthSession | null {
    if (!this.enabled) return null;
    const token = cookie(req, SESSION_COOKIE);
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const saved = this.state.sessions.find((s) => s.tokenHash === hash(token) && s.expiresAt > this.clock());
    const user = saved && this.state.users.find((u) => u.id === saved.userId && !u.disabled);
    return saved && user
      ? {
          user: publicUser(user),
          csrfToken: saved.csrfToken,
          expiresAt: new Date(saved.expiresAt).toISOString(),
        }
      : null;
  }
  async resolve(req: Request): Promise<AuthPrincipal | null> {
    const session = this.session(req);
    return session ? { ...session.user, csrfToken: session.csrfToken } : null;
  }
  status(req?: Request): AuthStatus {
    const session = req ? this.session(req) : null;
    const { enabled, siteKey, action, hostname } = this.state.turnstile;
    return {
      enabled: this.enabled,
      authenticated: !!session,
      user: session?.user ?? null,
      ...(session ? { csrfToken: session.csrfToken } : {}),
      turnstile: { enabled, siteKey, action, hostname },
    };
  }
  private sameOrigin(req: Request): boolean {
    const origin = req.get('origin');
    if (!origin) return true; // Non-browser clients must still present the CSRF token.
    try {
      const url = new URL(origin);
      return url.host === req.get('host') && url.protocol === (this.secure ? 'https:' : `${req.protocol}:`);
    } catch {
      return false;
    }
  }
  requireCsrf(req: Request): boolean {
    const session = this.session(req),
      token = req.get('x-csrf-token');
    return !!session && !!token && this.sameOrigin(req) && equal(token, session.csrfToken);
  }
  private setCookie(res: Response, name: string, value: string, maxAge: number, lax = false) {
    res.cookie(name, value, {
      httpOnly: true,
      secure: this.secure,
      sameSite: lax ? 'lax' : 'strict',
      path: '/',
      maxAge,
    });
  }
  private issueSession(req: Request, res: Response, id: string) {
    const user = this.state.users.find((u) => u.id === id && !u.disabled);
    if (!user) return fail(401, 'AUTH_LOGIN_FAILED');
    const token = randomBytes(32).toString('hex'),
      csrfToken = randomBytes(32).toString('hex'),
      expiresAt = this.clock() + this.ttl;
    const oldHash = hash(cookie(req, SESSION_COOKIE));
    const active = this.state.sessions.filter((s) => s.expiresAt > this.clock() && s.tokenHash !== oldHash);
    if (active.length >= 20000) return fail(503, 'AUTH_SESSION_CAPACITY');
    this.save({
      ...this.state,
      sessions: [...active, { tokenHash: hash(token), userId: id, csrfToken, expiresAt }],
    });
    this.setCookie(res, SESSION_COOKIE, token, this.ttl);
    this.setCookie(res, PREFLIGHT_COOKIE, '', 0);
    if (req.path === '/account/oidc/callback' && req.get('accept')?.includes('text/html'))
      return res.redirect(303, '/account/complete?oidc=success');
    return res.json({
      user: publicUser(user),
      csrfToken,
      expiresAt: new Date(expiresAt).toISOString(),
    } satisfies AuthSession);
  }
  private prelogin(req: Request): boolean {
    const value = cookie(req, PREFLIGHT_COOKIE),
      token = req.get('x-csrf-token') ?? '';
    const [nonce, expiry, signature] = value.split('.');
    if (
      !nonce ||
      !expiry ||
      !signature ||
      !/^[a-f0-9]{64}$/.test(nonce) ||
      Number(expiry) <= this.clock() ||
      Number(expiry) > this.clock() + 600001
    )
      return false;
    const expected = createHmac('sha256', this.key).update(`${nonce}.${expiry}`).digest('hex');
    return this.sameOrigin(req) && equal(expected, signature) && equal(nonce, token);
  }
  private rateLimit(ip: string, name: string) {
    const now = this.clock();
    for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
    if (this.attempts.size > 10000) fail(429, 'AUTH_RATE_LIMITED');
    const keys = [`ip:${ip}`, `user:${name}`];
    if (keys.some((key) => (this.attempts.get(key)?.count ?? 0) >= 10)) fail(429, 'AUTH_RATE_LIMITED');
    for (const key of keys) {
      const entry = this.attempts.get(key) ?? { count: 0, until: now + 15 * 60000 };
      entry.count++;
      this.attempts.set(key, entry);
    }
  }
  private async validateTurnstile(token: unknown) {
    const settings = this.state.turnstile;
    if (!settings.enabled) return;
    if (typeof token !== 'string' || !token || token.length > 2048) fail(401, 'AUTH_TURNSTILE_FAILED');
    try {
      const response = await this.fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        body: new URLSearchParams({
          secret: this.decrypt(settings.encryptedSecret),
          response: token as string,
        }),
      });
      if (!response.ok) throw new Error('verification failed');
      const result = (await response.json()) as Record<string, unknown>;
      if (
        result.success !== true ||
        result.action !== settings.action ||
        result.hostname !== settings.hostname
      )
        throw new Error('verification mismatch');
    } catch {
      fail(401, 'AUTH_TURNSTILE_FAILED');
    }
  }
  /** Local CLI only: intentionally not exposed through any router endpoint. */
  bootstrapSuperadmin(name: string, rawPassword: string): AuthUser {
    if (!this.enabled) return fail(409, 'AUTH_DISABLED');
    if (this.state.users.some((u) => u.role === 'superadmin')) return fail(409, 'AUTH_ALREADY_BOOTSTRAPPED');
    const normalized = username(name),
      value = password(rawPassword),
      salt = randomBytes(16).toString('hex');
    if (this.state.users.some((u) => u.username === normalized)) return fail(409, 'AUTH_USERNAME_EXISTS');
    const user = {
      id: randomUUID(),
      username: normalized,
      role: 'superadmin' as const,
      disabled: false,
      createdAt: new Date(this.clock()).toISOString(),
      passwordHash: `scrypt$${salt}$${scryptSync(value, salt, 64).toString('hex')}`,
    };
    this.save({ ...this.state, users: [...this.state.users, user] });
    return publicUser(user);
  }
  /** Owner-only management surface. The caller must enforce local transport and CSRF, not client identity headers. */
  createManagementRouter(authorize: (req: Request) => boolean): Router {
    return this.makeRouter(authorize);
  }
  private sessionId(tokenHash: string): string {
    return createHmac('sha256', this.key).update(`session-id:${tokenHash}`).digest('hex');
  }
  private makeRouter(authorize?: (req: Request) => boolean): Router {
    const router = Router();
    const requirePermission = (req: Request, permission: Permission) => {
      if (authorize) {
        if (!authorize(req)) return fail(403, 'AUTH_MANAGEMENT_FORBIDDEN');
      } else {
        const session = this.session(req);
        if (!session) return fail(401, 'AUTH_REQUIRED');
        if (!hasPermission(session.user.role, permission)) return fail(403, 'AUTH_PERMISSION_DENIED');
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !this.requireCsrf(req))
          return fail(403, 'AUTH_CSRF_INVALID');
      }
    };
    const requireTarget = (req: Request, user: AuthDocument['users'][number]) => {
      requirePermission(req, 'users.manage');
      if (!authorize) {
        const actor = this.session(req)!.user;
        if ((actor.id === user.id && actor.role !== 'superadmin') || !canManageUser(actor.role, user.role))
          return fail(403, 'AUTH_USER_FORBIDDEN');
      }
    };
    const requireCreation = (req: Request, role: RoleId) => {
      requirePermission(req, 'users.manage');
      if (!authorize && !canManageUser(this.session(req)!.user.role, role))
        return fail(403, 'AUTH_USER_FORBIDDEN');
    };
    const requireSelf = (req: Request) => {
      const session = this.session(req);
      if (!session) return fail(401, 'AUTH_REQUIRED');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !this.requireCsrf(req))
        return fail(403, 'AUTH_CSRF_INVALID');
      return session;
    };
    const listSessions = (req: Request, userId: string): AuthSessionInfo[] =>
      this.state.sessions
        .filter((s) => s.userId === userId && s.expiresAt > this.clock())
        .map((s) => ({
          id: this.sessionId(s.tokenHash),
          expiresAt: new Date(s.expiresAt).toISOString(),
          current: !authorize && s.tokenHash === hash(cookie(req, SESSION_COOKIE)),
        }));
    const revokeSessions = (req: Request, res: Response, userId: string) => {
      const id = req.params.sessionId;
      const matches = (s: AuthDocument['sessions'][number]) =>
        s.userId === userId && (!id || this.sessionId(s.tokenHash) === id);
      if (id && !this.state.sessions.some((s) => matches(s) && s.expiresAt > this.clock()))
        return fail(404, 'AUTH_SESSION_NOT_FOUND');
      const revokesCurrent =
        !authorize &&
        this.state.sessions.some((s) => matches(s) && s.tokenHash === hash(cookie(req, SESSION_COOKIE)));
      this.save({ ...this.state, sessions: this.state.sessions.filter((s) => !matches(s)) });
      if (revokesCurrent) this.setCookie(res, SESSION_COOKIE, '', 0);
      return res.json({ ok: true });
    };
    const account = new AccountExtension({
      read: () => this.state,
      save: (document) => this.save(document),
      now: this.clock,
      encrypt: (value) => this.encrypt(value),
      decrypt: (value) => this.decrypt(value),
      prelogin: (req) => this.prelogin(req),
      self: requireSelf,
      admin: requirePermission,
      rate: (req, key) =>
        this.rateLimit(
          req.socket.remoteAddress ?? 'unknown',
          `account:${req.socket.remoteAddress ?? 'unknown'}:${key}`,
        ),
      turnstile: (value) => this.validateTurnstile(value),
      issue: (req, res, id) => this.issueSession(req, res, id),
      cookie,
      setCookie: (res, name, value, age, lax) => this.setCookie(res, name, value, age, lax),
      mail: this.options.emailTransport,
      fetcher: this.fetcher,
    });
    router.use((req, res, next) => {
      res.set('Cache-Control', 'no-store');
      res.set('Pragma', 'no-cache');
      if (authorize) {
        requirePermission(req, 'admin.access');
        this.initialize();
      }
      if (!authorize && !this.enabled && !(req.method === 'GET' && req.path === '/session')) {
        res.status(404).json({ error: 'AUTH_DISABLED' });
        return;
      }
      next();
    });
    account.install(router, !!authorize);
    if (!authorize) {
      router.get('/csrf', (req, res) => {
        if (!this.sameOrigin(req)) return res.status(403).json({ error: 'AUTH_CSRF_INVALID' });
        const nonce = randomBytes(32).toString('hex'),
          expiry = this.clock() + 600000;
        const payload = `${nonce}.${expiry}`;
        this.setCookie(
          res,
          PREFLIGHT_COOKIE,
          `${payload}.${createHmac('sha256', this.key).update(payload).digest('hex')}`,
          600000,
        );
        return res.json({ ...this.status(req), csrfToken: nonce });
      });
      router.get('/session', (req, res) => res.json(this.status(req)));
      router.post('/login', async (req, res) => {
        if (!this.prelogin(req)) return fail(403, 'AUTH_CSRF_INVALID');
        const body = req.body as Record<string, unknown> | undefined;
        const name =
          typeof body?.username === 'string' ? body.username.trim().toLowerCase().slice(0, 128) : '';
        this.rateLimit(req.socket.remoteAddress ?? 'unknown', name);
        const supplied =
          typeof body?.password === 'string' && Buffer.byteLength(body.password) <= 1024 ? body.password : '';
        const verifiedSettings = this.state.turnstile;
        await this.validateTurnstile(body?.turnstileToken);
        const user = this.state.users.find((u) => u.username === name);
        const [, salt, stored] = (user?.passwordHash ?? `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`).split(
          '$',
        );
        const actual = await derive(supplied, salt);
        const currentUser = user && this.state.users.find((u) => u.id === user.id);
        if (
          !user ||
          !currentUser ||
          currentUser.disabled ||
          currentUser.passwordHash !== user.passwordHash ||
          this.state.turnstile !== verifiedSettings ||
          !equal(actual.toString('hex'), stored)
        )
          return fail(401, 'AUTH_LOGIN_FAILED');
        return account.finish(req, res, user.id);
      });
      router.post('/logout', (req, res) => {
        if (!this.requireCsrf(req)) return fail(403, 'AUTH_CSRF_INVALID');
        this.save({
          ...this.state,
          sessions: this.state.sessions.filter((s) => s.tokenHash !== hash(cookie(req, SESSION_COOKIE))),
        });
        this.setCookie(res, SESSION_COOKIE, '', 0);
        res.json({ ok: true });
      });
      router.post('/password', async (req, res) => {
        const session = requireSelf(req);
        const input = z
          .object({ currentPassword: z.string().max(1024), newPassword: z.string() })
          .strict()
          .parse(req.body);
        const value = password(input.newPassword);
        this.rateLimit(req.socket.remoteAddress ?? 'unknown', session.user.username);
        const user = this.state.users.find((u) => u.id === session.user.id)!;
        const [, oldSalt, stored] = user.passwordHash.split('$');
        const actual = await derive(input.currentPassword, oldSalt);
        requireSelf(req);
        if (
          this.state.users.find((u) => u.id === user.id)?.passwordHash !== user.passwordHash ||
          !equal(actual.toString('hex'), stored)
        )
          return fail(401, 'AUTH_PASSWORD_INCORRECT');
        const salt = randomBytes(16).toString('hex');
        const derived = await derive(value, salt);
        requireSelf(req);
        const current = this.state.users.find((u) => u.id === user.id);
        if (!current || current.passwordHash !== user.passwordHash)
          return fail(401, 'AUTH_PASSWORD_INCORRECT');
        this.save({
          ...this.state,
          users: this.state.users.map((u) =>
            u.id === user.id ? { ...u, passwordHash: `scrypt$${salt}$${derived.toString('hex')}` } : u,
          ),
          sessions: this.state.sessions.filter((s) => s.userId !== user.id),
        });
        this.setCookie(res, SESSION_COOKIE, '', 0);
        res.json({ ok: true });
      });
      router.get('/sessions', (req, res) =>
        res.json({ sessions: listSessions(req, requireSelf(req).user.id) }),
      );
      router.delete('/sessions', (req, res) => revokeSessions(req, res, requireSelf(req).user.id));
      router.delete('/sessions/:sessionId', (req, res) => revokeSessions(req, res, requireSelf(req).user.id));
    }
    router.get('/users', (req, res) => {
      requirePermission(req, 'users.read');
      res.json({ users: this.state.users.map(publicUser) });
    });
    router.post('/users', async (req, res) => {
      requirePermission(req, 'users.manage');
      if (!this.hasSuperadmin()) return fail(409, 'AUTH_BOOTSTRAP_REQUIRED');
      const input = z
        .object({
          username: z.string(),
          password: z.string(),
          role: z.enum(ROLE_IDS).default('writer'),
        })
        .strict()
        .parse(req.body);
      requireCreation(req, input.role);
      const name = username(input.username),
        value = password(input.password);
      if (this.state.users.some((u) => u.username === name)) return fail(409, 'AUTH_USERNAME_EXISTS');
      if (this.state.users.length >= 10000) return fail(409, 'AUTH_USER_CAPACITY');
      const salt = randomBytes(16).toString('hex'),
        derived = await derive(value, salt);
      // Recheck authorization after async derivation: an administrator may have been disabled meanwhile.
      requireCreation(req, input.role);
      if (!this.hasSuperadmin()) return fail(409, 'AUTH_BOOTSTRAP_REQUIRED');
      if (this.state.users.length >= 10000) return fail(409, 'AUTH_USER_CAPACITY');
      // Recheck after async password derivation so concurrent requests cannot create duplicates.
      if (this.state.users.some((u) => u.username === name)) return fail(409, 'AUTH_USERNAME_EXISTS');
      const user = {
        id: randomUUID(),
        username: name,
        role: input.role,
        disabled: false,
        createdAt: new Date(this.clock()).toISOString(),
        passwordHash: `scrypt$${salt}$${derived.toString('hex')}`,
      };
      this.save({ ...this.state, users: [...this.state.users, user] });
      res.status(201).json({ user: publicUser(user) });
    });
    router.patch('/users/:id', (req, res) => {
      requirePermission(req, 'users.manage');
      const input = z
        .object({ disabled: z.boolean().optional(), role: z.enum(ROLE_IDS).optional() })
        .strict()
        .refine((value) => value.disabled !== undefined || value.role !== undefined)
        .parse(req.body);
      const user = this.state.users.find((u) => u.id === req.params.id);
      if (!user) return fail(404, 'AUTH_USER_NOT_FOUND');
      requireTarget(req, user);
      if (input.role !== undefined) requirePermission(req, 'roles.manage');
      const updated = { ...user, ...input };
      if (
        (updated.disabled || updated.role !== 'superadmin') &&
        user.role === 'superadmin' &&
        !user.disabled &&
        !this.state.users.some((u) => u.id !== user.id && u.role === 'superadmin' && !u.disabled)
      )
        return fail(409, 'AUTH_LAST_SUPERADMIN');
      this.save({
        ...this.state,
        users: this.state.users.map((u) => (u.id === user.id ? updated : u)),
        sessions:
          updated.disabled || updated.role !== user.role
            ? this.state.sessions.filter((s) => s.userId !== user.id)
            : this.state.sessions,
      });
      res.json({ user: publicUser(updated) });
    });
    router.post('/users/:id/password', async (req, res) => {
      requirePermission(req, 'users.manage');
      const input = z
        .object({ currentPassword: z.string().max(1024).optional(), newPassword: z.string() })
        .strict()
        .parse(req.body);
      const value = password(input.newPassword);
      const target = this.state.users.find((u) => u.id === req.params.id);
      if (!target) return fail(404, 'AUTH_USER_NOT_FOUND');
      requireTarget(req, target);
      const actor = !authorize
        ? this.state.users.find((u) => u.id === this.session(req)?.user.id)
        : undefined;
      if (!authorize) {
        if (!actor || input.currentPassword === undefined) return fail(401, 'AUTH_PASSWORD_INCORRECT');
        this.rateLimit(req.socket.remoteAddress ?? 'unknown', actor.username);
        const [, oldSalt, stored] = actor.passwordHash.split('$');
        const actual = await derive(input.currentPassword, oldSalt);
        requirePermission(req, 'users.manage');
        if (
          this.state.users.find((u) => u.id === actor.id)?.passwordHash !== actor.passwordHash ||
          !equal(actual.toString('hex'), stored)
        )
          return fail(401, 'AUTH_PASSWORD_INCORRECT');
      }
      const salt = randomBytes(16).toString('hex');
      const derived = await derive(value, salt);
      requirePermission(req, 'users.manage');
      const currentTarget = this.state.users.find((u) => u.id === target.id);
      if (!currentTarget) return fail(404, 'AUTH_USER_NOT_FOUND');
      requireTarget(req, currentTarget);
      if (actor && this.state.users.find((u) => u.id === actor.id)?.passwordHash !== actor.passwordHash)
        return fail(401, 'AUTH_PASSWORD_INCORRECT');
      if (this.state.users.find((u) => u.id === target.id)?.passwordHash !== target.passwordHash)
        return fail(409, 'AUTH_USER_CHANGED');
      this.save({
        ...this.state,
        users: this.state.users.map((u) =>
          u.id === target.id ? { ...u, passwordHash: `scrypt$${salt}$${derived.toString('hex')}` } : u,
        ),
        sessions: this.state.sessions.filter((s) => s.userId !== target.id),
      });
      if (actor?.id === target.id) this.setCookie(res, SESSION_COOKIE, '', 0);
      res.json({ ok: true });
    });
    const targetId = (req: Request): string => {
      requirePermission(req, req.method === 'GET' ? 'users.read' : 'users.manage');
      const user = this.state.users.find((u) => u.id === req.params.id);
      if (!user) return fail(404, 'AUTH_USER_NOT_FOUND');
      if (req.method !== 'GET') requireTarget(req, user);
      return user.id;
    };
    router.get('/users/:id/sessions', (req, res) => res.json({ sessions: listSessions(req, targetId(req)) }));
    router.delete('/users/:id/sessions', (req, res) => revokeSessions(req, res, targetId(req)));
    router.delete('/users/:id/sessions/:sessionId', (req, res) => revokeSessions(req, res, targetId(req)));
    const settings = (): TurnstileAdminSettings => {
      const { encryptedSecret, ...rest } = this.state.turnstile;
      return { ...rest, hasSecret: !!encryptedSecret };
    };
    router.get('/turnstile', (req, res) => {
      requirePermission(req, 'security.read');
      res.json(settings());
    });
    router.put('/turnstile', (req, res) => {
      requirePermission(req, 'security.manage');
      const input = z
        .object({
          enabled: z.boolean(),
          siteKey: z.string().max(256),
          action: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
          hostname: z.string().max(253),
          secret: z.string().max(2048).optional(),
        })
        .strict()
        .parse(req.body);
      const { secret, ...rest } = input;
      const encryptedSecret =
        secret === undefined ? this.state.turnstile.encryptedSecret : secret ? this.encrypt(secret) : '';
      if (
        input.enabled &&
        (!encryptedSecret ||
          !input.siteKey ||
          !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)$/.test(input.hostname))
      )
        return fail(400, 'AUTH_TURNSTILE_CONFIG_INVALID');
      this.save({ ...this.state, turnstile: { ...rest, encryptedSecret } });
      res.json(settings());
    });
    router.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
      const known = error instanceof AuthError;
      if (req.path === '/account/oidc/callback' && req.get('accept')?.includes('text/html'))
        return res.redirect(303, '/account/complete?oidc=failed');
      res.status(known ? error.status : error instanceof z.ZodError ? 400 : 503).json({
        error: known ? error.code : error instanceof z.ZodError ? 'AUTH_INVALID_REQUEST' : 'AUTH_UNAVAILABLE',
      });
    });
    // Express does not await handlers after response/socket close. Track their actual promises
    // so maintenance can drain password derivation, mail and provider exchange safely.
    for (const layer of router.stack) {
      for (const handler of layer.route?.stack ?? []) {
        const original = handler.handle;
        handler.handle = (req: Request, res: Response, next: NextFunction) => {
          let result: unknown;
          try {
            result = original(req, res, next);
          } catch (error) {
            next(error);
            return;
          }
          if (result && typeof (result as Promise<unknown>).then === 'function') {
            const pending = Promise.resolve(result);
            this.pending.add(pending);
            void pending.catch(next).finally(() => this.pending.delete(pending));
          }
        };
      }
    }
    return router;
  }
}
export function bootstrapSuperadmin(
  options: Pick<AuthServiceOptions, 'dataDir' | 'persistence' | 'secretKey'> & {
    username: string;
    password: string;
  },
): AuthUser {
  return new AuthService({ ...options, enabled: true }).bootstrapSuperadmin(
    options.username,
    options.password,
  );
}
export function createAuthRouter(service: AuthService): Router {
  return service.router;
}
