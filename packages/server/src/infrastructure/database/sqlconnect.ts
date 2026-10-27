import fs from 'node:fs';
import path from 'node:path';
import { sqlResourceDirectory } from '../storage/sql-resources.js';
import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  sqlConnectConfigSchema, sqlConnectInitializeSchema, sqlConnectDrivers,
  SQLCONNECT_SCHEMA_VERSION, type SQLConnectConfig, type SQLConnectStatus,
} from '../../../../../shared/sqlconnect.js';
import { realSQLConnectDrivers, type SQLConnectDriverMap, type SQLConnectConnection } from './sqlconnect-drivers.js';
export type { SQLConnectDriverMap, SQLConnectDriver, SQLConnectConnection } from './sqlconnect-drivers.js';

export class SQLConnectError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
const failure = () => new SQLConnectError(502, 'SQLCONNECT_FAILED', '数据库操作失败，请检查连接设置、权限和数据库是否存在。');
const invalid = () => new SQLConnectError(400, 'SQLCONNECT_INVALID_CONFIG', '数据库配置或请求格式无效。');
const scriptFiles = { mysql: 'init_mysql.sql', postgresql: 'init_postgresql.sql', sqlserver: 'init_mssql.sql' } as const;

export interface SQLConnectServiceOptions {
  dataDir: string;
  /** Workspace deployment root; builds ship SQL beside the compiled storage modules. */
  appRoot?: string;
  drivers?: SQLConnectDriverMap;
}

/** Prepared SQL infrastructure only: the application's local JSON store remains authoritative. */
export class SQLConnectService {
  private config: SQLConnectConfig | null = null;
  private readonly configPath: string;
  private readonly scriptDir: string;
  private readonly adapters: SQLConnectDriverMap;
  private active: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private closed = false;
  private loadError = false;

  constructor(options: SQLConnectServiceOptions) {
    this.configPath = path.join(options.dataDir, 'sqlconnect.json');
    this.scriptDir = sqlResourceDirectory(options.appRoot);
    this.adapters = options.drivers ?? realSQLConnectDrivers;
    // Loading credentials is intentionally offline; malformed files fail closed, never fall back to connection attempts.
    try {
      const stat = fs.lstatSync(this.configPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw invalid();
      fs.chmodSync(this.configPath, 0o600);
      this.config = sqlConnectConfigSchema.parse(JSON.parse(fs.readFileSync(this.configPath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.loadError = true;
    }
  }

  status(): SQLConnectStatus {
    const config = this.config;
    const publicConfig = config ? (() => { const { password, ...rest } = config; return { ...rest, hasPassword: Boolean(password) }; })() : null;
    return { configured: Boolean(config), config: publicConfig, busy: Boolean(this.active), storage: 'local-json', schemaVersion: SQLCONNECT_SCHEMA_VERSION, available: !this.loadError && !this.closed, ...(this.loadError ? { errorCode: 'SQLCONNECT_CONFIG_UNAVAILABLE' as const } : {}) };
  }
  drivers() { return { drivers: sqlConnectDrivers }; }
  private assertIdle() {
    if (this.loadError) throw new SQLConnectError(503, 'SQLCONNECT_CONFIG_UNAVAILABLE', '数据库连接配置不可用，请停止服务后修复配置文件。');
    if (this.closed) throw new SQLConnectError(503, 'SQLCONNECT_CLOSED', '数据库连接服务已关闭。');
    if (this.active) throw new SQLConnectError(409, 'SQLCONNECT_BUSY', '数据库操作正在进行，请稍后重试。');
  }

  saveConfig(body: unknown): SQLConnectStatus {
    this.assertIdle();
    const parsed = sqlConnectConfigSchema.safeParse(body);
    if (!parsed.success) throw invalid();
    const next = { ...parsed.data, password: parsed.data.password ?? this.config?.password ?? '' };
    const dir = path.dirname(this.configPath);
    const temporary = path.join(dir, `.sqlconnect-${randomUUID()}.tmp`);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, this.configPath);
      this.config = next;
    } catch {
      throw new SQLConnectError(503, 'SQLCONNECT_CONFIG_UNAVAILABLE', '无法保存数据库连接配置。');
    } finally { try { fs.unlinkSync(temporary); } catch { /* Already renamed or not created. */ } }
    return this.status();
  }

  private async run(initialize: boolean): Promise<{ ok: true; database: string; initialized: boolean; schemaVersion: number }> {
    this.assertIdle();
    if (!this.config) throw new SQLConnectError(409, 'SQLCONNECT_NOT_CONFIGURED', '请先保存数据库连接配置。');
    const config = { ...this.config };
    const controller = new AbortController();
    this.controller = controller;
    let connection: SQLConnectConnection | undefined;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = (async () => {
      try {
        let batches: string[] = [];
        if (initialize) {
          const script = fs.readFileSync(path.join(this.scriptDir, scriptFiles[config.driver]), 'utf8');
          batches = config.driver === 'sqlserver' ? script.split(/^\s*GO\s*$/gmi) : script.split(';');
        }
        connection = await this.adapters[config.driver].connect(config, controller.signal);
        if (controller.signal.aborted) throw failure();
        await connection.execute('SELECT 1');
        for (const batch of batches) {
          if (controller.signal.aborted) throw failure();
          if (batch.trim()) await connection.execute(batch);
        }
      } finally {
        if (connection) await connection.close();
      }
    })();
    // Keep the lock until the adapter really settles, even after the caller's bounded deadline.
    const tracked = work.finally(() => {
      if (timer) clearTimeout(timer);
      if (this.active === tracked) { this.active = null; this.controller = null; }
    });
    this.active = tracked;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new SQLConnectError(504, 'SQLCONNECT_TIMEOUT', '数据库操作超时，初始化可能已部分完成，可安全重试。'));
      }, config.timeoutMs);
    });
    try {
      await Promise.race([tracked, deadline]);
      return { ok: true, database: config.database, initialized: initialize, schemaVersion: SQLCONNECT_SCHEMA_VERSION };
    } catch (error) {
      if (timedOut) throw new SQLConnectError(504, 'SQLCONNECT_TIMEOUT', '数据库操作超时，初始化可能已部分完成，可安全重试。');
      throw failure();
    }
  }
  test(body: unknown = {}) {
    if (!z.object({}).strict().safeParse(body).success) throw invalid();
    return this.run(false);
  }
  initialize(body: unknown) {
    const parsed = sqlConnectInitializeSchema.safeParse(body);
    if (!parsed.success) throw invalid();
    if (!this.config || parsed.data.confirmDatabase !== this.config.database)
      throw new SQLConnectError(400, 'SQLCONNECT_CONFIRMATION_REQUIRED', '请输入与当前配置完全一致的数据库名称以确认初始化。');
    return this.run(true);
  }
  async close(): Promise<void> {
    this.closed = true;
    this.controller?.abort();
    if (this.active) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([this.active.catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]); }
      finally { if (timer) clearTimeout(timer); }
    }
  }
}

/** Parent must mount behind the application's local-origin/CSRF guard. No route accepts SQL or script paths. */
export function createSQLconnectRouter(service: SQLConnectService): Router {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const route = (fn: (req: Request) => unknown | Promise<unknown>) => async (req: Request, res: Response) => {
    try { res.json(await fn(req)); }
    catch (error) {
      const safe = error instanceof SQLConnectError ? error : failure();
      res.status(safe.status).json({ error: safe.message, code: safe.code });
    }
  };
  router.get('/status', route(() => service.status()));
  router.get('/drivers', route(() => service.drivers()));
  router.put('/config', route(req => service.saveConfig(req.body)));
  router.post('/test', route(req => service.test(req.body)));
  router.post('/initialize', route(req => service.initialize(req.body)));
  return router;
}
