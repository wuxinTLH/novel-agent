import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TokenUsageMetrics, TokenUsageResponse } from '../../../../../shared/token-usage.js';

const count = z.number().int().nonnegative().safe();
export const usageEventSchema = z.object({ model: z.string().min(1).max(200), at: z.string().datetime(), succeeded: z.boolean(), inputTokens: count, outputTokens: count, estimated: z.boolean(), phase: z.enum(['begin', 'finish', 'complete']).default('complete'), attemptId: z.string().uuid().optional() }).strict();
export type UsageEvent = z.input<typeof usageEventSchema>;
const bucketSchema = z.object({ minute: z.string().datetime(), model: z.string().min(1).max(200), requests: count, succeeded: count, failed: count, pending: count.default(0), inputTokens: count, outputTokens: count, estimatedRequests: count }).strict().refine(b => b.requests === b.succeeded + b.failed + b.pending && b.estimatedRequests <= b.succeeded + b.failed, 'Inconsistent usage counters');
type Bucket = z.infer<typeof bucketSchema>;
const schema = z.object({ version: z.literal(1), startedAt: z.string().datetime(), buckets: z.array(bucketSchema).max(150000), attempts: z.array(z.object({ id: z.string().uuid(), minute: z.string().datetime(), model: z.string().min(1).max(200), finished: z.boolean() }).strict()).max(100000).default([]) }).strict();
const retentionDays = 31;
function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) throw new Error('TOKEN_USAGE_RANGE_INVALID');
  return value;
}
export function usageRange(from: unknown, to: unknown, model?: unknown) {
  const start = date(from), end = date(to);
  const days = (Date.parse(end) - Date.parse(start)) / 86400000 + 1;
  if (days < 1 || days > 31 || (model !== undefined && (typeof model !== 'string' || !model.length || model.length > 200))) throw new Error('TOKEN_USAGE_RANGE_INVALID');
  return { from: start, to: end, days, model: model as string | undefined };
}
function empty(): TokenUsageMetrics { return { requests: 0, succeeded: 0, failed: 0, pending: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedRequests: 0, rpm: { average: 0, peak: 0 }, tokenPm: { average: 0, peak: 0 } }; }
function aggregate(buckets: Bucket[], minutes: number): TokenUsageMetrics {
  const result = empty(), peaks = new Map<string, { requests: number; tokens: number }>();
  for (const b of buckets) {
    for (const key of ['requests', 'succeeded', 'failed', 'pending', 'inputTokens', 'outputTokens', 'estimatedRequests'] as const) result[key] += b[key];
    const minute = peaks.get(b.minute) ?? { requests: 0, tokens: 0 };
    minute.requests += b.requests; minute.tokens += b.inputTokens + b.outputTokens; peaks.set(b.minute, minute);
  }
  result.totalTokens = result.inputTokens + result.outputTokens;
  result.rpm.average = result.requests / minutes; result.tokenPm.average = result.totalTokens / minutes;
  for (const p of peaks.values()) { result.rpm.peak = Math.max(result.rpm.peak, p.requests); result.tokenPm.peak = Math.max(result.tokenPm.peak, p.tokens); }
  return result;
}
/** Separate control-plane telemetry, deliberately never routed through tenant business SQL. Single main-thread writer. */
export class TokenUsageLedger {
  private document: z.infer<typeof schema>;
  private healthy = true;
  private readonly file: string;
  constructor(readonly dir: string, private readonly now = () => new Date()) {
    this.file = path.join(dir, 'token-usage.json');
    this.document = { version: 1, startedAt: now().toISOString(), buckets: [], attempts: [] };
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error('unsafe');
      this.document = schema.parse(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('TOKEN_USAGE_STORAGE_UNAVAILABLE'); }
  }
  record(input: UsageEvent): void {
    try {
      if (!this.healthy) throw new Error('unhealthy');
      const event = usageEventSchema.parse(input);
      if (event.phase === 'begin' && (event.inputTokens !== 0 || event.outputTokens !== 0 || event.estimated || event.succeeded)) throw new Error('invalid admission');
      const cutoff = new Date(this.now().getTime() - 30 * 86400000).toISOString().slice(0, 10);
      const buckets = this.document.buckets.filter(b => b.minute.slice(0, 10) >= cutoff).map(b => ({ ...b }));
      const minute = `${event.at.slice(0, 16)}:00.000Z`;
      // A call can finish after retention: do not reintroduce expired buckets.
      if (minute.slice(0, 10) < cutoff) return;
      const attempts = this.document.attempts.filter(a => a.minute.slice(0, 10) >= cutoff).map(a => ({ ...a }));
      const attempt = attempts.find(a => a.id === event.attemptId);
      if (event.phase !== 'complete' && !event.attemptId) throw new Error('attempt required');
      if (attempt && (attempt.minute !== minute || attempt.model !== event.model)) throw new Error('attempt mismatch');
      if (event.phase === 'begin' && attempt) return;
      if (event.phase === 'finish' && attempt?.finished) return;
      if (event.phase === 'finish' && !attempt) throw new Error('unknown attempt');
      let bucket = buckets.find(b => b.minute === minute && b.model === event.model);
      if (!bucket) { bucket = { minute, model: event.model, requests: 0, succeeded: 0, failed: 0, pending: 0, inputTokens: 0, outputTokens: 0, estimatedRequests: 0 }; buckets.push(bucket); }
      if (event.phase === 'begin') {
        bucket.requests++; bucket.pending++;
        attempts.push({ id: event.attemptId!, minute, model: event.model, finished: false });
      } else {
        if (event.phase === 'finish') { bucket.pending--; attempt!.finished = true; } else bucket.requests++;
        bucket.succeeded += Number(event.succeeded); bucket.failed += Number(!event.succeeded);
        bucket.inputTokens += event.inputTokens; bucket.outputTokens += event.outputTokens; bucket.estimatedRequests += Number(event.estimated);
      }
      const next = schema.parse({ ...this.document, buckets, attempts });
      const text = JSON.stringify(next);
      if (Buffer.byteLength(text) > 64 * 1024 * 1024) throw new Error('capacity');
      // Telemetry does not follow an injected file or directory symlink/junction.
      let ancestor = path.resolve(this.dir);
      for (;;) {
        if (fs.existsSync(ancestor)) { const stat = fs.lstatSync(ancestor); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe directory'); }
        const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
      }
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      if (fs.existsSync(this.file)) { const stat = fs.lstatSync(this.file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe file'); }
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        const fd = fs.openSync(temporary, 'wx', 0o600);
        try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temporary, this.file);
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      this.document = next;
    } catch { this.healthy = false; throw new Error('TOKEN_USAGE_STORAGE_UNAVAILABLE'); }
  }
  query(from: unknown, to: unknown, model?: unknown): TokenUsageResponse {
    const range = usageRange(from, to, model);
    if (!this.healthy) throw new Error('TOKEN_USAGE_STORAGE_UNAVAILABLE');
    const earliestDay = new Date(this.now().getTime() - 30 * 86400000).toISOString().slice(0, 10);
    const retained = this.document.buckets.filter(b => b.minute.slice(0, 10) >= earliestDay);
    const buckets = retained.filter(b => b.minute.slice(0, 10) >= range.from && b.minute.slice(0, 10) <= range.to && (!range.model || b.model === range.model));
    const models = [...new Set(retained.map(b => b.model))].sort();
    const windowMinutes = range.days * 1440;
    return { range: { from: range.from, to: range.to, timeZone: 'UTC' }, windowMinutes, models, totals: aggregate(buckets, windowMinutes), byModel: [...new Set(buckets.map(b => b.model))].sort().map(model => ({ model, ...aggregate(buckets.filter(b => b.model === model), windowMinutes) })), daily: Array.from({ length: range.days }, (_, index) => { const day = new Date(Date.parse(range.from) + index * 86400000).toISOString().slice(0, 10); return { day, ...aggregate(buckets.filter(b => b.minute.startsWith(day)), 1440) }; }), coverage: { startedAt: this.document.startedAt, retentionDays, earliestDay, complete: false } };
  }
}
const ledgers = new Map<string, TokenUsageLedger>();
export function tokenUsageLedger(dir: string): TokenUsageLedger { const key = path.resolve(dir); let ledger = ledgers.get(key); if (!ledger) { ledger = new TokenUsageLedger(key); ledgers.set(key, ledger); } return ledger; }
