import express from 'express';
import { hasPermission } from '../../../../../shared/permissions.js';
import http from 'node:http';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { AuthService } from '../../features/auth/auth.js';
import { installHttpFallbacks } from '../http.js';
import { readAuthMode } from '../../infrastructure/storage/storage-config.js';
import { mainPlatformAccountLockCoordinator } from './platform-account-lock.js';
import { createOriginPolicy } from '../trusted-origin.js';
import { createRequestLimiter } from '../request-limiter.js';

export interface IsolatedTenantService {
  register(app: express.Express): void;
  close?(): Promise<void>;
}
export interface IsolatedTenantApplicationOptions {
  dir: string;
  port: number;
  appRoot: string;
  auth: AuthService;
  services?: readonly IsolatedTenantService[];
  enabled: boolean;
  waitForControlPlaneIdle?: () => Promise<void>;
  /** Explicit local alias ports allowed by the loopback gateway. */
  trustedAliasPorts?: readonly number[];
}
export interface TenantRuntime {
  readonly dir: string;
  readonly worker: Worker;
  readonly ready: Promise<number>;
  state: 'starting' | 'ready' | 'failed' | 'closing' | 'closed';
}
const capabilityHeader = 'x-novel-runtime-capability';
const unavailable = () =>
  Object.assign(new Error('Tenant runtime unavailable.'), {
    status: 503,
    code: 'TENANT_RUNTIME_UNAVAILABLE',
  });

/** Control plane never constructs a business Store/Runner or performs synchronous SQL. */
export function createIsolatedTenantApplication(options: IsolatedTenantApplicationOptions) {
  const app = express();
  const contexts = new Map<string, TenantRuntime>();
  const capabilities = new Map<TenantRuntime, string>();
  const csrfTokens = new Map<TenantRuntime, string>();
  const exits = new Map<TenantRuntime, Promise<void>>();
  const active = new Set<Promise<void>>();
  const shutdownFailures = new Set<TenantRuntime>();
  const poison = new Map<TenantRuntime, () => void>();
  const mode = readAuthMode(options.dir);
  let closing = false;
  let closeTask: Promise<void> | undefined;
  let maintenance = false;
  let maintenanceFailed = false;
  const inFlight = new Set<express.Response>();

  // Authenticated mode needs explicit unique runtime ownership discovery before extension support.
  app.use(['/api/platform-extension', '/api/projects/:projectId/platform-extension-pairings'], (_req, res, next) => {
    if (options.enabled) return res.status(501).json({ code: 'EXTENSION_AUTH_MODE_UNSUPPORTED', error: '扩展配对目前仅支持单用户模式；认证多租户模式尚未实现唯一来源路由。' });
    next();
  });
  // Deliberately no global body parser: delegation preserves exact wire bytes and uploads.
  const limiter = createRequestLimiter();
  const originAllowed = createOriginPolicy(options.port, undefined, options.trustedAliasPorts);
  app.use((req, res, next) => {
    // OIDC uses a top-level cross-site GET redirect. Only this exact callback
    // bypasses the fetch-site test; its handler verifies single-use state,
    // browser binding, PKCE and signed nonce before issuing a session.
    const oidcCallback = req.method === 'GET' && req.path === '/api/auth/account/oidc/callback';
    const localExtension = !options.enabled && /^\/api\/platform-extension(?:\/|$)/i.test(req.path) && req.get('host') === `127.0.0.1:${options.port}` && /^chrome-extension:\/\/[a-p]{32}$/.test(req.get('origin') || '') && !req.get('cookie');
    if (!localExtension && !originAllowed(req, oidcCallback))
      return res.status(403).json({ code: 'LOCAL_ORIGIN_REJECTED', error: '只允许本机或局域网来源访问。' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; frame-src 'self' https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'none'",
    );
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (req.path.toLowerCase().startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      const quota = limiter.check(req.ip || 'local');
      if (!quota.allowed)
        return res.status(429).setHeader('Retry-After', String(quota.retryAfter))
          .json({ code: 'RATE_LIMITED', retryable: true });
    }
    if (closing) return res.status(503).json({ code: 'TENANT_RUNTIME_CLOSING', retryable: false });
    const maintenanceStatus = /^\/api\/admin\/online-maintenance(?:\/|$)/i.test(req.path);
    if (maintenance && !maintenanceStatus)
      return res.status(503).json({ code: maintenanceFailed ? 'MAINTENANCE_RECOVERY_REQUIRED' : 'MAINTENANCE_IN_PROGRESS', retryable: !maintenanceFailed });
    if (!maintenanceStatus) {
      inFlight.add(res);
      const done = () => inFlight.delete(res);
      res.once('finish', done);
      res.once('close', done);
    }
    next();
  });
  app.use('/api/auth', express.json({ limit: '16mb' }), options.auth.router);
  app.get('/api/services/user', (_req, res) =>
    res.json({
      id: 'User',
      enabled: options.enabled,
      authenticationReady: true,
      mode: options.enabled ? 'verified-user' : 'local',
    }),
  );

  // Guard precedes ALL service registration: SQLconnect cannot bypass authorization.
  app.use(async (req, res, next) => {
    const route = req.path.toLowerCase();
    if (
      !options.enabled ||
      !(
        route === '/api' ||
        route.startsWith('/api/') ||
        route === '/uploads' ||
        route.startsWith('/uploads/')
      ) ||
      route === '/api/admin' ||
      route.startsWith('/api/admin/')
    )
      return next();
    try {
      const principal = await options.auth.resolve(req);
      if (!principal) return res.status(401).json({ code: 'AUTH_REQUIRED', error: '请先登录。' });
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !options.auth.requireCsrf(req))
        return res.status(403).json({ code: 'AUTH_CSRF_REQUIRED', error: '会话校验失败。' });
      if (route.startsWith('/api/sqlconnect') && !hasPermission(principal.role, ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? 'storage.read' : 'sql.initialize'))
        return res.status(403).json({ code: 'AUTH_FORBIDDEN', error: '需要超级管理员权限。' });
      res.locals.isolatedOwnerId = principal.id;
      next();
    } catch {
      next(unavailable());
    }
  });
  for (const service of options.services || []) service.register(app);

  function runtime(ownerId: string): TenantRuntime {
    const existing = contexts.get(ownerId);
    if (existing) return existing;
    if (contexts.size >= 32)
      throw Object.assign(new Error('Tenant runtime capacity reached.'), {
        status: 429,
        code: 'TENANT_RUNTIME_CAPACITY',
      });
    const capability = randomBytes(32).toString('hex');
    const dir =
      !options.enabled || mode.legacyOwnerId === ownerId
        ? options.dir
        : path.join(options.dir, 'users', createHash('sha256').update(ownerId).digest('hex'));
    const moduleUrl = new URL(
      import.meta.url.endsWith('.ts') ? './tenant-runtime-worker.ts' : './tenant-runtime-worker.js',
      import.meta.url,
    );
    const locks = mainPlatformAccountLockCoordinator();
    const platformAccountLocks = locks.credentials();
    const workerData = {
      platformAccountLocks,
      root: options.dir,
      dir,
      ownerId: options.enabled ? ownerId : undefined,
      port: options.port,
      trustedAliasPorts: options.trustedAliasPorts,
      appRoot: options.appRoot,
      inheritEnvironment: !options.enabled,
      capability,
    };
    const worker = moduleUrl.pathname.endsWith('.ts')
      ? new Worker(
          "const {workerData}=require('node:worker_threads'); import('tsx/esm/api').then(({tsImport})=>tsImport(workerData.moduleUrl,workerData.moduleUrl)).catch(()=>{require('node:worker_threads').parentPort.postMessage({type:'failed'});process.exitCode=1;});",
          {
            eval: true,
            workerData: { ...workerData, moduleUrl: moduleUrl.href },
            stdout: true,
            stderr: true,
          },
        )
      : new Worker(moduleUrl, { workerData, stdout: true, stderr: true });
    locks.bindWorker(worker, platformAccountLocks);
    // Worker/driver exceptions can contain credentials. Never forward their output.
    worker.stdout?.resume();
    worker.stderr?.resume();
    let resolveReady!: (port: number) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<number>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const entry: TenantRuntime = { dir, worker, ready, state: 'starting' };
    contexts.set(ownerId, entry);
    capabilities.set(entry, capability);
    let exited = false;
    let poisonTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => fail(), 30_000);
    const fail = () => {
      if (closing) shutdownFailures.add(entry);
      clearTimeout(timer);
      if (entry.state !== 'closed') entry.state = 'failed';
      rejectReady(unavailable());
      if (exited || poisonTimer) return;
      // Reconcile a failed runtime by draining/aborting, never by starting a replacement.
      // Bound cleanup even if startup failed before its storage binding was returned.
      worker.postMessage({ type: 'close' });
      poisonTimer = setTimeout(() => {
        void worker.terminate();
      }, 15_000);
      poisonTimer.unref();
    };
    poison.set(entry, fail);
    worker.on('message', (message: { type?: string; port?: number; csrfToken?: string }) => {
      if (
        message.type === 'ready' &&
        entry.state === 'starting' &&
        Number.isInteger(message.port) &&
        message.port! > 0 &&
        message.port! <= 65535 &&
        typeof message.csrfToken === 'string' &&
        message.csrfToken.length > 0 &&
        message.csrfToken.length <= 256
      ) {
        csrfTokens.set(entry, message.csrfToken);
        clearTimeout(timer);
        entry.state = 'ready';
        resolveReady(message.port!);
      } else if (message.type === 'failed') fail();
    });
    worker.on('error', fail);
    exits.set(
      entry,
      new Promise((resolve) =>
        worker.once('exit', (code) => {
          exited = true;
          clearTimeout(poisonTimer);
          if ((closing || maintenance) && code !== 0) shutdownFailures.add(entry);
          if (entry.state !== 'closing') fail();
          else {
            clearTimeout(timer);
            rejectReady(unavailable());
            entry.state = 'closed';
          }
          resolve();
        }),
      ),
    );
    void ready.catch(() => {});
    return entry;
  }

  app.use((req, res, next) => {
    const route = req.path.toLowerCase();
    // Unhandled admin routes are outer 404s, never an anonymous tenant selection.
    if (route === '/api/admin' || route.startsWith('/api/admin/')) return next();
    if (!(
      route === '/api' ||
      route.startsWith('/api/') ||
      route === '/uploads' ||
      route.startsWith('/uploads/')
    ))
      return next();
    const task = (async () => {
      const entry = runtime(options.enabled ? String(res.locals.isolatedOwnerId || '') : 'root');
      const port = await entry.ready;
      if (entry.state !== 'ready' || closing) throw unavailable();
      if (req.destroyed || res.destroyed) return;
      await new Promise<void>((resolve) => {
        const headers = { ...req.headers, [capabilityHeader]: capabilities.get(entry)! };
        // Services must not consume delegated bodies; never silently reserialize them.
        if (req.readableEnded && Number(req.headers['content-length'] || 0) > 0) {
          next(unavailable());
          resolve();
          return;
        }
        const upstream = http.request(
          { host: '127.0.0.1', port, method: req.method, path: req.originalUrl, headers, agent: false },
          (incoming) => {
            res.writeHead(incoming.statusCode || 502, incoming.headers);
            incoming.on('error', () => {
              if (!res.destroyed && !closing) poison.get(entry)?.();
              res.destroy();
            });
            incoming.pipe(res);
          },
        );
        let clientAborted = false;
        const abort = () => {
          clientAborted = true;
          upstream.destroy();
        };
        req.once('aborted', abort);
        const finish = () => {
          if (!res.writableFinished) {
            clientAborted = true;
            upstream.destroy();
          }
          req.off('aborted', abort);
          resolve();
        };
        res.once('close', finish);
        res.once('finish', finish);
        upstream.once('error', () => {
          // Ambiguous I/O failure may follow a committed write: never replay or create another Runner.
          if (!clientAborted && !res.destroyed && !closing) poison.get(entry)?.();
          if (!res.destroyed && !res.headersSent)
            res.status(503).json({ code: 'TENANT_RUNTIME_UNAVAILABLE', retryable: false });
          else if (!res.destroyed) res.destroy();
          resolve();
        });
        req.pipe(upstream);
      });
    })().catch(next);
    active.add(task);
    void task.finally(() => active.delete(task));
  });
  app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    const failure = error as { code?: string; status?: number };
    if (failure?.code === 'TENANT_RUNTIME_UNAVAILABLE' || failure?.code === 'TENANT_RUNTIME_CAPACITY') {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.status(failure.status || 503).json({ code: failure.code, retryable: false });
      return;
    }
    next(error);
  });
  installHttpFallbacks(app, options.appRoot);
  return {
    app,
    contexts,
    /** A full application barrier: no new control-plane writes, no running tenant/background workers. */
    async acquireQuiescence(signal?: AbortSignal) {
      if (maintenance || closing) throw new Error('MAINTENANCE_ALREADY_ACTIVE');
      const failedBefore = new Set(shutdownFailures);
      maintenance = true;
      let held = true;
      const deadline = Date.now() + 30_000;
      try {
        // The task HTTP response must finish before starting this barrier.
        while (inFlight.size) {
          if (signal?.aborted) throw new Error('MAINTENANCE_CANCELLED');
          if (Date.now() > deadline) throw new Error('MAINTENANCE_DRAIN_TIMEOUT');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (options.waitForControlPlaneIdle) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              options.waitForControlPlaneIdle(),
              new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('MAINTENANCE_CONTROL_DRAIN_TIMEOUT')), 30_000); }),
            ]);
          } finally { clearTimeout(timer); }
        }
        for (const entry of contexts.values()) {
          if (entry.state === 'failed') throw new Error('MAINTENANCE_RUNTIME_UNHEALTHY');
          entry.state = 'closing';
          entry.worker.postMessage({ type: 'close' });
        }
        for (const entry of contexts.values()) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const exited = await Promise.race([
            exits.get(entry)!.then(() => true),
            new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 30_000); }),
          ]);
          clearTimeout(timer);
          if (!exited || entry.state !== 'closed') throw new Error('MAINTENANCE_RUNTIME_DRAIN_FAILED');
        }
        await Promise.allSettled([...active]);
        if (shutdownFailures.size !== failedBefore.size) throw new Error('MAINTENANCE_RUNTIME_SHUTDOWN_FAILED');
        contexts.clear();
        capabilities.clear();
        csrfTokens.clear();
        exits.clear();
        poison.clear();
        if (signal?.aborted) throw new Error('MAINTENANCE_CANCELLED');
        return {
          scope: 'all-tenants-and-control-plane' as const,
          assertHeld() {
            if (!held || !maintenance || maintenanceFailed || closing || contexts.size)
              throw new Error('MAINTENANCE_LEASE_NOT_HELD');
          },
          async release() {
            if (!held) return;
            held = false;
            maintenance = false;
          },
        };
      } catch (error) {
        held = false;
        // A partial shutdown or outstanding request can still write. Never take a snapshot.
        // Remain unavailable until restart rather than resurrecting ambiguous workers.
        maintenanceFailed = true;
        throw error;
      }
    },
    /** Outer business services must use the same worker-owned CSRF token as proxied APIs. */
    async requireRuntimeCsrf(req: express.Request, res: express.Response, next: express.NextFunction) {
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
      const supplied = req.get('X-Platform-CSRF');
      const reject = () => res.status(403).json({
        code: 'PLATFORM_CSRF_REQUIRED', error: '操作校验已过期，请刷新页面后重试。',
      });
      // Missing/oversized tokens cannot cause a lazy worker start.
      if (!supplied || supplied.length > 256) return reject();
      const owner = options.enabled ? res.locals.isolatedOwnerId : 'root';
      if (typeof owner !== 'string' || !owner) return reject();
      const entry = contexts.get(owner);
      // A legitimate client obtains its token from a ready runtime's health endpoint.
      if (!entry) return reject();
      try {
        await entry.ready;
        if (closing || entry.state !== 'ready') throw unavailable();
        const expected = Buffer.from(csrfTokens.get(entry) || '');
        const actual = Buffer.from(supplied);
        if (!expected.length || actual.length !== expected.length || !timingSafeEqual(actual, expected))
          return reject();
        next();
      } catch (error) {
        next(error);
      }
    },
    close() {
      return (closeTask ??= (async () => {
        closing = true;
        let failed = false;
        // Ask workers to abort runners and drain listeners before terminating anything.
        for (const entry of contexts.values()) {
          entry.state = 'closing';
          entry.worker.postMessage({ type: 'close' });
        }
        await Promise.all(
          [...contexts.values()].map(async (entry) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const graceful = await Promise.race([
              exits.get(entry)!.then(() => true),
              new Promise<false>((resolve) => {
                timer = setTimeout(() => resolve(false), 15_000);
              }),
            ]);
            clearTimeout(timer);
            if (!graceful) {
              failed = true;
              await entry.worker.terminate();
            }
          }),
        );
        await Promise.allSettled([...active]);
        for (const service of options.services || []) {
          try {
            await service.close?.();
          } catch {
            failed = true;
          }
        }
        failed ||= shutdownFailures.size > 0;
        contexts.clear();
        capabilities.clear();
        csrfTokens.clear();
        exits.clear();
        poison.clear();
        shutdownFailures.clear();
        if (failed)
          throw Object.assign(new Error('Tenant runtime shutdown incomplete.'), {
            code: 'TENANT_RUNTIME_SHUTDOWN_FAILED',
          });
      })());
    },
  };
}
