import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { createAdministrationRouter } from './features/administration/administration.js';
import { createIsolatedTenantApplication } from './core/tenancy/isolated-tenant-application.js';
import { acquireDataLock, appRoot } from './core/local-runtime.js';
import { trustedPublicOrigin } from './core/trusted-origin.js';
import { readWebHostingOptions } from './core/web-hosting.js';
import { SecurityAuditLog } from './core/security-audit.js';
import { readCoreModel, coreModelBindHost, assertCoreModelGateway, assertCoreModelOrigin } from './core/core-model.js';
import { readSecurityProfile, assertHardenedStartup, configureHttpServer } from './core/security-profile.js';
import type { IsolatedTenantService } from './core/tenancy/isolated-tenant-application.js';
import { readLocalGatewayConfig, startLocalGateway, type LocalGateway } from './core/local-gateway.js';
import { SQLConnectService, createSQLconnectRouter } from './infrastructure/database/sqlconnect.js';
import { AuthService } from './features/auth/auth.js';
import { createAccountEmailTransport } from './features/auth/account-mail.js';
import { OnlineMaintenanceManager } from './features/administration/online-maintenance.js';
import { RelationalStorage } from './infrastructure/storage/relational-storage.js';
import {
  createAuthPersistence,
  readAuthMode,
  readStorageManifest,
  readStorageProfiles,
} from './infrastructure/storage/storage-config.js';
try {
  process.loadEnvFile(path.join(appRoot, '.env'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const port = Number(process.env.PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT_INVALID');
const coreModel = readCoreModel(process.env);
const bindHost = coreModelBindHost(coreModel);
const securityProfile = readSecurityProfile(process.env);
const gatewayConfig = readLocalGatewayConfig(process.env, port);
assertCoreModelGateway(coreModel, gatewayConfig, process.env);
const publicOrigin = trustedPublicOrigin();
assertCoreModelOrigin(coreModel, publicOrigin);
const webHosting = readWebHostingOptions(process.env, appRoot);
const dir = path.resolve(appRoot, process.env.DATA_DIR || 'data');
if (fs.existsSync(path.join(dir, '.maintenance-journal.json')))
  throw new Error('MAINTENANCE_RECOVERY_REQUIRED');
// Read-only preflight must fail before acquiring the lock or creating audit/data files.
const mode = readAuthMode(dir);
assertHardenedStartup({ ...securityProfile, authEnabled: mode.enabled, trustedOrigin: publicOrigin, gatewayEnabled: gatewayConfig.enabled, modelKey: process.env.MODEL_SECRETS_KEY, platformKey: process.env.PLATFORM_SECRETS_KEY });
const releaseDataLock = acquireDataLock(dir);
process.once('exit', releaseDataLock);
const securityAudit = securityProfile.audit ? new SecurityAuditLog(path.join(dir, 'security-audit')) : undefined;
securityAudit?.write({ event: 'service.starting' });
const manifest = readStorageManifest(dir);
if (mode.enabled && manifest && mode.legacyOwnerId !== manifest.ownerId)
  throw new Error('SQL_AUTH_OWNER_MISMATCH');
const authPersistence = createAuthPersistence(dir);
const auth = new AuthService({
  dataDir: dir,
  enabled: mode.enabled,
  secureCookies: !!publicOrigin,
  securityProfile: coreModel,
  persistence: authPersistence,
  emailTransport: createAccountEmailTransport(),
});
if (mode.enabled && !auth.hasSuperadmin()) throw new Error('AUTH_BOOTSTRAP_REQUIRED');
const sqlconnect = new SQLConnectService({ dataDir: dir, appRoot });
const onlineMaintenance = new OnlineMaintenanceManager({
  dataDir: dir,
  acquireQuiescence: (signal) => tenants.acquireQuiescence(signal),
  async backend() {
    // Saved prospective profiles are not active business storage. Local backups must
    // not connect to them; legacy v1 still fails closed in backupFull's SQL check.
    if (manifest?.version !== 3) return undefined;
    const profiles = readStorageProfiles(dir);
    if (!profiles) throw new Error('STORAGE_PROFILES_REQUIRED');
    const stores = new Map(
      profiles.profiles.map((profile) => [profile.id, new RelationalStorage(profile.connection)]),
    );
    const store = (id: string) => {
      const value = stores.get(id);
      if (!value) throw new Error('MAINTENANCE_PROFILE_MISMATCH');
      return value;
    };
    return {
      profileIds: [...stores.keys()],
      exportSnapshot: (id: string) => store(id).exportSnapshot(),
      // This online backend is strictly read-only. Restore/import stay offline.
      assertEmpty: async () => {
        throw new Error('OFFLINE_REQUIRED');
      },
      importSnapshot: async () => {
        throw new Error('OFFLINE_REQUIRED');
      },
      close: async () => {
        await Promise.all([...stores.values()].map((value) => value.close()));
      },
    };
  },
});
const services: IsolatedTenantService[] = [
  {
    register(app) {
      app.use(
        '/api/sqlconnect',
        (req, res, next) => tenants.requireRuntimeCsrf(req, res, next),
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
  close: () => onlineMaintenance.close(),
  register(application) {
    application.use(
      '/api/admin',
      createAdministrationRouter({
        dir,
        auth,
        tenantCount: () => tenants.contexts.size,
        onlineMaintenance,
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
  coreModel,
  enabled: mode.enabled,
  trustedAliasPorts: gatewayConfig.ports,
  ...webHosting,
  securityKernel: { audit: securityAudit ? event => securityAudit.write(event) : undefined },
  waitForControlPlaneIdle: async () => {
    await auth.waitForIdle();
    await sqlconnect.waitForIdle();
  },
});
const app = tenants.app;
const closeRuntime = tenants.close;
let gateway: LocalGateway | undefined;
let closing = false;
let exitCode = 0;
let gatewayStartup: Promise<void> = Promise.resolve();
const server = app.listen(port, bindHost, () => {
  console.log(`Novel Agent API (${coreModel}): http://${bindHost}:${port}`);
  if (closing) return;
  gatewayStartup = (async () => {
    try {
      gateway = await startLocalGateway(gatewayConfig);
      if (gateway.addresses.length)
        console.log(`Novel Agent local gateway: ${gateway.addresses.map(({ host, port: value }) => `http://${host}:${value}`).join(', ')}`);
    } catch {
      exitCode = 1;
      console.error('本机网关无法启动，请检查配置和端口是否被占用。');
      void shutdown();
    }
  })();
});
configureHttpServer(server);
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref();
  try {
    await gatewayStartup;
    await gateway?.close();
    await onlineMaintenance.close();
    await closeRuntime();
    await authPersistence?.close?.();
    releaseDataLock();
    clearTimeout(deadline);
    process.exit(exitCode);
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
  exitCode = 1;
  console.error('本机服务无法启动，请检查端口是否被占用。');
  void shutdown();
});
