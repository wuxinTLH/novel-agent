import express, { type Request } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthService } from './auth.js';
import { readStorageManifest, readStorageProfiles, writeStorageProfiles } from './storage-config.js';

function loopback(value: string | undefined): boolean {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}
function localHost(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}
/** Neither forwarded headers nor a LAN client can confer local administrator authority. */
export function isLocalAdministrator(req: Request): boolean {
  return (
    loopback(req.socket.remoteAddress) &&
    localHost(`http://${req.get('host') || ''}`) &&
    (!req.get('origin') || localHost(req.get('origin')!)) &&
    req.get('sec-fetch-site') !== 'cross-site'
  );
}
export function createAdministrationRouter(options: {
  dir: string;
  auth: AuthService;
  tenantCount?: () => number;
}) {
  const router = express.Router();
  const token = randomBytes(32).toString('hex');
  const local = (req: Request) => !options.auth.enabled && isLocalAdministrator(req);
  const equalToken = (req: Request) => {
    const supplied = req.get('x-admin-csrf') || '';
    const left = Buffer.from(supplied),
      right = Buffer.from(token);
    return left.length === right.length && timingSafeEqual(left, right);
  };
  const authorized = (req: Request) =>
    options.auth.enabled
      ? options.auth.session(req)?.user.role === 'superadmin' && options.auth.requireCsrf(req)
      : local(req) && equalToken(req);
  router.use(express.json({ limit: '1mb' }));
  router.get('/session', (req, res) => {
    if (local(req)) return res.json({ available: true, mode: 'local', csrfToken: token });
    if (options.auth.enabled && options.auth.session(req)?.user.role === 'superadmin')
      return res.json({ available: true, mode: 'authenticated' });
    res.status(403).json({ code: 'ADMIN_FORBIDDEN', error: '管理员入口仅限本机或已登录的超级管理员。' });
  });
  router.use((req, res, next) => {
    const read = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const allowed = options.auth.enabled
      ? options.auth.session(req)?.user.role === 'superadmin' && (read || options.auth.requireCsrf(req))
      : local(req) && (read || equalToken(req));
    if (!allowed)
      return res.status(403).json({ code: 'ADMIN_FORBIDDEN', error: '管理员权限或操作凭据无效。' });
    next();
  });
  const profiles = () => readStorageProfiles(options.dir);
  router.get('/status', (_req, res) => {
    const config = profiles();
    const manifest = readStorageManifest(options.dir);
    res.json({
      mode: options.auth.enabled ? 'authenticated' : 'local',
      authenticationEnabled: options.auth.enabled,
      configured: options.auth.managementConfigured(),
      storage: {
        backend: manifest?.backend || 'local-json',
        active: !!manifest,
        profiles:
          config?.profiles.map((p) => ({
            id: p.id,
            label: p.label,
            driver: p.connection.driver,
            database: p.connection.database,
            ownerCount: config.ownerProfiles.filter((o) => o.profileId === p.id).length,
          })) || [],
      },
      runtime: { tenantCount: options.tenantCount?.() || 0 },
      maintenance: { offlineRequired: true },
    });
  });
  router.get('/storage', (_req, res) => {
    const config = profiles();
    if (!config) return res.json({ version: 3, defaultProfileId: '', profiles: [], ownerProfiles: [] });
    res.json({
      ...config,
      profiles: config.profiles.map((p) => {
        const { password, ...connection } = p.connection;
        return { ...p, connection: { ...connection, hasPassword: !!password } };
      }),
    });
  });
  router.put('/storage', (req, res) => {
    if (readStorageManifest(options.dir))
      return res
        .status(409)
        .json({ code: 'ACTIVE_STORAGE_CONFIG_LOCKED', error: '请停服后离线修改已启用的业务数据库配置。' });
    const previous = profiles();
    const body = req.body;
    if (body && Array.isArray(body.profiles))
      for (const profile of body.profiles) {
        if (!profile || !profile.connection) continue;
        delete profile.connection.hasPassword;
        if (profile.connection.password === undefined) {
          const old = previous?.profiles.find((p) => p.id === profile.id);
          // Preserve a password only for the exact same connection identity.
          if (
            old &&
            ['driver', 'host', 'port', 'database', 'user'].every(
              (key) =>
                (old.connection as unknown as Record<string, unknown>)[key] === profile.connection[key],
            )
          )
            profile.connection.password = old.connection.password;
        }
      }
    writeStorageProfiles(options.dir, body);
    res.json({ ok: true });
  });
  router.get('/maintenance', (_req, res) =>
    res.json({
      offlineRequired: true,
      commands: [
        {
          label: '首次创建超级管理员',
          command: 'npm run admin -- bootstrap-admin --username <用户名> --confirm',
          description:
            '停服后执行；密码仅通过 NOVEL_BOOTSTRAP_PASSWORD 环境变量提供。完成后重启；不会自动开启认证。',
        },
        {
          label: '完整备份',
          command: 'npm run maintenance -- backup --destination <数据目录外的新目录> --confirm',
          description: '先停止服务；应用数据与数据库必须保持静默。备份包含敏感密钥，请限制访问。',
        },
        {
          label: '恢复到新目录',
          command: 'npm run maintenance -- restore --source <备份目录> --data-dir <空目录> --confirm',
          description: '默认仅接受空目标；数据库目标必须显式指定，不能自动连接备份中的地址。',
        },
        {
          label: '迁移全部用户',
          command:
            'npm run maintenance -- migrate-all --owner <原数据所属用户UUID> --destination <数据目录外的新备份目录> --confirm',
          description: '先完整备份；显式校验全部用户映射和数据库目标，再启用存储。',
        },
      ],
    }),
  );
  // Authenticated administrators retain normal password reauthentication semantics.
  // Only the explicitly local, authentication-off surface can use owner management authority.
  router.use(
    options.auth.enabled
      ? options.auth.router
      : options.auth.createManagementRouter((req) => {
          if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return local(req);
          return authorized(req);
        }),
  );
  return router;
}
