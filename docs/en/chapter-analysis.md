# Chapter analysis

[中文](../chapter-analysis.md) · [User guide](user-guide.md) · [English documentation index](README.md)

## Purpose and operation

Chapter analysis sends saved canonical chapters to the live model explicitly selected by the user and produces an independent report. It is not generation, automatic repair or candidate adoption: it does not change manuscript text, revision history, candidates, assets or publication queues, and never uploads to a publishing platform.

1. Save the intended manuscript first. Unsaved editor changes and unadopted candidates are not canonical inputs.
2. Open chapter analysis from manuscripts, choose an inclusive chapter-number range or the latest N saved chapters, and select an available live model.
3. Check the scope/model and explicitly start. This sends chapter content to that provider and may incur charges. Selecting a scope, opening the panel or reading an existing report should not call the model.
4. Check status and read the completed report. Reports persist independently and can be reopened without another paid request. Later manuscript edits do not update an old report; compare its source chapter revisions before relying on it.

Model conclusions are suggestions, not factual proof, a quality guarantee or automatic editing instructions. Do not analyze text you are not permitted to send to the selected provider.

## Limits and status

- At most 100 saved chapters per request. Manual selection uses chapter numbers; latest N does not include unsaved editor drafts.
- The complete prompt is limited to 150000 characters and the report to 100000 characters. Oversized input/output is rejected or fails, not silently truncated into an apparently complete report. Prompt instructions consume part of the input allowance.
- No demo reports, silent model fallback or automatic model retries. Inspect failure status before creating another potentially chargeable request.
- Status is `running`, `done`, `error` or `interrupted`. Errors/interruption are not successful reports and do not prove that the provider did not process or charge for the call.
- Each project retains at most 100 analysis records. At capacity, a new request returns `409 ANALYSIS_HISTORY_FULL`. Historical records and `requestId` values are not evicted to make room; existing request idempotency remains intact.
- If the model finishes but saving the result fails, the durably stored `running` record remains: the application does not pretend it is `done` or call the model again. Repair storage before restarting; restart marks the leftover run `interrupted`. Automatic recovery of an unsaved report is not promised.
- Source chapter ID, number, title, revision and hash are retained, without an additional stored source-body copy. Reports may quote prose and must still be protected as project content.

## API contract

See [shared/chapter-analysis.ts](../../shared/chapter-analysis.ts). Existing project access, tenant isolation and write Origin/CSRF protections apply; this authoring feature is distinct from administrator-only Token statistics.

- `POST /api/projects/:projectId/chapter-analyses` accepts `{requestId, selection, modelId}`. `requestId` is a UUID and `modelId` must be explicit.
- Range: `selection: {kind: "range", from: 1, to: 10}`. Latest: `selection: {kind: "recent", count: 10}`. Use valid positive integer chapter numbers/counts; the selected set cannot exceed 100 chapters.
- A new request returns `202` with the direct `running` record, not an extra record envelope. Replaying the same `requestId` with identical parameters returns `200` and the original record without another model call. Reusing it with different parameters returns `409 ANALYSIS_REQUEST_CONFLICT`. Deliberate re-analysis requires an explicitly new request; idempotent replay is not rerun.
- `GET /api/projects/:projectId/chapter-analyses` returns the record array directly.
- `GET /api/projects/:projectId/chapter-analyses/:analysisId` returns one record. Reading never calls the model again.

## Validation boundary

This guide describes the v0.0.5a (`0.0.5-a` package SemVer) contract. Isolated tests, synthetic model responses and browser smoke tests prove only the local behaviors they exercise, not live-model analysis quality, provider billing, platform publication or real-database compatibility. Historical v0.0.4a counts are not acceptance results for this release.
