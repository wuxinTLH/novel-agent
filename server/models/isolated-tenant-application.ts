import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { AuthService } from './auth.js';
import { installHttpFallbacks } from './http.js';
import { readAuthMode } from './storage-config.js';

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
  const exits = new Map<TenantRuntime, Promise<void>>();
  const active = new Set<Promise<void>>();
  const shutdownFailures = new Set<TenantRuntime>();
  const poison = new Map<TenantRuntime, () => void>();
  const mode = readAuthMode(options.dir);
  let closing = false;
  let closeTask: Promise<void> | undefined;

  // Deliberately no global body parser: delegation preserves exact wire bytes and uploads.
  const windows = new Map<string, number[]>();
  app.use((req, res, next) => {
    const allowed = (value: string) => {
      try {
        const url = new URL(value);
        return (
          url.protocol === 'http:' &&
          ['5173', String(options.port)].includes(url.port) &&
          (['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) ||
            /^10\./.test(url.hostname) ||
            /^192\.168\./.test(url.hostname) ||
            /^172\.(1[6-9]|2\d|3[0-1])\./.test(url.hostname))
        );
      } catch {
        return false;
      }
    };
    if (
      !allowed(`http://${req.get('host') || ''}`) ||
      (req.get('origin') && !allowed(req.get('origin')!)) ||
      req.get('sec-fetch-site') === 'cross-site'
    )
      return res.status(403).json({ code: 'LOCAL_ORIGIN_REJECTED', error: '只允许本机或局域网来源访问。' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'none'",
    );
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (req.path.toLowerCase().startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      const now = Date.now();
      const key = req.ip || 'local';
      const recent = (windows.get(key) || []).filter((time) => now - time < 60_000);
      recent.push(now);
      windows.set(key, recent);
      if (recent.length > 240) return res.status(429).json({ code: 'RATE_LIMITED', retryable: true });
    }
    if (closing) return res.status(503).json({ code: 'TENANT_RUNTIME_CLOSING', retryable: false });
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
      if (route.startsWith('/api/sqlconnect') && principal.role !== 'superadmin')
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
    const workerData = {
      root: options.dir,
      dir,
      ownerId: options.enabled ? ownerId : undefined,
      port: options.port,
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
    worker.on('message', (message: { type?: string; port?: number }) => {
      if (
        message.type === 'ready' &&
        entry.state === 'starting' &&
        Number.isInteger(message.port) &&
        message.port! > 0 &&
        message.port! <= 65535
      ) {
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
          if (closing && code !== 0 && entry.state !== 'failed') shutdownFailures.add(entry);
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
