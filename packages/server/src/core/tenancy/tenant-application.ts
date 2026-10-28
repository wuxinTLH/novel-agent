import express from 'express';
import { hasPermission } from '../../../../../shared/permissions.js';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { AuthService } from '../../features/auth/auth.js';
import { createApplication } from '../application.js';
import { createServiceContext, type ServiceContext, type FeatureService } from '../context.js';
import { installHttpFallbacks, installHttpPolicy } from '../http.js';
import { activateScopedStorage, readAuthMode } from '../../infrastructure/storage/storage-config.js';

export interface TenantApplicationOptions {
  dir: string;
  port: number;
  appRoot: string;
  auth: AuthService;
  services?: readonly FeatureService[];
}
/** No singleton context switch: each verified immutable identity owns a complete application. */
export function createTenantApplication(options: TenantApplicationOptions) {
  const app = express();
  const mode = readAuthMode(options.dir);
  const contexts = new Map<
    string,
    { context: ServiceContext; app: express.Express; unbind(): void; assertHealthy(): void }
  >();
  // Outer policy protects login/control plane, but delegates business CSRF to tenant app.
  installHttpPolicy(app, undefined, options.port);
  app.use('/api/auth', options.auth.router);
  app.get('/api/services/user', (_req, res) =>
    res.json({ id: 'User', enabled: true, authenticationReady: true, mode: 'verified-user' }),
  );
  app.use(async (req, res, next) => {
    // Express mounts are case-insensitive by default; authorization must match them.
    const requestPath = req.path.toLowerCase();
    if (!(
      requestPath.startsWith('/api/') ||
      requestPath === '/uploads' ||
      requestPath.startsWith('/uploads/')
    ))
      return next();
    try {
      const principal = await options.auth.resolve(req);
      if (!principal) return res.status(401).json({ code: 'AUTH_REQUIRED', error: '请先登录。' });
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !options.auth.requireCsrf(req))
        return res.status(403).json({ code: 'AUTH_CSRF_REQUIRED', error: '会话校验失败。' });
      if (requestPath.startsWith('/api/sqlconnect') && !hasPermission(principal.role, ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? 'storage.read' : 'sql.initialize'))
        return res.status(403).json({ code: 'AUTH_FORBIDDEN', error: '需要超级管理员权限。' });
      let tenant = contexts.get(principal.id);
      if (!tenant) {
        const dir =
          mode.legacyOwnerId === principal.id
            ? options.dir
            : path.join(options.dir, 'users', createHash('sha256').update(principal.id).digest('hex'));
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('UNSAFE_TENANT_DIRECTORY');
        const storage = activateScopedStorage(options.dir, dir, principal.id);
        try {
          const context = createServiceContext(dir, false);
          tenant = {
            context,
            app: createApplication(context, {
              port: options.port,
              appRoot: options.appRoot,
              services: options.services,
            }),
            unbind: storage.unbind,
            assertHealthy() {
              storage.storage?.assertHealthy();
            },
          };
          contexts.set(principal.id, tenant);
        } catch (error) {
          storage.unbind();
          throw error;
        }
      }
      tenant.assertHealthy();
      tenant.app(req, res, next);
    } catch (error) {
      next(error);
    }
  });
  installHttpFallbacks(app, options.appRoot);
  return {
    app,
    contexts,
    async close() {
      for (const { context } of contexts.values())
        for (const controller of context.runner.controllers.values()) controller.abort();
      for (const tenant of contexts.values()) {
        await tenant.context.platformRuntime.close();
        while (tenant.context.runner.controllers.size)
          await new Promise((resolve) => setTimeout(resolve, 25));
        tenant.unbind();
      }
      contexts.clear();
    },
  };
}
