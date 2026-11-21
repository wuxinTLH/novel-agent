import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isMainThread } from 'node:worker_threads';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import {
  ALERT_PROVIDERS, OPERATIONAL_EVENT_CATALOG, isOperationalEventCode,
  defaultLogAlertConfig, logAlertConfigSchema, updateLogAlertConfigSchema, logsQuerySchema,
  type AlertProvider, type OperationalEventCode, type OperationalLog, type LogsResponse, type LogAlertsResponse,
} from '../../../../../shared/operational-logs.js';

export const LOG_RETENTION_DAYS = 31;
export const MAX_OPERATIONAL_LOGS = 10000;
export const MAX_ALERT_DELIVERIES = 1000;
export const MAX_ALERT_QUEUE = 64;
export const MAX_LOG_STORE_BYTES = 8 * 1024 * 1024;
export type AlertDeliveryStatus = 'unsupported' | 'sent' | 'failed' | 'unknown';
export interface AlertTransport {
  send(event: Readonly<OperationalLog>, signal: AbortSignal): Promise<AlertDeliveryStatus>;
}
export interface AlertDelivery { id: string; eventId: string; code: OperationalEventCode; provider: AlertProvider; at: string; status: AlertDeliveryStatus }
const iso = z.string().datetime().refine(s => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s);
const eventSchema = z.object({ id: z.string().uuid(), at: iso, code: z.string().refine(isOperationalEventCode), level: z.string(), category: z.string(), message: z.string().max(100) }).strict().superRefine((v, ctx) => {
  if (!isOperationalEventCode(v.code)) return;
  const expected = OPERATIONAL_EVENT_CATALOG[v.code];
  if (v.level !== expected.level || v.category !== expected.category || v.message !== expected.message) ctx.addIssue({ code: 'custom', message: 'Invalid catalog event' });
});
const deliverySchema = z.object({ id: z.string().uuid(), eventId: z.string().uuid(), code: z.string().refine(isOperationalEventCode), provider: z.enum(ALERT_PROVIDERS), at: iso, status: z.enum(['unsupported','sent','failed','unknown']) }).strict();
const documentSchema = z.object({ version: z.literal(1), config: logAlertConfigSchema, items: z.array(eventSchema).max(MAX_OPERATIONAL_LOGS), deliveries: z.array(deliverySchema).max(MAX_ALERT_DELIVERIES) }).strict().superRefine((v, ctx) => {
  if (new Set(v.items.map(e => e.id)).size !== v.items.length || new Set(v.deliveries.map(e => e.id)).size !== v.deliveries.length) ctx.addIssue({code:'custom', message:'Duplicate IDs'});
});
interface Document { version: 1; config: LogAlertsResponse['config']; items: OperationalLog[]; deliveries: AlertDelivery[] }
export class OperationalLogsError extends Error {
  constructor(readonly code: 'OPERATIONAL_LOGS_INVALID' | 'OPERATIONAL_LOGS_CONFLICT' | 'OPERATIONAL_LOGS_UNAVAILABLE') { super(code); }
}
function unavailable(): never { throw new OperationalLogsError('OPERATIONAL_LOGS_UNAVAILABLE'); }
/** Main control plane only, under the existing single-application data lock. No SQL fallback. */
export class OperationalLogsStore {
  private document: Document = {version:1, config:defaultLogAlertConfig(), items:[], deliveries:[]};
  private existed = false;
  private unhealthy = false;
  private closed = false;
  private readonly file: string;
  private queue: {id: string; event: OperationalLog; provider: AlertProvider; revision: number}[] = [];
  private runner?: Promise<void>;
  private activeTransports = 0;
  private readonly blocked = new Set<AlertProvider>();
  private readonly transports: Partial<Record<AlertProvider, AlertTransport>>;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  constructor(readonly dir: string, options: {transports?: Partial<Record<AlertProvider, AlertTransport>>; now?: () => number; deliveryTimeoutMs?: number} = {}) {
    this.file = path.join(path.resolve(dir), 'operational-logs.json');
    this.transports = { ...options.transports };
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.deliveryTimeoutMs ?? 5000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30000) throw new OperationalLogsError('OPERATIONAL_LOGS_INVALID');
  }
  private load(): void {
    if (this.unhealthy) unavailable();
    try {
      let ancestor = path.resolve(this.dir);
      for (;;) {
        try { const st = fs.lstatSync(ancestor); if (!st.isDirectory() || st.isSymbolicLink()) unavailable(); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
      }
      try {
        const st = fs.lstatSync(this.file);
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > MAX_LOG_STORE_BYTES) unavailable();
        this.document = documentSchema.parse(JSON.parse(fs.readFileSync(this.file, 'utf8'))) as Document;
        this.existed = true;
      } catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || this.existed) throw e; }
    } catch { this.unhealthy = true; unavailable(); }
  }
  private commit(next: Document): void {
    if (!isMainThread || this.closed || this.unhealthy) unavailable();
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized) > MAX_LOG_STORE_BYTES) unavailable();
    const tmp = this.file + '.' + randomUUID() + '.tmp';
    try {
      fs.mkdirSync(this.dir, {recursive:true, mode:0o700});
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.file);
    } catch { this.unhealthy = true; unavailable(); }
    finally { try { fs.unlinkSync(tmp); } catch { /* best effort */ } }
    this.document = next; this.existed = true;
  }
  private retained(): Document {
    const next = structuredClone(this.document), cutoff = this.now() - LOG_RETENTION_DAYS * 86400000;
    next.items = next.items.filter(e => Date.parse(e.at) >= cutoff).slice(-MAX_OPERATIONAL_LOGS);
    next.deliveries = next.deliveries.filter(e => Date.parse(e.at) >= cutoff).slice(-MAX_ALERT_DELIVERIES);
    return next;
  }
  query(input: unknown = {}): LogsResponse {
    const parsed = logsQuerySchema.safeParse(input);
    if (!parsed.success) throw new OperationalLogsError('OPERATIONAL_LOGS_INVALID');
    this.load(); const q = parsed.data;
    const matches = this.retained().items.filter(e => (!q.level || e.level === q.level) && (!q.category || e.category === q.category) && (!q.from || e.at >= q.from) && (!q.to || e.at <= q.to) && (!q.search || (e.code + ' ' + e.message).toLowerCase().includes(q.search.toLowerCase()))).reverse();
    return {items:matches.slice(q.offset,q.offset+q.limit), total:matches.length, limit:q.limit, offset:q.offset};
  }
  alerts(): LogAlertsResponse {
    this.load(); return {config:structuredClone(this.document.config), providers:ALERT_PROVIDERS.map(id => ({id,available:!!this.transports[id]}))};
  }
  updateAlerts(input: unknown): LogAlertsResponse {
    const parsed = updateLogAlertConfigSchema.safeParse(input);
    if (!parsed.success) throw new OperationalLogsError('OPERATIONAL_LOGS_INVALID');
    this.load(); const {expectedRevision,...config} = parsed.data;
    if (this.document.config.revision !== expectedRevision) throw new OperationalLogsError('OPERATIONAL_LOGS_CONFLICT');
    if (expectedRevision === Number.MAX_SAFE_INTEGER) unavailable();
    const next = this.retained(); next.config = {...config,revision:expectedRevision+1}; this.commit(next);
    return this.alerts();
  }
  record(code: OperationalEventCode): OperationalLog {
    // Runtime validation is mandatory at IPC/caller boundaries, irrespective of TypeScript.
    if (!isOperationalEventCode(code)) throw new OperationalLogsError('OPERATIONAL_LOGS_INVALID');
    this.load(); const next = this.retained();
    const event: OperationalLog = {id:randomUUID(), at:new Date(this.now()).toISOString(),code,...OPERATIONAL_EVENT_CATALOG[code]};
    next.items.push(event); next.items = next.items.slice(-MAX_OPERATIONAL_LOGS);
    const config = next.config;
    const admitted: typeof this.queue = [];
    if (config.enabled && event.level !== 'info' && (config.minimumLevel !== 'error' || event.level === 'error') && config.categories.includes(event.category) && event.category !== 'runtime') {
      for (const provider of ALERT_PROVIDERS) {
        if (!config.providers[provider]) continue;
        if (next.deliveries.some(d => d.provider === provider && d.code === code && Date.parse(d.at) > this.now() - config.cooldownSeconds * 1000)) continue;
        const supported = !!this.transports[provider];
        // Full/blocked queues are uncertain/skipped, never falsely reported as sent or retried.
        const delivery: AlertDelivery = {id:randomUUID(),eventId:event.id,code,provider,at:event.at,status:supported?'unknown':'unsupported'};
        next.deliveries.push(delivery);
        if (supported && !this.blocked.has(provider) && this.queue.length + admitted.length < MAX_ALERT_QUEUE) admitted.push({id:delivery.id,event:structuredClone(event),provider,revision:config.revision});
      }
    }
    next.deliveries = next.deliveries.slice(-MAX_ALERT_DELIVERIES);
    this.commit(next); // Persist unknown admission before any injected external side effect.
    this.queue.push(...admitted); this.startRunner();
    return structuredClone(event);
  }
  deliveries(): AlertDelivery[] { this.load(); return this.retained().deliveries; }
  private startRunner(): void {
    if (this.runner || !this.queue.length) return;
    this.runner = Promise.resolve().then(async () => {
      while(this.queue.length && !this.unhealthy) {
        const work = this.queue.shift()!;
        this.load();
        const config = this.document.config;
        // An intervening configuration change invalidates queued admissions, never revives them.
        if (!config.enabled || config.revision !== work.revision || !config.providers[work.provider] || this.blocked.has(work.provider)) continue;
        const transport = this.transports[work.provider]; if (!transport) continue;
        const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
        let status: AlertDeliveryStatus = 'unknown';
        try {
          const timeout = new Promise<AlertDeliveryStatus>(resolve => {timer = setTimeout(() => {this.blocked.add(work.provider);controller.abort();resolve('unknown');},this.timeoutMs);});
          this.activeTransports++;
          const sending = Promise.resolve().then(() => transport.send(Object.freeze(structuredClone(work.event)),controller.signal))
            .finally(() => { this.activeTransports--; });
          status = await Promise.race([sending,timeout]);
          if (!['unsupported','sent','failed','unknown'].includes(status)) status = 'unknown';
        } catch { status = 'unknown'; } // A thrown transport may have transmitted. Never infer failure.
        finally { if (timer) clearTimeout(timer); }
        this.load(); const next = this.retained(); const entry = next.deliveries.find(d => d.id === work.id);
        if(entry) {entry.status = status; this.commit(next);}
      }
    }).catch(() => {this.unhealthy = true; this.queue = [];}).finally(() => {this.runner = undefined; if (this.queue.length && !this.unhealthy) this.startRunner();});
  }
  async waitForIdle(): Promise<void> {
    while(this.runner) await this.runner;
    // Abort is cooperative: a timed-out adapter may still transmit. Never claim quiescence.
    if(this.unhealthy || this.activeTransports > 0) unavailable();
  }
  async close(): Promise<void> { await this.waitForIdle(); this.closed = true; }
}
const stores = new Map<string, OperationalLogsStore>();
export function operationalLogs(dir: string): OperationalLogsStore {
  const root = path.resolve(dir); let store = stores.get(root);
  if (!store) {store = new OperationalLogsStore(root); stores.set(root,store);} return store;
}
export function operationalLogsHandler(store: OperationalLogsStore, operation: 'logs'|'alerts'|'update'): RequestHandler {
  return (req,res) => {
    res.setHeader('Cache-Control','no-store');
    try { return res.json(operation === 'logs' ? store.query(req.query) : operation === 'alerts' ? store.alerts() : store.updateAlerts(req.body)); }
    catch(e) {
      const code = e instanceof OperationalLogsError ? e.code : 'OPERATIONAL_LOGS_UNAVAILABLE';
      return res.status(code === 'OPERATIONAL_LOGS_INVALID'?400:code === 'OPERATIONAL_LOGS_CONFLICT'?409:503).json({code,error:'Operational logs request could not be completed.'});
    }
  };
}
