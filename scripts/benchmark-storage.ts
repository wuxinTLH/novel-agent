import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import {
  RelationalStorage,
  type RelationalAdapter,
} from '../packages/server/src/infrastructure/storage/relational-storage.js';

// SIMULATION ONLY: fixed transaction service time, four connections, no database.
// Baseline adds the old profile-wide admission externally; both paths execute the
// current storage API/SQL shape. This is NOT a SQL throughput or before/after DB claim.
const count = Number(process.env.BENCH_OPERATIONS ?? 80);
const latency = Number(process.env.BENCH_LATENCY_MS ?? 5);
const repeats = Number(process.env.BENCH_REPEATS ?? 3);
if (![count, latency, repeats].every((n) => Number.isInteger(n) && n > 0 && n <= 10000))
  throw new Error('INVALID_BENCH_CONFIG');

async function run(mode: 'profile-serialized' | 'per-owner', owners: number) {
  let active = 0,
    peak = 0,
    permits = 4;
  const waiting: Array<() => void> = [];
  const adapter: RelationalAdapter = {
    dialect: 'postgresql',
    async close() {},
    async begin() {
      if (!permits) await new Promise<void>((resolve) => waiting.push(resolve));
      else permits--;
      active++;
      peak = Math.max(peak, active);
      return {
        async query(sql) {
          return sql.startsWith('SELECT revision FROM') ? [{ revision: 0 }] : [];
        },
        async commit() {
          await delay(latency);
        },
        async rollback() {},
        release() {
          active--;
          const next = waiting.shift();
          if (next) next();
          else permits++;
        },
      };
    },
  };
  const storage = new RelationalStorage(
    {
      driver: 'postgresql',
      host: 'localhost',
      port: 5432,
      database: 'simulated',
      user: 'simulated',
      tls: 'off',
      timeoutMs: 1000,
    },
    adapter,
  );
  let tail = Promise.resolve();
  const latencies: number[] = [];
  const start = performance.now();
  await Promise.all(
    Array.from({ length: count }, (_, i) => {
      const submitted = performance.now();
      const work = () => storage.writeDocument(`owner-${i % owners}`, `key-${i}`, 'payload', 0);
      const operation = mode === 'profile-serialized' ? tail.then(work) : work();
      if (mode === 'profile-serialized') tail = operation.then(() => {});
      return operation.then(() => {
        latencies.push(performance.now() - submitted);
      });
    }),
  );
  const elapsedMs = performance.now() - start;
  latencies.sort((a, b) => a - b);
  assert.equal(active, 0);
  await storage.close();
  return {
    mode,
    owners,
    operations: count,
    elapsedMs: +elapsedMs.toFixed(2),
    opsPerSecond: +((count * 1000) / elapsedMs).toFixed(2),
    p50Ms: +latencies[Math.floor(count * 0.5)].toFixed(2),
    p95Ms: +latencies[Math.min(count - 1, Math.floor(count * 0.95))].toFixed(2),
    peakTransactions: peak,
  };
}
console.log(
  JSON.stringify({
    label: 'LOCAL SIMULATED CONCURRENCY — NOT REAL DATABASE PERFORMANCE',
    node: process.version,
    count,
    latencyMs: latency,
    repeats,
    poolSize: 4,
  }),
);
// Unreported warm-up uses the same workload; reported samples follow.
await run('per-owner', 8);
for (let sample = 1; sample <= repeats; sample++)
  for (const owners of [1, 8])
    for (const mode of ['profile-serialized', 'per-owner'] as const)
      console.log(JSON.stringify({ sample, ...(await run(mode, owners)) }));
