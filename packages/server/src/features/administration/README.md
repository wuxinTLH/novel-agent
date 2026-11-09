# Administration

Administration routes and their tests live here.

## Persistent model Token usage

`GET /api/admin/token-usage?from=YYYY-MM-DD&to=YYYY-MM-DD&model=optional-exact-name`
uses explicit `usage.read` (superadmin/admin only, never operations/writer). Authentication-off
local administration retains the existing strict loopback/Host/Origin boundary. Dates are strict
calendar dates in UTC, endpoints inclusive, maximum 31 days. Repeated/structured query values,
invalid dates and reversed ranges return 400. Telemetry unavailability returns sanitized 503.
The shared contract is `shared/token-usage.ts`: range, full-window minutes, totals, byModel,
zero-filled daily metrics, stable retained model options, and coverage metadata.

The control plane owns a separate local `DATA_DIR/token-usage.json` operational-metadata ledger,
**even when tenant business storage is SQL-backed**. This is intentional control-plane telemetry,
not an unregistered SQL document or a fallback for SQL failures. It never opens other tenants'
projects or credentials. Private Worker IPC binds the storage root at Worker construction and
acknowledges only after synchronous fsync + atomic rename; writes execute serially on the main
thread under the existing single-instance data lock. The file stores only model names, UTC minute
buckets, counters and random internal attempt IDs. No tenant/project/run/user IDs, URLs, prompts,
outputs or credentials are persisted/returned. Model names are operator-configured metadata and
not a unique provider identity; the same name across profiles/providers is intentionally merged.

Each generation transport admission durably increments requests/pending immediately before fetch;
preflight/key/DNS/request-serialization failures do not count. Completion moves pending to
succeeded/failed and records known usage. Pending means indeterminate/in-flight, **not confirmed
provider receipt**: a crash between durable admission and fetch can leave a reserved request that
was never transmitted. Restart preserves these unknown outcomes; it does not mark them failed or
retry them. Begin/finish IDs are idempotent for the retained period. Cancellation, HTTP errors,
connection errors, malformed/truncated output count as failed attempts. Provider counts received
before failure are retained; unavailable failure counts remain zero/estimated, not fabricated.
Successful responses lacking counts use existing code-point/image estimates and are marked estimated.
A failed begin prevents network admission (nonretryable telemetry error). A failed finish must not
turn successful generated content into a retryable model error: content remains successful, while
the in-memory ledger is poisoned and admin queries return 503 until recovery/restart. The last
committed pending admission remains on disk; uncertain acknowledgements are never replayed.

All rates include the **entire selected UTC days**, including future/zero-usage minutes:
RPM average = requests / (days * 1440); TokenPM average = tokens / (days * 1440).
Peaks are actual summed UTC minute buckets (tokens attributed to request admission minute), not
averages of days or provider rate-limit readings. Daily averages divide by 1440. Finish timestamps
do not shift a request into a different UTC day. `estimatedRequests` includes completed calls with
any estimated/missing usage; pending tokens are not estimated as spent.

Retention is 31 UTC calendar days including today, pruned on writes and filtered on reads. Hard
bounds are 150,000 minute/model buckets, 100,000 retained attempt IDs and 64 MiB serialized bytes;
capacity/corruption/I/O failures fail closed rather than silently dropping newest data. Atomic
full-file writes are bounded but synchronous and can block the control-plane event loop: this is
not a high-throughput billing warehouse. The report is explicitly `coverage.complete=false`:
no backfill from old bounded per-project history, crash-proof exact billing or pre-installation
zero-usage claim. `startedAt` is the first ledger construction timestamp, committed on first write.

The full application backup walks the data directory, so telemetry is included as a local file,
not as an SQL snapshot document. Use the existing all-writers quiescence barrier for online backup
and stop all runtimes for restore/migration. Keep normal host permissions/Windows ACLs; POSIX 0600
is not a Windows access-control guarantee. No new dependency or network/model call is needed to
test this feature.
