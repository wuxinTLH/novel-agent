# Chapters

Chapter management routes live here. Mutations use the existing project lookup, running-workflow/platform-idle guards, HTTP origin/CSRF policy and synchronous `mutateProject` durability/rollback boundary.

## Independent chapter analysis

`shared/chapter-analysis.ts` defines the strict shared contract. `POST /api/projects/:projectId/chapter-analyses` accepts `{ requestId: UUID, selection: { kind: 'range', from, to } | { kind: 'recent', count }, modelId }`. A new request returns **202** with the durably saved `ChapterAnalysis` running record, not a completed report. `GET` on the same URL returns `ChapterAnalysis[]`; `GET /:analysisId` returns one record for polling and repeated viewing. Replaying an admitted request returns **200** with the existing record regardless of terminal status and never reissues a model request; changed selection/model under the same request ID returns `409 ANALYSIS_REQUEST_CONFLICT`.

- States are `running`, `done`, `error`, `interrupted`. Records retain selection, model ID/display name, timestamps and source chapter ID/number/title/revision/SHA-256 content hash. Only `done` contains the bounded Markdown report. No API keys, raw provider errors or original prose snapshots are stored in records. Canonical project persistence also retains these fields through SQL entity projection without a new sidecar or database table.
- Selection uses canonical chapters sorted by stable chapter number, not array order, candidates or revision archives. Recent N requires N available chapters. Inclusive ranges require both endpoints to exist; gaps between endpoints are allowed. Empty selected prose, unavailable boundaries and insufficient recent chapters return `400 ANALYSIS_SELECTION_UNAVAILABLE`. Maximum selection is 100 chapters. Complete input is capped at 150,000 UTF-16 characters and reports at 100,000; neither is silently truncated. At 100 retained reports, new requests return `409 ANALYSIS_HISTORY_FULL`; existing deduplication records are never automatically evicted.
- The explicitly selected enabled live model must have a configured key; there is no demo/default fallback. The existing protocol transport, public URL validation, preflight budgets/timeouts and durable token telemetry begin/finish are reused. Prompts ask for chapter-number-backed observations and separately marked suggestions on narration, pacing, plot structure, character arcs, foreshadowing and continuity. This does not prove actual model quality.
- Each project admits at most one running analysis (`409 ANALYSIS_BUSY`). Different projects and fixed-owner tenant contexts are independent. Reports never mutate canonical chapters, candidates, workflow graphs or their outputs. Completion updates the current project, so intervening author edits are preserved; snapshot metadata identifies the analyzed revisions.
- Durable admission precedes transport. A failed admission save invokes no model. A failed terminal save rolls back to the durable running record, never fabricates `done`, and never retries the remote request; that project remains busy until restart. Restart persists `interrupted` with `ANALYSIS_INTERRUPTED` and does not retry. Graceful tenant shutdown aborts/drains analyses before storage unbinding. Both ordinary and retained-platform project deletion are blocked while a running analysis exists.
- Existing verified-owner routing, same-origin/CSRF and project lookup protect the endpoints. This repository's ordinary workspace routes have no separate deny-default role classifier; analysis follows their existing verified-principal boundary, not administrator data access.

`chapter-analysis.test.ts` uses isolated temporary data and injected provider stubs to cover admission, snapshots, author edits, errors, limits, idempotency, tenant/project independence, persistence rollback, restart, shutdown and guarded HTTP routes. `relational-storage.test.ts` covers analysis passthrough for PostgreSQL/MySQL/SQL Server adapters; it is simulated SQL verification, not live database acceptance or paid provider evaluation.

## Continuity after editing or restoring chapters

Saving or restoring canonical chapter `n` invalidates generated contexts targeting chapter `n` or later across the active and inactive workflow graphs. Earlier target contexts are retained. Prior node output remains available for inspection, but invalidated nodes become idle and lose their generation metadata, so standalone downstream execution must regenerate its upstream dependencies. Chapter revision CAS and synchronous persistence rollback apply to the chapter and workflow invalidation together. `chapter-continuity.test.ts` exercises these routes without a listener or network, including stale revisions and persistence failure.

## Atomic local bulk deletion

`POST /api/projects/:projectId/chapters/delete` accepts a strict JSON object:

```json
{
  "chapters": [{ "id": "chapter-id", "expectedRevision": 3 }],
  "workflowId": "active-workflow-id"
}
```

- `chapters` contains 1–500 unique chapter IDs. Each item is strict; `id` is a nonempty string and `expectedRevision` is a positive integer. `workflowId` is optional and, when supplied, must be a nonempty string matching the active workflow.
- Unknown fields, duplicates and invalid bounds return `400 INVALID_INPUT`. A missing chapter (including one belonging to another project), stale revision or replay after deletion returns `409 REVISION_CONFLICT`. A changed active workflow returns `409 WORKFLOW_CONFLICT`.
- The complete selection is checked before mutation. On success one synchronous project mutation removes all selected canonical chapters, invalidates the active workflow outputs using the same mechanism as single deletion and returns the updated `Project` with status 200. Validation failure leaves memory/storage unchanged; persistence failure restores the in-memory project and does not return success.
- Chapter numbers are never renumbered or reused by lowering the high watermark. The watermark retains its prior value and any existing canonical/candidate number reservation, even when deleting every chapter. Surviving chapters, candidates and inactive workflows are preserved.
- This is local canonical deletion only. It does not change platform records, publication configuration, remote drafts or published chapters, and does not invoke platform publication/removal APIs.
- The existing single `DELETE /api/projects/:projectId/chapters/:chapterId` contract is unchanged (including its missing-chapter 404).

Regression tests in `chapter-delete.test.ts` run the real Express middleware/route stack in memory against isolated temporary storage without starting a listener or contacting a network. They cover atomic stale/missing/foreign selections, duplicates and strict bounds (including 500/501), workflow/run/platform/CSRF/origin guards, one-save success, rollback, watermark retention, numbering and unrelated project/publication preservation.
