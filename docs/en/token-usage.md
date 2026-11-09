# Token usage and manuscript review workspace

[中文说明](../token-usage.md)

## Access and filters

The administration console includes **Token usage**. Authenticated access requires the explicit `usage.read` permission, granted only to `admin` and `superadmin`, not `operations` or `writer`. Authentication-off local management retains its strict socket/Host/Origin checks. Aggregated operational metadata does not grant access to tenant manuscripts or credentials.

`GET /api/admin/token-usage?from=YYYY-MM-DD&to=YYYY-MM-DD&model=...` accepts inclusive UTC calendar dates spanning 1–31 days. Optional `model` is an exact model-name filter. Both sides validate real calendar dates. See the [shared contract](../../shared/token-usage.ts).

## Time display

Frontend timestamps use a fixed eight-hour offset and the exact `yyyy:mm:dd HH:mm` format without a timezone suffix. For example, `2026-11-07T05:03:04.206Z` displays as `2026:11:07 13:03`, independently of browser locale or host timezone. Stored timestamps remain unchanged. Statistical day filters, daily buckets and rate denominators still use UTC calendar days; bucket labels use `yyyy:mm:dd` without inventing a time for a daily aggregate.

## Metric definitions

Input/output/total tokens, request counts, succeeded/failed/pending counts and estimated-request counts are reported. Average RPM and TokenPM divide requests/tokens by **all minutes in the complete selected UTC days**, not only active minutes. Peaks use actual UTC minute buckets rather than daily averages. These are observed usage metrics, not provider rate limits.

Provider counts take precedence; missing usage is estimated and marked. Estimates are not billing records. Historical calls not recorded before this update are not backfilled; coverage is explicitly incomplete. Retention is currently 31 UTC calendar days. Admission is recorded before networking: a crash can leave a pending reservation without proof the provider received it. Telemetry persistence failure must never cause automatic replay of completed model work.

Three.js pie and bar charts display model proportions and daily totals. Equivalent keyboard-accessible tables remain available, including when WebGL is unavailable. Charts are lazy-loaded and GPU resources are disposed on unmount. Stale/unmounted filter requests cannot overwrite the active view.

## Persistence and privacy

The ledger is separate control-plane operational metadata, not a fallback from tenant SQL. Fixed-tenant workers submit validated counters through a private channel. The ledger does not store prompts, manuscripts, keys, endpoint URLs, user/project/run identifiers. Model names remain visible dimensions; do not put secrets in them. See [administration internals](../../packages/server/src/features/administration/README.md) for bounds and failure behavior. Full application backups include this local control-plane file; it is not a tenant SQL snapshot document. Online backups require the all-writers quiescence barrier; stop all runtimes before restore or migration. Never expose the ledger as a public static file.

Bounded synchronous atomic whole-file writes can block the control-plane event loop. Limits are 150,000 minute/model buckets, 100,000 retained attempt registrations and 64 MiB serialized bytes. This is not a high-throughput billing warehouse; capacity, corruption and I/O errors never masquerade as zero usage.

## Review layout

The manuscript page groups progress, live preview and candidates in a collapsible workspace. It removes the fixed 180px card caps and fixed page height, provides at least 360px reading panes, complete-body expansion without inner scrolling, and stacked comparison on narrow screens. Collapse is display-only: it neither cancels generation nor adopts candidates. Existing confirmation, dirty-editor and revision safeguards remain.

After building, run the isolated synthetic-data checks:

```sh
node scripts/smoke-token-usage.mjs
node scripts/smoke-generation-review.mjs
```

Mocked browser data validates UI behavior, not backend authorization. No real paid model, personal profile or publishing account is required.
