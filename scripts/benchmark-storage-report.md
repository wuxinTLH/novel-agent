# Storage admission benchmark and acceptance report

## Scope

**Local simulated concurrency only; not real database performance evidence.** The adapter supplies four connection permits and nominal 5 ms commit delay, with no network, SQL execution, durable storage, rollback simulation or database locking. Baseline adds a profile-wide serial queue around the current storage implementation, approximating the old admission bottleneck, not an old-version SQL benchmark. Host timer granularity made individual nominal 5 ms waits roughly 15 ms. Node v24.11.1, 80 operations, one unreported warm-up, three measured samples.

Reproduce from the repository root:

```sh
npx tsx scripts/benchmark-storage.ts
```

Optional configuration: `BENCH_OPERATIONS`, `BENCH_LATENCY_MS`, `BENCH_REPEATS` (positive integers, at most 10000). Output is JSON Lines, with elapsed time, throughput, submission-to-completion p50/p95, owner count and observed active transactions. All operations are submitted together (queue-inclusive latencies, not steady-state service latency).

## Actually measured samples

| Sample | Owners | Profile queue elapsed ms / ops/s / p95 ms | Owner queue elapsed ms / ops/s / p95 ms |
| ------ | -----: | ----------------------------------------- | --------------------------------------- |
| 1      |      1 | 1236.76 / 64.69 / 1188.83                 | 1248.85 / 64.06 / 1200.74               |
| 2      |      1 | 1238.83 / 64.58 / 1192.95                 | 1231.93 / 64.94 / 1185.14               |
| 3      |      1 | 1236.36 / 64.71 / 1190.40                 | 1242.17 / 64.40 / 1195.46               |
| 1      |      8 | 1237.41 / 64.65 / 1190.68                 | 307.03 / 260.56 / 306.75                |
| 2      |      8 | 1249.95 / 64.00 / 1202.86                 | 308.59 / 259.24 / 308.19                |
| 3      |      8 | 1217.03 / 65.73 / 1191.46                 | 315.53 / 253.54 / 315.27                |

Observed peak transactions: baseline 1; owner queue with one owner 1; owner queue with eight owners 4. Eight-owner throughput ratio 3.86–4.05x. Same-owner throughput essentially unchanged. These results establish the simulated bottleneck's removal only; real DB throughput, lock contention, SQL Server lock escalation and MySQL serializable/range-lock behavior remain unmeasured.

## Correctness and live acceptance

Executed the two relational storage test files via `npx tsx --test`: **42/42 passed**. Controlled adapter tests deliberately do not serialize transactions and prove owner admission, barrier ordering through commit, exclusive import/migration, and begin/query/commit failure cleanup. Existing transactional fixture tests cover CAS, projection reconstruction, import receipts and snapshot roundtrip, but are not real database isolation evidence.

Executed `npx tsx scripts/test-relational-storage-live.ts`: **SKIPPED**, because PGHOST, PGPORT, PGUSER, PGPASSWORD and PGDATABASE were absent and explicit create-database opt-in was unset. No credential files were searched; only the example environment file was read. No database was touched.

The new optional PostgreSQL v3 script accepts those named variables plus `STORAGE_LIVE_ALLOW_CREATE_DATABASE=1` and `STORAGE_LIVE_TLS=verify|off` (default verify; off remains constrained by storage's loopback validation). Requires CREATEDB and uses PGDATABASE only to issue CREATE/DROP DATABASE. It creates two unique random databases, migrates twice, exercises Unicode projections, receipt idempotency, same-owner CAS concurrency, independent-owner progress during a held real commit, snapshot waiting, restore into an empty target, and nonempty restore rejection. Cleanup drops only databases successfully created in that invocation, never an existing user database, and never uses FORCE or session termination. It suppresses server errors/credentials. It has not been run against a live DB here; MySQL and SQL Server live acceptance remains unimplemented.

Final integrated validation: repository `npm test` passed **392/392**, and `npm run build` passed, including root type checking and both workspace production builds. The benchmark numbers above remain simulated measurements; passing integration tests does not convert them into live-database evidence.

## Remaining boundaries

Admission is per RelationalStorage instance, before connection acquisition. SQL shared repository locks preserve cross-instance exclusion against exclusive snapshot locks, and DB owner locks preserve CAS. Schema migration uses a local exclusive admission barrier and existing database migration locks; it is not a distributed online schema-change coordinator. Reads of projected documents take owner locks without creating missing owners. Writers still resolve only after commit; no write-behind. Auth control-plane async activation is outside this storage change and belongs to the parent task.
