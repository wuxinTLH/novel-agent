import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ZodError } from 'zod';
import { AuthError } from '../auth/auth.js';
import { installSecurityKernel } from '../../core/security-kernel.js';
import { createRequestLimiter } from '../../core/request-limiter.js';
import { trustedPublicOrigin } from '../../core/trusted-origin.js';
import { completeInitialization, initConfig, initJournal, initToken, isFreshInitDirectory } from './state.js';
import type { WebHostingOptions } from '../../core/web-hosting.js';

/** No auth router, admin service, tenant worker, gateway, Store or business API is assembled. */
export function createInitializationApplication(options: { dir: string; env: NodeJS.ProcessEnv; port?: number } & WebHostingOptions) {
  if (!isFreshInitDirectory(options.dir)) throw new Error('INIT_DIRECTORY_NOT_EMPTY');
  const env = { ...options.env };
  const trusted = trustedPublicOrigin(env.NOVEL_TRUSTED_PUBLIC_ORIGIN);
  const holder = initToken(options.dir, env);
  const expected = createHash('sha256').update(holder.token).digest();
  const app = express();
  app.set('case sensitive routing', true); app.set('strict routing', true);
  installSecurityKernel(app, { maxContentLength: 64 * 1024 });
  const limiter = createRequestLimiter({ limit: 120 });
  const sensitiveLimiter = createRequestLimiter({ limit: 20 });
  let completed = false;
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const quota = limiter.check(req.socket.remoteAddress || 'unknown');
    if (!quota.allowed) return res.status(429).json({ code: 'INIT_RATE_LIMITED', error: '请求过于频繁。' });
    const host = req.get('host') || '';
    let expectedOrigin: string | undefined;
    if (trusted) { if (host === new URL(trusted).host) expectedOrigin = trusted; }
    else if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::(?:[1-9]\d{0,4}))?$/.test(host)) {
      const url = new URL('http://' + host);
      if (Number(url.port || 80) === (options.port || req.socket.localPort)) expectedOrigin = url.origin;
    }
    if (!expectedOrigin || (req.get('origin') !== undefined && req.get('origin') !== expectedOrigin) || req.get('sec-fetch-site') === 'cross-site')
      return res.status(403).json({ code: 'INIT_ORIGIN_REJECTED', error: '初始化来源不受信任。' });
    if (req.originalUrl.includes('?')) return res.status(400).json({ code: 'INIT_QUERY_FORBIDDEN', error: '初始化不接受 URL 参数。' });
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ code: 'INIT_METHOD_REJECTED', error: '不支持的方法。' });
    next();
  });
  app.get('/health', (_req, res) => res.json({ ok: true, mode: 'initialization' }));
  app.get('/api/init/status', (_req, res) => {
    if (!completed && fs.existsSync(path.join(options.dir, initJournal)))
      return res.status(503).json({ code: 'INIT_RECOVERY_REQUIRED', error: '初始化提交失败，请停机核对。' });
    return res.json({ required: !completed, ...(completed ? { restartRequired: true } : {}) });
  });
  app.use('/api/init', (req, res, next) => {
    if (completed) return res.status(409).json({ code: 'INIT_ALREADY_COMPLETED', error: '初始化已完成，请重启。' });
    if (fs.existsSync(path.join(options.dir, initJournal))) return res.status(503).json({ code: 'INIT_RECOVERY_REQUIRED', error: '初始化提交失败，请停机核对。' });
    const quota = sensitiveLimiter.check(req.socket.remoteAddress || 'unknown');
    if (!quota.allowed) return res.status(429).json({ code: 'INIT_RATE_LIMITED', error: '请求过于频繁。' });
    const token = req.get('x-init-token') || '';
    if (!token || token.length > 4096 || !timingSafeEqual(expected, createHash('sha256').update(token).digest()))
      return res.status(401).json({ code: 'INIT_TOKEN_REQUIRED', error: '需要有效的初始化令牌。' });
    next();
  });
  app.get('/api/init/config', (_req, res) => res.json(initConfig(env)));
  app.post('/api/init/complete', (req, res, next) => {
    if (!req.is('application/json') || req.get('content-encoding')) return res.status(415).json({ code: 'INIT_JSON_REQUIRED', error: '请提交 JSON。' });
    next();
  }, express.json({ limit: '64kb', strict: true, inflate: false }), (req, res) => {
    try {
      completeInitialization(options.dir, env, req.body);
      completed = true;
      return res.json({ required: false, restartRequired: true });
    } catch (error) {
      const invalid = error instanceof ZodError || (error instanceof AuthError && error.status < 500) ||
        (error instanceof Error && /^(?:HARDENED_|NOVEL_TRUSTED_PUBLIC_ORIGIN_|SMS_CONFIG_|SERVER_SMS_|INIT_DATABASE_)/.test(error.message));
      return res.status(invalid ? 400 : 503).json({ code: invalid ? 'INIT_INPUT_INVALID' : 'INIT_COMMIT_FAILED', error: invalid ? '请检查配置、账号、手机号与密码。' : '初始化未完成，请停机核对；不要删除恢复日志。' });
    }
  });
  if (options.serveWeb !== false && options.webRoot && fs.existsSync(path.join(options.webRoot, 'index.html'))) {
    app.get('/', (_req, res) => res.redirect(302, '/init'));
    app.get('/init', (_req, res) => res.sendFile(path.join(options.webRoot!, 'index.html')));
    // Only build assets required by the Init shell; no SPA fallback or arbitrary root static files.
    app.use('/assets', express.static(path.join(options.webRoot, 'assets'), { dotfiles: 'deny', index: false, fallthrough: false }));
    app.use('/themes', express.static(path.join(options.webRoot, 'themes'), { dotfiles: 'deny', index: false, fallthrough: false }));
  }
  app.use((_req, res) => res.status(404).json({ code: 'INIT_ROUTE_NOT_FOUND', error: '初始化模式不提供此入口。' }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof error === 'object' && error && 'status' in error && error.status === 413 ? 413 : 400;
    res.status(status).json({ code: 'INIT_REQUEST_INVALID', error: '请求无效。' });
  });
  return { app, tokenFile: holder.generated ? path.join(options.dir, '.init-token') : undefined };
}
