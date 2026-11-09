import { randomUUID } from 'node:crypto';
import type { MessagePort, Worker } from 'node:worker_threads';
import { tokenUsageLedger, usageEventSchema, type UsageEvent } from './token-usage.js';

const type = 'token-usage-v1';
/** A private worker port binds the destination root; messages cannot select owners or paths. */
export function bindTokenUsageWorker(worker: Worker, root: string): void {
  worker.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object' || (message as { type?: unknown }).type !== type) return;
    const input = message as { requestId?: unknown; event?: unknown };
    if (typeof input.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.requestId)) return;
    let ok = false;
    try { tokenUsageLedger(root).record(usageEventSchema.parse(input.event)); ok = true; } catch { /* sanitized durable acknowledgement */ }
    try { worker.postMessage({ type, requestId: input.requestId, ok }); } catch { /* worker exit is not a reason to replay */ }
  });
}
let reporter: ((event: UsageEvent) => Promise<void>) | undefined;
export function installTokenUsageWorker(port: MessagePort): void {
  const pending = new Map<string, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const unavailable = () => new Error('TOKEN_USAGE_STORAGE_UNAVAILABLE');
  port.on('message', (message: { type?: string; requestId?: string; ok?: boolean }) => {
    if (message?.type !== type || !message.requestId) return;
    const item = pending.get(message.requestId); if (!item) return;
    pending.delete(message.requestId); clearTimeout(item.timer);
    if (message.ok === true) item.resolve(); else item.reject(unavailable());
  });
  port.once('close', () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(unavailable()); } pending.clear(); });
  reporter = event => new Promise<void>((resolve, reject) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => { pending.delete(requestId); reject(unavailable()); }, 10000);
    pending.set(requestId, { resolve, reject, timer });
    try { port.postMessage({ type, requestId, event }); }
    catch { clearTimeout(timer); pending.delete(requestId); reject(unavailable()); }
  });
}
export async function recordTokenUsage(dir: string, event: UsageEvent): Promise<void> {
  if (reporter) await reporter(event); else tokenUsageLedger(dir).record(event);
}
