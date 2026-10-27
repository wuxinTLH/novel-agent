import { Worker } from 'node:worker_threads';
import type { SQLConnectConfig } from '../../../../../shared/sqlconnect.js';
import type { DocumentStorage } from './document-storage.js';

/** Shared wire layout: [completed, response byte length], followed by UTF-8 JSON.
 * One outstanding operation per bridge. A timed-out bridge is never reused.
 */
export const DATABASE_RESPONSE_HEADER_BYTES = 8;
export const MAX_DATABASE_RESPONSE_BYTES = 64 * 1024 * 1024;
export interface PooledStorageBridgeOptions {
  /** Test seam; production always uses the private database worker. */
  workerUrl?: URL;
  responseBytes?: number;
  timeoutMs?: number;
}
interface WorkerResponse<T> {
  ok: boolean;
  result?: T;
  code?: string;
}
function unavailable(code: string): Error & { code: string; status: number } {
  return Object.assign(new Error('SQL operation was not acknowledged; storage requires reconciliation.'), {
    code,
    status: 503,
  });
}

/** Synchronous durable facade for an ISOLATED tenant runtime, never the HTTP router.
 * The persistent worker owns its asynchronous pool and acknowledges only after COMMIT.
 * No automatic retries, fallback, or write-behind are permitted.
 */
export class PooledStorageBridge implements DocumentStorage {
  private readonly worker: Worker;
  private readonly shared: SharedArrayBuffer;
  private readonly header: Int32Array;
  private readonly bytes: Uint8Array;
  private readonly timeoutMs: number;
  private readonly revisions = new Map<string, number>();
  private readonly exited: Promise<void>;
  private failed = false;
  private closing = false;
  private closeTask?: Promise<void>;

  constructor(
    config: SQLConnectConfig,
    readonly ownerId: string,
    options: PooledStorageBridgeOptions = {},
  ) {
    const responseBytes = options.responseBytes ?? MAX_DATABASE_RESPONSE_BYTES;
    this.timeoutMs = options.timeoutMs ?? config.timeoutMs + 15_000;
    if (
      !Number.isSafeInteger(responseBytes) ||
      responseBytes < 256 ||
      responseBytes > MAX_DATABASE_RESPONSE_BYTES ||
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs <= 0
    )
      throw new Error('INVALID_DATABASE_WORKER_LIMITS');
    this.shared = new SharedArrayBuffer(DATABASE_RESPONSE_HEADER_BYTES + responseBytes);
    this.header = new Int32Array(this.shared, 0, 2);
    this.bytes = new Uint8Array(this.shared, DATABASE_RESPONSE_HEADER_BYTES);
    const source = import.meta.url.endsWith('.ts');
    const workerUrl =
      options.workerUrl ?? new URL(source ? './database-worker.ts' : './database-worker.js', import.meta.url);
    const workerData = { config, ownerId, shared: this.shared };
    if (workerUrl.pathname.endsWith('.ts')) {
      // Node workers do not reliably inherit tsx's loader registration. Bootstrap it
      // explicitly without putting configuration or credentials in executable text.
      const bootstrap =
        `const { workerData } = require('node:worker_threads');\n` +
        `import('tsx/esm/api').then(({ tsImport }) => tsImport(workerData.moduleUrl, workerData.moduleUrl)).catch(() => {\n` +
        `const h = new Int32Array(workerData.shared, 0, 2); const b = new Uint8Array(workerData.shared, 8);\n` +
        `const v = new TextEncoder().encode(JSON.stringify({ok:false,code:'DATABASE_WORKER_START_FAILED'}));\n` +
        `b.set(v); Atomics.store(h,1,v.length); Atomics.store(h,0,1); Atomics.notify(h,0); });`;
      this.worker = new Worker(bootstrap, {
        eval: true,
        execArgv: [],
        workerData: { ...workerData, moduleUrl: workerUrl.href },
      });
    } else {
      this.worker = new Worker(workerUrl, { workerData });
    }
    // Never forward a worker exception: connection/driver messages may contain secrets.
    this.worker.on('error', () => {
      this.failed = true;
    });
    this.exited = new Promise((resolve) =>
      this.worker.once('exit', () => {
        if (!this.closing) this.failed = true;
        resolve();
      }),
    );
    try {
      this.receive<void>(); // Startup handshake, not an implicit migration or network probe.
    } catch (error) {
      void this.worker.terminate();
      throw error;
    }
  }

  assertHealthy(): void {
    if (this.failed || this.closing) throw unavailable('STORAGE_RECONCILIATION_REQUIRED');
  }

  private receive<T>(): T {
    const deadline = Date.now() + this.timeoutMs;
    while (Atomics.load(this.header, 0) === 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || Atomics.wait(this.header, 0, 0, remaining) === 'timed-out') {
        this.failed = true;
        throw unavailable('DATABASE_WORKER_TIMEOUT');
      }
    }
    const length = Atomics.load(this.header, 1);
    let response: WorkerResponse<T>;
    try {
      if (length <= 0 || length > this.bytes.length) throw new Error('INVALID_RESPONSE');
      response = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(this.bytes.subarray(0, length)),
      ) as WorkerResponse<T>;
      if (!response || typeof response.ok !== 'boolean') throw new Error('INVALID_RESPONSE');
    } catch {
      this.failed = true;
      throw unavailable('DATABASE_WORKER_INVALID_RESPONSE');
    }
    if (!response.ok) {
      this.failed = true;
      throw unavailable(
        response.code && /^[A-Z_]{3,64}$/.test(response.code) ? response.code : 'DATABASE_WORKER_FAILED',
      );
    }
    return response.result as T;
  }

  request<T>(operation: string, payload: Record<string, unknown> = {}): T {
    this.assertHealthy();
    Atomics.store(this.header, 1, 0);
    Atomics.store(this.header, 0, 0);
    try {
      this.worker.postMessage({ operation, payload });
    } catch {
      this.failed = true;
      throw unavailable('DATABASE_WORKER_SEND_FAILED');
    }
    return this.receive<T>();
  }

  read(key: string): string | null {
    const value = this.request<{ revision: number; content: string } | null>('read', { key });
    this.revisions.set(key, value?.revision ?? 0);
    return value?.content ?? null;
  }

  write(key: string, content: string): void {
    if (!this.revisions.has(key)) this.read(key);
    const next = this.request<number>('write', { key, content, revision: this.revisions.get(key) });
    this.revisions.set(key, next);
  }

  /** Close is asynchronous so graceful pool draining never blocks the parent router.
   * A deadline force-terminates a stuck worker; this NEVER makes a timed-out write safe to retry.
   */
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    this.closeTask = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        this.worker.postMessage({ operation: 'close', payload: {} });
        await Promise.race([
          this.exited,
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              void this.worker.terminate().then(() => resolve());
            }, this.timeoutMs);
          }),
        ]);
      } catch {
        await this.worker.terminate();
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    return this.closeTask;
  }
}
