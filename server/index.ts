import path from 'node:path';
import { acquireDataLock, appRoot } from './local-runtime.js';
import { createApplication } from './models/application.js';
import { createServiceContext, type FeatureService } from './models/context.js';
import { SQLConnectService, createSQLconnectRouter } from './models/sqlconnect.js';
import { AuthService } from './models/auth.js';
import { createTenantApplication } from './models/tenant-application.js';
import {
  activateScopedStorage,
  createAuthPersistence,
  readAuthMode,
  readStorageManifest,
} from './models/storage-config.js';
try {
  process.loadEnvFile(path.join(appRoot, '.env'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const port = Number(process.env.PORT || 3001);
const dir = path.resolve(appRoot, process.env.DATA_DIR || 'data');
const releaseDataLock = acquireDataLock(dir);
process.once('exit', releaseDataLock);
const mode = readAuthMode(dir);
const manifest = readStorageManifest(dir);
if (mode.enabled && manifest && mode.legacyOwnerId !== manifest.ownerId)
  throw new Error('SQL_AUTH_OWNER_MISMATCH');
const auth = new AuthService({
  dataDir: dir,
  enabled: mode.enabled,
  persistence: mode.enabled ? createAuthPersistence(dir) : undefined,
});
if (mode.enabled && !auth.hasSuperadmin()) throw new Error('AUTH_BOOTSTRAP_REQUIRED');
const sqlconnect = new SQLConnectService({ dataDir: dir, appRoot });
const services: FeatureService[] = [
  {
    id: 'SQLconnect',
    register(app) {
      app.use(
        '/api/sqlconnect',
        (req, res, next) => {
          if (manifest && !['GET', 'HEAD', 'OPTIONS'].includes(req.method))
            return res
              .status(409)
              .json({
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
let closeRuntime: () => Promise<void>;
let app;
if (mode.enabled) {
  const tenants = createTenantApplication({ dir, port, appRoot, auth, services });
  app = tenants.app;
  closeRuntime = tenants.close;
} else {
  const scoped = activateScopedStorage(dir, dir);
  const context = createServiceContext(dir);
  app = createApplication(context, {
    port,
    appRoot,
    assertStorageHealthy: () => scoped.storage?.assertHealthy(),
    services: [
      ...services,
      {
        id: 'User',
        register(application) {
          application.get('/api/auth/session', (_req, res) =>
            res.json({
              enabled: false,
              configured: false,
              authenticated: false,
              turnstile: { enabled: false, siteKey: '', action: 'login' },
            }),
          );
          application.get('/api/services/user', (_req, res) =>
            res.json({ id: 'User', enabled: false, authenticationReady: false, mode: 'single-user' }),
          );
        },
      },
    ],
  });
  closeRuntime = async () => {
    for (const controller of context.runner.controllers.values()) controller.abort();
    await context.platformRuntime.close();
    while (context.runner.controllers.size) await new Promise((resolve) => setTimeout(resolve, 25));
    scoped.unbind();
  };
}
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
    await Promise.all(services.map((service) => service.close?.()));
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
