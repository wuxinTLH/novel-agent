import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { createRemoteJWKSet, jwtVerify, customFetch } from 'jose';
import { AuthError, type AuthDocument } from './auth.js';
import { emptyAccountState, type AccountState, type AccountEmailTransport } from './account-state.js';

const fail = (status: number, code: string): never => {
  throw new AuthError(status, code);
};
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const secret = () => randomBytes(32).toString('hex');
const passwordHash = (value: string) => {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(value, salt, 64).toString('hex')}`;
};
const email = z
  .string()
  .email()
  .max(254)
  .transform((v) => v.trim().toLowerCase());
const tokenInput = z.string().regex(/^[a-f0-9]{64}$/);
export interface AccountHost {
  read(): AuthDocument;
  save(document: AuthDocument): void;
  now(): number;
  encrypt(value: string): string;
  decrypt(value: string): string;
  prelogin(req: Request): boolean;
  self(req: Request): { user: { id: string } };
  admin(req: Request, permission: 'security.read' | 'security.manage'): void;
  rate(req: Request, key: string): void;
  turnstile(value: unknown): Promise<void>;
  issue(req: Request, res: Response, id: string): unknown;
  cookie(req: Request, name: string): string;
  setCookie(res: Response, name: string, value: string, age: number, lax?: boolean): void;
  mail?: AccountEmailTransport;
  fetcher: typeof fetch;
  password(value: unknown, username: string, previousHash?: string): string;
}
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes: Buffer): string {
  let bits = 0,
    value = 0,
    result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}
export function totp(key: string, counter: number): string {
  let bits = 0,
    value = 0;
  const bytes: number[] = [];
  for (const char of key) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('Invalid TOTP key');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const count = Buffer.alloc(8);
  count.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(count).digest();
  const offset = mac[19] & 15;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}
export class AccountExtension {
  constructor(private readonly h: AccountHost) {}
  private state(): AccountState {
    return this.h.read().account ?? emptyAccountState();
  }
  private save(a: AccountState, users = this.h.read().users, sessions = this.h.read().sessions) {
    this.h.save({ ...this.h.read(), account: a, users, sessions });
  }
  private gate(feature: 'registration' | 'emailVerification' | 'passwordRecovery' | 'mfa') {
    if (!this.state().config[feature]) fail(404, 'ACCOUNT_FEATURE_DISABLED');
  }
  private csrf(req: Request) {
    if (!this.h.prelogin(req)) fail(403, 'AUTH_CSRF_INVALID');
  }
  private mint(
    kind: AccountState['tokens'][number]['kind'],
    userId?: string,
    payload: Record<string, string> = {},
    ttl = 15 * 60000,
  ): string {
    const raw = secret(),
      a = this.state();
    const tokens = a.tokens.filter(
      (t) => t.expires > this.h.now() && !(t.kind === kind && userId && t.userId === userId),
    );
    if (tokens.length >= 20000) fail(503, 'ACCOUNT_TOKEN_CAPACITY');
    this.save({
      ...a,
      tokens: [...tokens, { hash: hash(raw), kind, userId, payload, expires: this.h.now() + ttl }],
    });
    return raw;
  }
  private take(raw: string, kind: AccountState['tokens'][number]['kind']) {
    const a = this.state();
    const token = a.tokens.find((t) => t.hash === hash(raw) && t.kind === kind && t.expires > this.h.now());
    if (!token) return fail(400, 'ACCOUNT_TOKEN_INVALID');
    this.save({ ...a, tokens: a.tokens.filter((t) => t !== token) });
    return token;
  }
  private async send(to: string, purpose: 'register' | 'email' | 'reset', token: string) {
    if (!this.h.mail) return fail(503, 'ACCOUNT_MAIL_UNAVAILABLE');
    const url = new URL('/account/complete', this.state().config.publicOrigin);
    url.hash = new URLSearchParams({ purpose, token }).toString();
    try {
      await this.h.mail({ to, purpose, token, url: url.href });
    } catch {
      fail(503, 'ACCOUNT_MAIL_UNAVAILABLE');
    }
  }
  /** Public acceptance is not delivery confirmation; never expose an address-existence oracle. */
  private async sendAccepted(to: string, purpose: 'register' | 'reset', token: string) {
    try {
      await this.send(to, purpose, token);
    } catch (error) {
      if (!(error instanceof AuthError) || error.code !== 'ACCOUNT_MAIL_UNAVAILABLE') throw error;
      // A failed/uncertain delivery must not leave a usable action token behind.
      const a = this.state();
      this.save({ ...a, tokens: a.tokens.filter((t) => t.hash !== hash(token)) });
    }
  }
  private profile(id: string) {
    return this.state().profiles.find((p) => p.userId === id);
  }
  /** Called after password or OIDC verification. No authenticated session exists until MFA completes. */
  finish(req: Request, res: Response, id: string): unknown {
    const profile = this.profile(id);
    if (profile?.encryptedTotp) {
      if (!this.state().config.mfa) return fail(403, 'ACCOUNT_MFA_DISABLED');
      const user = this.h.read().users.find((u) => u.id === id && !u.disabled);
      if (!user) return fail(401, 'AUTH_LOGIN_FAILED');
      const pending = this.mint(
        'mfa',
        id,
        { credential: hash(user.passwordHash), role: user.role },
        5 * 60000,
      );
      this.h.setCookie(res, 'novel_mfa', pending, 5 * 60000);
      // Revoke the current browser's authenticated session before entering a pending flow.
      const old = hash(this.h.cookie(req, 'novel_session'));
      this.save(
        this.state(),
        this.h.read().users,
        this.h.read().sessions.filter((s) => s.tokenHash !== old),
      );
      this.h.setCookie(res, 'novel_session', '', 0);
      if (req.path === '/account/oidc/callback' && req.get('accept')?.includes('text/html'))
        return res.redirect(303, '/account/complete?oidc=mfa');
      return res.json({ mfaRequired: true });
    }
    return this.h.issue(req, res, id);
  }
  private verifyFactor(id: string, code: string, setupSecret?: string) {
    const a = this.state(),
      p = this.profile(id);
    if (!p && !setupSecret) return fail(401, 'ACCOUNT_MFA_FAILED');
    const counter = Math.floor(this.h.now() / 30000);
    const key = setupSecret ?? (p?.encryptedTotp && this.h.decrypt(p.encryptedTotp));
    const match =
      key &&
      [counter - 1, counter, counter + 1].find(
        (c) => c >= 0 && c > (p?.lastCounter ?? -1) && totp(key, c) === code,
      );
    if (typeof match === 'number') return { counter: match, recoveryHashes: p?.recoveryHashes ?? [] };
    if (!setupSecret && p?.recoveryHashes.includes(hash(code)))
      return { counter: p.lastCounter, recoveryHashes: p.recoveryHashes.filter((v) => v !== hash(code)) };
    return fail(401, 'ACCOUNT_MFA_FAILED');
  }
  install(router: Router, management = false) {
    const h = this.h;
    if (!management) {
      router.get('/account/features', (_req, res) => {
        const c = this.state().config;
        res.json({
          registration: c.registration,
          emailVerification: c.emailVerification,
          passwordRecovery: c.passwordRecovery,
          mfa: c.mfa,
          oidc: c.oidc.enabled,
        });
      });
      router.get('/account', (req, res) => {
        const id = h.self(req).user.id,
          p = this.profile(id);
        res.json({
          email: p?.email ?? '',
          emailVerified: p?.verified ?? false,
          mfaEnabled: !!p?.encryptedTotp,
          recoveryCodesRemaining: p?.recoveryHashes.length ?? 0,
        });
      });
      router.post('/account/register', async (req, res) => {
        this.gate('registration');
        this.csrf(req);
        h.rate(req, 'registration');
        const input = z
          .object({
            username: z.string().regex(/^[a-z0-9][a-z0-9_.-]{2,63}$/),
            email,
            password: z.string(),
            turnstileToken: z.string().optional(),
          })
          .strict()
          .parse(req.body);
        await h.turnstile(input.turnstileToken);
        this.gate('registration');
        if (!h.read().users.some((u) => u.role === 'superadmin' && !u.disabled))
          fail(409, 'AUTH_BOOTSTRAP_REQUIRED');
        const hashed = passwordHash(h.password(input.password, input.username));
        if (
          !h.read().users.some((u) => u.username === input.username) &&
          !this.state().profiles.some((p) => p.email === input.email)
        ) {
          const raw = this.mint('register', undefined, {
            username: input.username,
            email: input.email,
            passwordHash: hashed,
          });
          await this.sendAccepted(input.email, 'register', raw);
        }
        res.status(202).json({ ok: true });
      });
      router.post('/account/register/complete', (req, res) => {
        this.gate('registration');
        this.csrf(req);
        h.rate(req, 'register-complete');
        const { token } = z.object({ token: tokenInput }).strict().parse(req.body),
          t = this.take(token, 'register');
        if (!h.read().users.some((u) => u.role === 'superadmin' && !u.disabled))
          fail(409, 'AUTH_BOOTSTRAP_REQUIRED');
        const a = this.state();
        if (
          h.read().users.length >= 10000 ||
          h.read().users.some((u) => u.username === t.payload.username) ||
          a.profiles.some((p) => p.email === t.payload.email)
        )
          fail(409, 'ACCOUNT_UNAVAILABLE');
        const id = randomUUID();
        this.save(
          {
            ...a,
            profiles: [
              ...a.profiles,
              { userId: id, email: t.payload.email, verified: true, lastCounter: -1, recoveryHashes: [] },
            ],
          },
          [
            ...h.read().users,
            {
              id,
              username: t.payload.username,
              passwordHash: t.payload.passwordHash,
              role: 'writer',
              disabled: false,
              createdAt: new Date(h.now()).toISOString(),
            },
          ],
        );
        res.status(201).json({ ok: true });
      });
      router.post('/account/email', async (req, res) => {
        this.gate('emailVerification');
        const id = h.self(req).user.id;
        h.rate(req, id);
        const input = z.object({ email }).strict().parse(req.body);
        if (this.state().profiles.some((p) => p.email === input.email && p.userId !== id))
          fail(409, 'ACCOUNT_EMAIL_UNAVAILABLE');
        const raw = this.mint('email', id, { email: input.email });
        await this.send(input.email, 'email', raw);
        res.status(202).json({ ok: true });
      });
      router.post('/account/email/complete', (req, res) => {
        this.gate('emailVerification');
        const id = h.self(req).user.id;
        h.rate(req, id);
        const { token } = z.object({ token: tokenInput }).strict().parse(req.body);
        const t = this.take(token, 'email');
        if (
          t.userId !== id ||
          this.state().profiles.some((p) => p.email === t.payload.email && p.userId !== id)
        )
          fail(400, 'ACCOUNT_TOKEN_INVALID');
        const a = this.state(),
          p = this.profile(id) ?? { userId: id, lastCounter: -1, recoveryHashes: [], verified: false };
        this.save({
          ...a,
          tokens: a.tokens.filter((v) => v.userId !== id || v.kind !== 'reset'),
          profiles: [
            ...a.profiles.filter((p) => p.userId !== id),
            { ...p, email: t.payload.email, verified: true },
          ],
        });
        res.json({ ok: true });
      });
      router.post('/account/recovery', async (req, res) => {
        this.gate('passwordRecovery');
        this.csrf(req);
        h.rate(req, 'recovery');
        const input = z.object({ email }).strict().parse(req.body);
        const p = this.state().profiles.find((p) => p.email === input.email && p.verified);
        const user = p && h.read().users.find((u) => u.id === p.userId && !u.disabled);
        if (user) {
          const raw = this.mint('reset', user.id, { passwordHash: user.passwordHash, email: input.email });
          await this.sendAccepted(input.email, 'reset', raw);
        }
        res.status(202).json({ ok: true });
      });
      router.post('/account/recovery/complete', (req, res) => {
        this.gate('passwordRecovery');
        this.csrf(req);
        h.rate(req, 'recovery-complete');
        const input = z.object({ token: tokenInput, password: z.string() }).strict().parse(req.body);
        const t = this.state().tokens.find(
          (t) => t.hash === hash(input.token) && t.kind === 'reset' && t.expires > h.now(),
        );
        if (!t) return fail(400, 'ACCOUNT_TOKEN_INVALID');
        const user = h
          .read()
          .users.find((u) => u.id === t.userId && !u.disabled && u.passwordHash === t.payload.passwordHash);
        const profile = t.userId ? this.profile(t.userId) : undefined;
        if (!user || !profile?.verified || profile.email !== t.payload.email)
          return fail(400, 'ACCOUNT_TOKEN_INVALID');
        const hashed = passwordHash(h.password(input.password, user.username, user.passwordHash));
        const a = this.state();
        this.save(
          { ...a, tokens: a.tokens.filter((v) => v.userId !== t.userId) },
          h.read().users.map((u) => (u.id === t.userId ? { ...u, passwordHash: hashed } : u)),
          h.read().sessions.filter((s) => s.userId !== t.userId),
        );
        res.json({ ok: true });
      });
      router.post('/account/mfa/setup', (req, res) => {
        this.gate('mfa');
        const id = h.self(req).user.id;
        h.rate(req, id);
        if (this.profile(id)?.encryptedTotp) fail(409, 'ACCOUNT_MFA_EXISTS');
        const key = base32(randomBytes(20)),
          token = this.mint('setup', id, { encryptedSecret: h.encrypt(key) }, 5 * 60000);
        res.json({
          token,
          secret: key,
          uri: `otpauth://totp/NovelAgent:${encodeURIComponent(id)}?secret=${key}&issuer=NovelAgent&algorithm=SHA1&digits=6&period=30`,
        });
      });
      router.post('/account/mfa/enable', (req, res) => {
        this.gate('mfa');
        const id = h.self(req).user.id;
        h.rate(req, id);
        const input = z
          .object({ token: tokenInput, code: z.string().max(128) })
          .strict()
          .parse(req.body);
        const t = this.take(input.token, 'setup');
        if (t.userId !== id || this.profile(id)?.encryptedTotp) fail(400, 'ACCOUNT_TOKEN_INVALID');
        const v = this.verifyFactor(id, input.code, h.decrypt(t.payload.encryptedSecret)),
          codes = Array.from({ length: 10 }, () => randomBytes(10).toString('hex'));
        const a = this.state(),
          p = this.profile(id) ?? { userId: id, verified: false, lastCounter: -1, recoveryHashes: [] };
        this.save(
          {
            ...a,
            profiles: [
              ...a.profiles.filter((p) => p.userId !== id),
              {
                ...p,
                encryptedTotp: t.payload.encryptedSecret,
                lastCounter: v.counter,
                recoveryHashes: codes.map(hash),
              },
            ],
          },
          h.read().users,
          h.read().sessions.filter((s) => s.userId !== id),
        );
        h.setCookie(res, 'novel_session', '', 0);
        res.json({ recoveryCodes: codes });
      });
      router.post('/account/mfa/verify', (req, res) => {
        this.gate('mfa');
        this.csrf(req);
        h.rate(req, 'mfa');
        const { code } = z
          .object({ code: z.string().max(128) })
          .strict()
          .parse(req.body);
        const raw = h.cookie(req, 'novel_mfa'),
          a = this.state(),
          t = a.tokens.find((t) => t.kind === 'mfa' && t.hash === hash(raw) && t.expires > h.now());
        if (!t?.userId) fail(401, 'ACCOUNT_MFA_FAILED');
        const id = t!.userId!,
          user = h.read().users.find((u) => u.id === id && !u.disabled);
        if (!user || t!.payload.credential !== hash(user.passwordHash) || t!.payload.role !== user.role)
          fail(401, 'ACCOUNT_MFA_FAILED');
        const v = this.verifyFactor(id, code);
        this.take(raw, 'mfa');
        const next = this.state();
        this.save({
          ...next,
          profiles: next.profiles.map((p) =>
            p.userId === id ? { ...p, lastCounter: v.counter, recoveryHashes: v.recoveryHashes } : p,
          ),
        });
        h.setCookie(res, 'novel_mfa', '', 0);
        return h.issue(req, res, id);
      });
      router.delete('/account/mfa', (req, res) => {
        this.gate('mfa');
        const id = h.self(req).user.id;
        h.rate(req, id);
        const { code } = z
          .object({ code: z.string().max(128) })
          .strict()
          .parse(req.body);
        this.verifyFactor(id, code);
        const a = this.state();
        this.save(
          {
            ...a,
            tokens: a.tokens.filter((t) => t.userId !== id),
            profiles: a.profiles.map((p) =>
              p.userId === id ? { ...p, encryptedTotp: undefined, recoveryHashes: [], lastCounter: -1 } : p,
            ),
          },
          h.read().users,
          h.read().sessions.filter((s) => s.userId !== id),
        );
        h.setCookie(res, 'novel_session', '', 0);
        res.json({ ok: true });
      });
    }
    this.installOidc(router, management);
    router.get('/account/config', (req, res) => {
      h.admin(req, 'security.read');
      res.json(this.publicConfig());
    });
    router.put('/account/config', (req, res) => {
      h.admin(req, 'security.manage');
      const input = z
        .object({
          registration: z.boolean(),
          emailVerification: z.boolean(),
          passwordRecovery: z.boolean(),
          mfa: z.boolean(),
          publicOrigin: z.string().max(2048),
          oidc: z
            .object({
              enabled: z.boolean(),
              issuer: z.string().max(2048),
              clientId: z.string().max(256),
              clientSecret: z.string().max(2048).optional(),
              authorizationEndpoint: z.string().max(2048),
              tokenEndpoint: z.string().max(2048),
              jwksUri: z.string().max(2048),
              redirectUri: z.string().max(2048),
            })
            .strict(),
        })
        .strict()
        .parse(req.body);
      const a = this.state();
      if ((input.registration || input.emailVerification || input.passwordRecovery) && !h.mail)
        fail(400, 'ACCOUNT_MAIL_UNAVAILABLE');
      if (input.registration || input.emailVerification || input.passwordRecovery)
        this.https(input.publicOrigin);
      if (!input.mfa && a.profiles.some((p) => p.encryptedTotp)) fail(409, 'ACCOUNT_MFA_IN_USE');
      const { clientSecret, ...oidc } = input.oidc;
      if (oidc.enabled) {
        for (const url of [
          oidc.issuer,
          oidc.authorizationEndpoint,
          oidc.tokenEndpoint,
          oidc.jwksUri,
          oidc.redirectUri,
        ])
          this.https(url);
        if (!oidc.clientId) fail(400, 'ACCOUNT_OIDC_CONFIG_INVALID');
      }
      this.save({
        ...a,
        config: {
          ...input,
          oidc: {
            ...oidc,
            encryptedClientSecret:
              clientSecret === undefined
                ? a.config.oidc.encryptedClientSecret
                : clientSecret
                  ? h.encrypt(clientSecret)
                  : '',
          },
        },
        tokens: [],
      });
      res.json(this.publicConfig());
    });
  }
  private publicConfig() {
    const c = this.state().config,
      { encryptedClientSecret, ...oidc } = c.oidc;
    return { ...c, oidc: { ...oidc, hasClientSecret: !!encryptedClientSecret } };
  }
  private https(value: string) {
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' || u.username || u.password || u.hash) throw new Error();
      return u;
    } catch {
      return fail(400, 'ACCOUNT_URL_INVALID');
    }
  }
  private installOidc(router: Router, management: boolean) {
    const h = this.h;
    if (!management) {
      router.post('/account/oidc/start', (req, res) => {
        this.csrf(req);
        h.rate(req, 'oidc');
        const c = this.state().config.oidc;
        if (!c.enabled) fail(404, 'ACCOUNT_FEATURE_DISABLED');
        const verifier = secret(),
          nonce = secret(),
          binding = secret();
        const state = this.mint(
          'oidc',
          undefined,
          { verifier, nonce, bindingHash: hash(binding), config: hash(JSON.stringify(c)) },
          5 * 60000,
        );
        h.setCookie(res, 'novel_oidc', binding, 5 * 60000, true);
        const url = new URL(c.authorizationEndpoint);
        url.search = new URLSearchParams({
          response_type: 'code',
          client_id: c.clientId,
          redirect_uri: c.redirectUri,
          scope: 'openid',
          state,
          nonce,
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256',
        }).toString();
        res.json({ url: url.href });
      });
      router.get('/account/oidc/callback', async (req, res) => {
        h.rate(req, 'oidc-callback');
        const c = this.state().config.oidc;
        if (!c.enabled) fail(404, 'ACCOUNT_FEATURE_DISABLED');
        const input = z.object({ state: tokenInput, code: z.string().min(1).max(4096) }).parse(req.query);
        const t = this.take(input.state, 'oidc');
        if (
          t.payload.bindingHash !== hash(h.cookie(req, 'novel_oidc')) ||
          t.payload.config !== hash(JSON.stringify(c))
        )
          fail(401, 'ACCOUNT_OIDC_FAILED');
        h.setCookie(res, 'novel_oidc', '', 0, true);
        try {
          const body = new URLSearchParams({
            grant_type: 'authorization_code',
            code: input.code,
            redirect_uri: c.redirectUri,
            client_id: c.clientId,
            code_verifier: t.payload.verifier,
          });
          if (c.encryptedClientSecret) body.set('client_secret', h.decrypt(c.encryptedClientSecret));
          const response = await h.fetcher(c.tokenEndpoint, {
            method: 'POST',
            body,
            redirect: 'error',
            signal: AbortSignal.timeout(10000),
          });
          if (!response.ok) throw new Error();
          const result = (await response.json()) as { id_token?: string };
          if (!result.id_token || result.id_token.length > 32768) throw new Error();
          const verified = await jwtVerify(
            result.id_token,
            createRemoteJWKSet(new URL(c.jwksUri), {
              timeoutDuration: 5000,
              [customFetch]: (url, options) => h.fetcher(url, { ...options, redirect: 'error' }),
            }),
            {
              issuer: c.issuer,
              audience: c.clientId,
              algorithms: ['RS256', 'PS256', 'ES256'],
              requiredClaims: ['sub', 'iat', 'exp', 'nonce'],
              currentDate: new Date(h.now()),
              maxTokenAge: '10 minutes',
            },
          );
          if (
            verified.payload.nonce !== t.payload.nonce ||
            (Array.isArray(verified.payload.aud) &&
              verified.payload.aud.length > 1 &&
              verified.payload.azp !== c.clientId) ||
            (verified.payload.azp !== undefined && verified.payload.azp !== c.clientId)
          )
            throw new Error();
          if (JSON.stringify(c) !== JSON.stringify(this.state().config.oidc)) throw new Error();
          // Never auto-link by email or auto-create an identity from an unrecognized provider subject.
          const p = this.state().profiles.find(
            (p) => p.oidcIssuer === c.issuer && p.oidcSubject === verified.payload.sub,
          );
          if (!p) return fail(403, 'ACCOUNT_OIDC_NOT_LINKED');
          const user = h.read().users.find((u) => u.id === p.userId && !u.disabled);
          if (!user) return fail(403, 'ACCOUNT_OIDC_NOT_LINKED');
          return this.finish(req, res, p.userId);
        } catch (error) {
          if (error instanceof AuthError) throw error;
          return fail(401, 'ACCOUNT_OIDC_FAILED');
        }
      });
    }
    router.put('/account/oidc/users/:id', (req, res) => {
      h.admin(req, 'security.manage');
      const { issuer, subject } = z
        .object({ issuer: z.string().max(2048), subject: z.string().min(1).max(512) })
        .strict()
        .parse(req.body);
      this.https(issuer);
      const id = String(req.params.id);
      if (!h.read().users.some((u) => u.id === id)) fail(404, 'AUTH_USER_NOT_FOUND');
      const a = this.state();
      if (a.profiles.some((p) => p.userId !== id && p.oidcIssuer === issuer && p.oidcSubject === subject))
        fail(409, 'ACCOUNT_OIDC_ALREADY_LINKED');
      const p = this.profile(id) ?? { userId: id, verified: false, lastCounter: -1, recoveryHashes: [] };
      this.save({
        ...a,
        profiles: [
          ...a.profiles.filter((p) => p.userId !== id),
          { ...p, oidcIssuer: issuer, oidcSubject: subject },
        ],
      });
      res.json({ ok: true });
    });
  }
}
