import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express, { type RequestHandler } from 'express';
import { z } from 'zod';
import {
  backupFull,
  validateBackup,
  type MaintenanceBackend,
  type MaintenanceQuiescence,
} from './maintenance.js';

export interface OnlineMaintenanceLease extends MaintenanceQuiescence {
  /** Idempotent; restores admission only after all snapshot work is complete. */
  release(): void | Promise<void>;
}
export type OnlineMaintenanceBackend = MaintenanceBackend & { close?: () => void | Promise<void> };
export interface OnlineMaintenanceOptions {
  dataDir: string;
  /** Must gate ALL tenant creation, requests, background/browser work and control-plane writes,
   * drain them, and retain the instance lock. Reject on incomplete drain/close. No other
   * application instance may write any configured SQL profile. Never a user-supplied flag. */
  acquireQuiescence?: (signal: AbortSignal) => Promise<OnlineMaintenanceLease>;
  /** Trusted factory for ALL configured profiles, not only the current owner. */
  backend?: () => Promise<OnlineMaintenanceBackend | undefined>;
  maxQueued?: number;
  maxHistory?: number;
  maxBackups?: number;
}
const idSchema = z.string().uuid();
const inputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('backup'), confirmSecrets: z.literal(true) }).strict(),
  z.object({ kind: z.enum(['validate', 'restore-plan']), backupId: idSchema }).strict(),
]);
export type OnlineMaintenanceInput = z.infer<typeof inputSchema>;
const jobSchema = z
  .object({
    id: idSchema,
    kind: z.enum(['backup', 'validate', 'restore-plan']),
    state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
    phase: z.enum(['queued', 'quiescing', 'snapshot', 'validating', 'committing', 'complete', 'interrupted']),
    progress: z.number().min(0).max(100),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    backupId: idSchema.optional(),
    cancelRequested: z.boolean(),
    errorCode: z.string().optional(),
    result: z
      .object({
        fileCount: z.number(),
        profileCount: z.number(),
        externalKeysRequired: z.boolean(),
        offlineRequired: z.boolean(),
        validation: z.literal('integrity-only'),
      })
      .strict()
      .optional(),
  })
  .strict();
export type OnlineMaintenanceJob = z.infer<typeof jobSchema>;
export class OnlineMaintenanceError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
function safeDirectory(directory: string, create = false) {
  const absolute = path.resolve(directory);
  const parent = path.dirname(absolute);
  if (parent !== absolute) safeDirectory(parent);
  if (!fs.existsSync(absolute) && create) fs.mkdirSync(absolute, { mode: 0o700 });
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new OnlineMaintenanceError('MAINTENANCE_UNSAFE_DIRECTORY');
  return absolute;
}
function safeFile(file: string) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024)
    throw new OnlineMaintenanceError('MAINTENANCE_UNSAFE_HISTORY');
}
const terminal = (job: OnlineMaintenanceJob) => !['queued', 'running'].includes(job.state);

/** One manager per instance, owned/closed by the parent application lifecycle. All API
 * output is deliberately allowlisted: never return manifests, snapshots, paths or errors. */
export class OnlineMaintenanceManager {
  private readonly historyFile: string;
  private readonly backupRoot: string;
  private readonly jobs: OnlineMaintenanceJob[] = [];
  private active?: { job: OnlineMaintenanceJob; controller: AbortController };
  private pumping?: Promise<void>;
  private closed = false;
  private readonly maxQueued: number;
  private readonly maxHistory: number;
  private readonly maxBackups: number;
  constructor(private readonly options: OnlineMaintenanceOptions) {
    const root = safeDirectory(options.dataDir);
    const history = safeDirectory(path.join(root, '.maintenance-online'), true);
    this.historyFile = path.join(history, 'jobs.json');
    this.backupRoot = safeDirectory(
      path.join(path.dirname(root), '.' + path.basename(root) + '-managed-backups'),
      true,
    );
    this.maxQueued = Math.max(1, Math.min(32, options.maxQueued ?? 8));
    this.maxHistory = Math.max(1, Math.min(500, options.maxHistory ?? 100));
    this.maxBackups = Math.max(1, Math.min(100, options.maxBackups ?? 20));
    if (fs.existsSync(this.historyFile)) {
      safeFile(this.historyFile);
      this.jobs.push(
        ...z
          .array(jobSchema)
          .max(533)
          .parse(JSON.parse(fs.readFileSync(this.historyFile, 'utf8'))),
      );
      for (const job of this.jobs)
        if (!terminal(job)) {
          job.state = 'interrupted';
          job.phase = 'interrupted';
          job.errorCode = 'MAINTENANCE_RESTART_INTERRUPTED';
          job.updatedAt = new Date().toISOString();
        }
    }
    this.persist();
  }
  capabilities() {
    return {
      backupAvailable: !!this.options.acquireQuiescence,
      scope: 'all-tenants-and-control-plane' as const,
      restoreOfflineRequired: true,
      migrateOfflineRequired: true,
      maxQueued: this.maxQueued,
      maxBackups: this.maxBackups,
      validation: 'integrity-only' as const,
    };
  }
  list() {
    return structuredClone(this.jobs).reverse();
  }
  get(id: string) {
    idSchema.parse(id);
    const job = this.jobs.find((item) => item.id === id);
    if (!job) throw new OnlineMaintenanceError('MAINTENANCE_JOB_NOT_FOUND', 404);
    return structuredClone(job);
  }
  create(value: unknown) {
    const input = inputSchema.parse(value);
    if (this.closed) throw new OnlineMaintenanceError('MAINTENANCE_CLOSED', 503);
    if (input.kind === 'backup' && !this.options.acquireQuiescence)
      throw new OnlineMaintenanceError('MAINTENANCE_BARRIER_UNAVAILABLE', 409);
    if (this.jobs.filter((job) => job.state === 'queued').length >= this.maxQueued)
      throw new OnlineMaintenanceError('MAINTENANCE_QUEUE_FULL', 429);
    if (input.kind !== 'backup') this.backupPath(input.backupId);
    const now = new Date().toISOString();
    const job: OnlineMaintenanceJob = {
      id: randomUUID(),
      kind: input.kind,
      state: 'queued',
      phase: 'queued',
      progress: 0,
      createdAt: now,
      updatedAt: now,
      cancelRequested: false,
      ...(input.kind !== 'backup' ? { backupId: input.backupId } : {}),
    };
    this.jobs.push(job);
    this.persist();
    // Yield to allow callers to persist/observe/cancel the queued job before any work.
    this.pumping ??= Promise.resolve()
      .then(() => this.pump())
      .finally(() => {
        this.pumping = undefined;
      });
    return structuredClone(job);
  }
  cancel(id: string) {
    const copy = this.get(id),
      job = this.jobs.find((item) => item.id === copy.id)!;
    if (terminal(job)) return copy;
    if (job.phase === 'committing') throw new OnlineMaintenanceError('MAINTENANCE_COMMIT_STARTED', 409);
    job.cancelRequested = true;
    if (job.state === 'queued') {
      job.state = 'cancelled';
      job.phase = 'complete';
    }
    if (this.active?.job === job) this.active.controller.abort();
    this.persist();
    return structuredClone(job);
  }
  async close() {
    this.closed = true;
    for (const job of this.jobs) if (!terminal(job) && job.phase !== 'committing') this.cancel(job.id);
    await this.pumping;
  }
  private backupPath(id: string) {
    idSchema.parse(id);
    safeDirectory(this.backupRoot);
    const directory = path.join(this.backupRoot, id);
    safeDirectory(directory);
    return directory;
  }
  private persist() {
    const completed = this.jobs.filter(terminal);
    const discard = new Set(completed.slice(0, Math.max(0, completed.length - this.maxHistory)));
    for (let index = this.jobs.length - 1; index >= 0; index--)
      if (discard.has(this.jobs[index]!)) this.jobs.splice(index, 1);
    safeDirectory(path.dirname(this.historyFile));
    if (fs.existsSync(this.historyFile)) safeFile(this.historyFile);
    const temporary = this.historyFile + '.' + randomUUID() + '.tmp';
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(this.jobs));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, this.historyFile);
  }
  private phase(job: OnlineMaintenanceJob, phase: OnlineMaintenanceJob['phase'], progress: number) {
    job.phase = phase;
    job.progress = progress;
    job.updatedAt = new Date().toISOString();
    this.persist();
  }
  private async pump() {
    for (;;) {
      const job = this.jobs.find((item) => item.state === 'queued');
      if (!job || this.closed) return;
      const controller = new AbortController();
      this.active = { job, controller };
      const checkCancelled = () => {
        if (job.cancelRequested || controller.signal.aborted)
          throw new OnlineMaintenanceError('MAINTENANCE_CANCELLED');
      };
      let lease: OnlineMaintenanceLease | undefined;
      let backend: OnlineMaintenanceBackend | undefined;
      let failure: unknown;
      try {
        job.state = 'running';
        if (job.kind === 'backup') {
          this.phase(job, 'quiescing', 5);
          // Count even incomplete/private stages: bounded disk artifacts, fail closed at capacity.
          safeDirectory(this.backupRoot);
          if (fs.readdirSync(this.backupRoot).length >= this.maxBackups)
            throw new OnlineMaintenanceError('MAINTENANCE_BACKUP_CAPACITY');
          lease = await this.options.acquireQuiescence!(controller.signal);
          checkCancelled();
          lease.assertHeld();
          this.phase(job, 'snapshot', 25);
          backend = await this.options.backend?.();
          checkCancelled();
          const id = randomUUID();
          await backupFull({
            dataDir: this.options.dataDir,
            destination: path.join(this.backupRoot, id),
            quiescence: lease,
            backend,
            beforeCommit: () => {
              checkCancelled();
              safeDirectory(this.backupRoot);
              lease!.assertHeld();
              this.phase(job, 'committing', 90);
            },
          });
          job.backupId = id;
        } else {
          this.phase(job, 'validating', 25);
          checkCancelled();
          const { manifest } = validateBackup(this.backupPath(job.backupId!));
          checkCancelled();
          job.result = {
            fileCount: manifest.entries.filter((entry) => entry.type === 'file').length,
            profileCount: manifest.sql.length,
            externalKeysRequired: manifest.externalKeys.length > 0,
            offlineRequired: true,
            validation: 'integrity-only',
          };
        }
      } catch (error) {
        failure = error;
      } finally {
        try {
          await backend?.close?.();
        } catch {
          failure = new OnlineMaintenanceError('MAINTENANCE_BACKEND_CLOSE_FAILED');
        }
        try {
          await lease?.release();
        } catch {
          failure = new OnlineMaintenanceError('MAINTENANCE_BARRIER_RELEASE_FAILED');
        }
      }
      if (failure) {
        const cleanupFailed =
          failure instanceof OnlineMaintenanceError &&
          ['MAINTENANCE_BACKEND_CLOSE_FAILED', 'MAINTENANCE_BARRIER_RELEASE_FAILED'].includes(failure.code);
        job.state =
          job.cancelRequested && job.phase !== 'committing' && !cleanupFailed ? 'cancelled' : 'failed';
        // Never expose caught messages, SQL diagnostics, Zod contents, local paths or secrets.
        job.errorCode = failure instanceof OnlineMaintenanceError ? failure.code : 'MAINTENANCE_TASK_FAILED';
      } else job.state = 'succeeded';
      this.phase(job, 'complete', job.state === 'succeeded' ? 100 : job.progress);
      this.active = undefined;
    }
  }
}

/** Mount beneath /api/admin/online-maintenance. REQUIRED authorization middleware is
 * the existing admin read/superadmin + mutation-CSRF guard, not ordinary user auth.
 * Mount after the secured admin gate as defense in depth. Never expose as tenant API. */
export function createOnlineMaintenanceRouter(options: {
  manager: OnlineMaintenanceManager;
  authorize: RequestHandler;
}) {
  if (typeof options.authorize !== 'function') throw new Error('MAINTENANCE_ADMIN_GUARD_REQUIRED');
  const router = express.Router();
  router.use(options.authorize);
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(express.json({ limit: '8kb' }));
  const handle = (action: () => unknown, res: express.Response, status = 200) => {
    try {
      res.status(status).json(action());
    } catch (error) {
      const known = error instanceof OnlineMaintenanceError;
      res.status(known ? error.status : 400).json({
        code: known ? error.code : 'MAINTENANCE_INVALID_REQUEST',
        error: '维护请求未完成；请核对任务状态或安全边界。',
      });
    }
  };
  router.get('/', (_req, res) =>
    handle(() => ({ ...options.manager.capabilities(), jobs: options.manager.list() }), res),
  );
  router.post('/tasks', (req, res) => handle(() => options.manager.create(req.body), res, 202));
  router.get('/tasks/:id', (req, res) => handle(() => options.manager.get(String(req.params.id)), res));
  router.post('/tasks/:id/cancel', (req, res) =>
    handle(() => options.manager.cancel(String(req.params.id)), res),
  );
  router.post('/backups/:id/validate', (req, res) =>
    handle(() => options.manager.create({ kind: 'validate', backupId: String(req.params.id) }), res, 202),
  );
  return router;
}
