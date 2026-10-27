import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { SQLConnectConfig } from '../../shared/sqlconnect.js';
import type { DocumentStorage } from './document-storage.js';

/** Compatibility bridge for existing synchronous durability barriers.
 * Deliberately blocks the event loop until actual PostgreSQL COMMIT; no write-behind.
 * Single service process only; CAS rejects stale writes from other processes.
 */
export class PostgresBridge implements DocumentStorage {
  private revisions = new Map<string, number>();
  private failed = false;
  constructor(
    private config: SQLConnectConfig,
    readonly ownerId: string,
  ) {}
  assertHealthy(): void {
    if (this.failed)
      throw Object.assign(new Error('SQL 存储需重启核对，禁止继续操作。'), {
        code: 'STORAGE_RECONCILIATION_REQUIRED',
        status: 503,
      });
  }
  request<T>(operation: string, payload: Record<string, unknown> = {}): T {
    this.assertHealthy();
    const source = import.meta.url.endsWith('.ts');
    const worker = fileURLToPath(
      new URL(source ? './postgres-worker.ts' : './postgres-worker.js', import.meta.url),
    );
    const result = spawnSync(process.execPath, [...(source ? ['--import', 'tsx'] : []), worker], {
      input: JSON.stringify({ config: this.config, ownerId: this.ownerId, operation, ...payload }),
      encoding: 'utf8',
      timeout: this.config.timeoutMs + 15_000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    let response: { ok: boolean; result: T; code?: string } | undefined;
    try {
      response = JSON.parse(result.stdout || '');
    } catch {
      /* Unknown outcome: fail closed. */
    }
    if (result.error || result.status !== 0 || !response?.ok) {
      this.failed = true;
      throw Object.assign(new Error('SQL 操作未确认完成；已停止当前存储，请重启并核对状态。'), {
        code: response?.code || 'POSTGRES_OUTCOME_UNKNOWN',
        status: 503,
      });
    }
    return response.result;
  }
  read(key: string): string | null {
    const value = this.request<{ revision: number; content: string } | null>('read', { key });
    this.revisions.set(key, value?.revision || 0);
    return value?.content ?? null;
  }
  write(key: string, content: string): void {
    if (!this.revisions.has(key)) this.read(key);
    const revision = this.request<number>('write', { key, content, revision: this.revisions.get(key) });
    this.revisions.set(key, revision);
  }
}
