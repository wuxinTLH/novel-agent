import { parentPort, workerData } from 'node:worker_threads';
import type { SQLConnectConfig } from '../../../../../shared/sqlconnect.js';
import { RelationalStorage } from './relational-storage.js';

interface DatabaseWorkerData {
  config: SQLConnectConfig;
  ownerId: string;
  shared: SharedArrayBuffer;
}
const data = workerData as DatabaseWorkerData;
const port = parentPort;
if (!port) throw new Error('DATABASE_WORKER_REQUIRES_PARENT');
const header = new Int32Array(data.shared, 0, 2);
const bytes = new Uint8Array(data.shared, 8);
const encoder = new TextEncoder();
function respond(value: unknown): void {
  let encoded: Uint8Array;
  try {
    encoded = encoder.encode(JSON.stringify({ ok: true, result: value }));
  } catch {
    encoded = encoder.encode(JSON.stringify({ ok: false, code: 'DATABASE_RESPONSE_INVALID' }));
  }
  if (encoded.length > bytes.length)
    encoded = encoder.encode(JSON.stringify({ ok: false, code: 'DATABASE_RESPONSE_TOO_LARGE' }));
  bytes.set(encoded);
  Atomics.store(header, 1, encoded.length);
  Atomics.store(header, 0, 1);
  Atomics.notify(header, 0);
}
function fail(error: unknown): void {
  const raw = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const code = /^[A-Z_]{3,64}$/.test(raw) ? raw : 'DATABASE_WORKER_FAILED';
  const encoded = encoder.encode(JSON.stringify({ ok: false, code }));
  bytes.set(encoded);
  Atomics.store(header, 1, encoded.length);
  Atomics.store(header, 0, 1);
  Atomics.notify(header, 0);
}
let storage: RelationalStorage;
let poisoned = false;
let closing = false;
try {
  storage = new RelationalStorage(data.config);
  respond(undefined);
} catch (error) {
  fail(error);
  port.close();
  throw new Error('DATABASE_WORKER_START_FAILED');
}
// A single ordered lane prevents close racing a write and protects the shared reply slot.
// Pools remain alive for this worker's complete lifetime, not one process per checkpoint.
let tail = Promise.resolve();
port.on('message', (request: { operation: string; payload?: Record<string, unknown> }) => {
  tail = tail
    .then(async () => {
      if (request.operation === 'close') {
        if (closing) return;
        closing = true;
        try {
          await storage.close();
        } finally {
          port.close();
        }
        return;
      }
      if (poisoned || closing) {
        fail({ code: 'STORAGE_RECONCILIATION_REQUIRED' });
        return;
      }
      const payload = request.payload ?? {};
      try {
        let result: unknown;
        switch (request.operation) {
          case 'migrate':
            result = await storage.migrate();
            break;
          case 'read':
            result = await storage.readDocument(data.ownerId, payload.key as string);
            break;
          case 'write':
            result = await storage.writeDocument(
              data.ownerId,
              payload.key as string,
              payload.content as string,
              payload.revision as number,
            );
            break;
          case 'import':
            result = await storage.importDocuments(
              data.ownerId,
              payload.sourceHash as string,
              payload.documents as Parameters<RelationalStorage['importDocuments']>[2],
            );
            break;
          case 'exportSnapshot':
            result = await storage.exportSnapshot();
            break;
          case 'importSnapshot':
            result = await storage.importSnapshot(
              payload.snapshot as Parameters<RelationalStorage['importSnapshot']>[0],
            );
            break;
          default:
            throw { code: 'UNKNOWN_OPERATION' };
        }
        // Repository methods resolve only after successful COMMIT acknowledgment.
        respond(result);
      } catch (error) {
        poisoned = true;
        fail(error);
      }
    })
    .catch(() => {
      poisoned = true;
      fail({ code: 'DATABASE_WORKER_FAILED' });
    });
});
