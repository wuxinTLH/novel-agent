# Fanqie integration

[中文原文](../番茄平台接入.md) · [English index](README.md) · [Step-by-step user guide](user-guide.md#fanqie-publication)

This describes v0.0.4a implementation boundaries. Playwright operates an isolated Chromium author session, not an official Fanqie API. Initial login requires an interactive desktop on the backend host. Install with `npm ci` and `npm run browser:install`; start with `npm run dev`, or build and start production normally.

## Supported operations

| Capability | Behavior |
| --- | --- |
| Login | Human completes login/CAPTCHA; verification opens the author homepage and checks live stable identity. |
| Account, book, volume | Read verified account and existing works; explicitly bind one work. Read volumes; multiple volumes require selection. No remote work creation or metadata editing. |
| `save_draft` | Create, reuse an exact editable draft, or overwrite the same verified draft ID, then read back full text. No review submission. |
| `submit_review` | Separate explicitly approved action with truthful AI declaration and exact chapter receipt. Not approval or public publication. |
| `publishChapter` | Always false: no direct public publishing or guaranteed approval. |
| MV3 extension | Local single-user pairing/capability inspection/revocation only; no account verification or remote business writes. See [extension guide](platform-extension.md). |
| Automation | Explicit local auto-approval or separately persisted workflow continuation; neither bypasses safety checks. |
| Unknown outcomes | Exact-ID read-only reconciliation; insufficient proof stays unknown, never blind resend. |

No CAPTCHA/risk-control/review bypass, automatic acceptance of extra declarations, permanent-session guarantee or unattended scheduled publishing is provided.

## Safe workflow

1. Create books and volumes in the official dashboard. Open platform overview → Fanqie.
2. Follow verify account → bind book → select chapters → preview/approve → results. Prerequisites block writes; results remain visible after session expiry.
3. Manually log in and click verification. Confirm live author ID/name; a browser window or cached cookie is not proof. Read works and explicitly bind the correct remote ID. New accounts require separate connections/rebinding, not silent account substitution.
4. Select exact account/book/volume, action and 1–50 saved canonical chapters. Chapters execute sequentially by number. Review requires `useAi=1` (yes) or `useAi=2` (no), never an inferred default.
5. Prepare a complete read-only preview. Inspect title, full body, local version, remote IDs and planned create/reuse/overwrite fingerprints. Approve/start explicitly unless local auto-approval was deliberately enabled. Changed remote drafts invalidate overwrite approval; ambiguous, published or reviewing chapters are not forcibly overwritten.
6. Inspect full read-back and exact receipts. HTTP success, an opened page or clicking a website confirmation button is not proof of a public publication.

The split chapter number/title editor accepts `第1章 标题` and `第 1 章 标题` with matching local numbers. It does not remove body title paragraphs or relax full-text verification. Paragraph serialization preserves intended empty paragraphs/newlines; a local Chromium regression does not diagnose every live mismatch.

## Sessions and automation

Continuing login/reverification for an explicitly selected connection reuses its visible Chromium context if this backend still owns it; duplicate pending-login requests reuse their window too. New connections open separate contexts. Never infer the account from there being only one window; backend restart cannot adopt orphaned or personal browsers.

Securely inject a fixed `PLATFORM_SECRETS_KEY` before startup for encrypted session persistence. Without it, sessions remain in memory and require login after restart. The manual login window no longer expires after 15 minutes. After explicit verification, the same visible Chromium remains open. Every five minutes after the last cycle settles, read-only author-home navigation verifies identity and saves website-managed cookies/localStorage; tokens are never returned to the UI. Busy project/account/workflow operations skip the cycle rather than interrupt uploads. Closing the window never reopens it; disconnect, project deletion and shutdown clean up timers, and restart does not launch windows. Unverified login still holds a provider-wide lock until verification or closure, so do not leave it unattended. Identity changes or verification prompts stop renewal; temporary network failures preserve old credentials. Real updated cookies/localStorage are also synchronized after verified operations; no invented dual-token refresh endpoint is used. Renewal does not guarantee an indefinitely valid session. Retain the original encryption key privately. Expiry, revocation and CAPTCHA still require human login.

Local auto-approval is off by default and browser/project-local (`publication-auto-approve:<projectId>`). It authorizes prepare to approve/start while retaining snapshot hashes and approval provenance. It is not Fanqie's editorial approval.

Workflow continuation is independently stored per workflow. Select automatic generation, explicitly save account binding, volume, action and required AI declaration. Only complete successful live runs with reviewed, hard-validated and saved/adopted canonical chapters from that run continue. Demo, single-node, canceled/failed/incomplete, conflicting or unadopted outputs never upload. No target is inferred from having a single account. Restart never replays uncertain continuation.

## Automatic verification

New previews with explicit `autoApprove:true` (auto-approval or automatic workflow continuation) enable automatic verification. Automatically approving an older manual preview does not rewrite its immutable mode.

- New drafts wait for an exact book/editor URL and approved author, durably recording the chapter ID before filling/saving. No title-based ID guesses.
- An execution exception with a pinned exact chapter ID permits at most one read-only reconciliation under the existing account lock. Identity, book, volume, historical title, full body/paragraphs and any required review receipt must match. Durable proof is required before continuing queued chapters; the failed write is never retried.
- Missing identity, mismatches, CAPTCHA, unknown dialogs or unproven results still stop. No automatic acceptance of extra declarations or clearing staging.
- Manual mode is unchanged. Existing unknown batches are not replayed; manually requested reconciliation still pauses remaining work for explicit resumption.

## Status and recovery

An open page periodically synchronizes local connections, draft receipts and queue records, including on window focus. This never reads remote works, reconciles drafts or resends content on a timer, and does not clear pending choices, approvals or explicit action errors. Author identity readiness alone is not proof that the asynchronous remote works list has loaded; unavailable or incomplete list evidence must not be reported as a missing work.

| Status | Required response |
| --- | --- |
| Preview | Check full content; expired or changed versions require a new preview. |
| Queued/running | Do not duplicate; pause stops after current in-flight chapter. |
| Draft verified | Saved/read back, not public. |
| Submitted for review | Matching receipt, not approved. |
| Pre-write failure | Repair account, volume, version or content before preparing a new safe operation. |
| Unknown | Refresh local status and use read-only reconciliation, not a replacement batch. |
| Missing exact chapter ID | Obtain it from that chapter's official edit link, not work ID/title guesses; otherwise retain unknown. |
| Login/CAPTCHA/extra declaration | Human handling; auto-approval cannot bypass it. |

Reconciliation matches account, book, volume, historical title/full body and required review receipt. An empty list or missing chapter is not permission to resend. After manually requested reconciliation succeeds, remaining chapters pause for explicit resumption. Only the explicit automatic-preview path above may continue remaining chapters after successful in-execution read-only verification and durable proof. Restart interruptions require manual read-only reconciliation first.

Hiding inactive records is browser display-only; server audit/idempotency/unknown blocking remain. Advanced backup-and-clear removes project-local previews/operations/receipts/all batches, including hidden records, and can allow duplicates. Verify official state and confirm the risk first. Neither deletes local canonical chapters or remote text; clearing does not remove bindings or resend.

## Developer contract and acceptance

Batch base: `/api/projects/:projectId/platform-publication-batches`; operations: `GET /`, `GET /volumes`, `POST /prepare`, `POST /:batchId/start`, `/resume`, `/pause`, `/reconcile`. `prepare` can explicitly carry `autoApprove:true`. Start still needs the exact preview hash and authorization. Project, origin and CSRF checks apply; old endpoints are not approval bypasses.

Implementation references: [browser adapter](../../packages/server/src/features/platforms/fanqie-browser.ts), [runtime](../../packages/server/src/features/platforms/platform-runtime.ts), [queue](../../packages/server/src/features/platforms/publication-queue.ts), [routes](../../packages/server/src/features/platforms/platform-routes.ts), [continuation](../../packages/server/src/features/workflow/workflow-publication.ts), [manual chapters](../../packages/server/src/features/chapters/manual-chapters.ts).

Tests use temporary data, local APIs and Chromium, not real-account writes. Historical user feedback reported successful identity/work reads and draft upload; that is not current external acceptance for automated review submission or full workflow continuation. Real targets and changing website DOM require author-supervised verification.
