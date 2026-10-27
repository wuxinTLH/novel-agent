import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { createAdministrationRouter } from './models/administration.js';
import { createIsolatedTenantApplication } from './models/isolated-tenant-application.js';
import { acquireDataLock, appRoot } from './local-runtime.js';
import type { IsolatedTenantService } from './models/isolated-tenant-application.js';
import { SQLConnectService, createSQLconnectRouter } from './models/sqlconnect.js';
import { AuthService } from './models/auth.js';
import { createAuthPersistence, readAuthMode, readStorageManifest } from './models/storage-config.js';
try {
  process.loadEnvFile(path.join(appRoot, '.env'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const port = Number(process.env.PORT || 3001);
const dir = path.resolve(appRoot, process.env.DATA_DIR || 'data');
if (fs.existsSync(path.join(dir, '.maintenance-journal.json')))
  throw new Error('MAINTENANCE_RECOVERY_REQUIRED');
const releaseDataLock = acquireDataLock(dir);
process.once('exit', releaseDataLock);
const mode = readAuthMode(dir);
const manifest = readStorageManifest(dir);
if (mode.enabled && manifest && mode.legacyOwnerId !== manifest.ownerId)
  throw new Error('SQL_AUTH_OWNER_MISMATCH');
const authPersistence = createAuthPersistence(dir);
const auth = new AuthService({
  dataDir: dir,
  enabled: mode.enabled,
  persistence: authPersistence,
});
if (mode.enabled && !auth.hasSuperadmin()) throw new Error('AUTH_BOOTSTRAP_REQUIRED');
const sqlconnect = new SQLConnectService({ dataDir: dir, appRoot });
const services: IsolatedTenantService[] = [
  {
    register(app) {
      app.use(
        '/api/sqlconnect',
        express.json({ limit: '1mb' }),
        (req, res, next) => {
          if (manifest && !['GET', 'HEAD', 'OPTIONS'].includes(req.method))
            return res.status(409).json({
              code: 'ACTIVE_STORAGE_CONFIG_LOCKED',
              error: '业务 SQL 已启用；请停机并通过本机管理流程修改连接或迁移。',
            });
          next();
        },
        createSQLconnectRouter(sqlconnect),
      );
    },
    close: () => sqlconnect.close(),
  },
];
services.unshift({
  register(application) {
    application.use(
      '/api/admin',
      createAdministrationRouter({
        dir,
        auth,
        tenantCount: () => tenants.contexts.size,
      }),
    );
    application.get('/api/services/user', (_req, res) =>
      res.json({
        id: 'User',
        enabled: mode.enabled,
        authenticationReady: mode.enabled,
        mode: mode.enabled ? 'verified-user' : 'single-user',
      }),
    );
  },
});
const tenants = createIsolatedTenantApplication({
  dir,
  port,
  appRoot,
  auth,
  services,
  enabled: mode.enabled,
});
const app = tenants.app;
const closeRuntime = tenants.close;
const server = app.listen(port, '0.0.0.0', () => console.log(`Novel Agent API: http://0.0.0.0:${port}`));
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref();
  try {
    await closeRuntime();
    await authPersistence?.close?.();
    releaseDataLock();
    clearTimeout(deadline);
    process.exit(0);
  } catch {
    console.error('关闭未完整完成，下次启动请检查任务和数据目录锁。');
    process.exit(1);
  }
}
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
server.on('error', () => {
  console.error('本机服务无法启动，请检查端口是否被占用。');
  void shutdown();
});
