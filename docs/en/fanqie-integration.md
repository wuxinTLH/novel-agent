# Fanqie integration

[中文原文](../番茄平台接入.md) · [English index](README.md) · [Step-by-step user guide](user-guide.md#fanqie-publication)

This describes v0.0.2a implementation boundaries. Playwright operates an isolated Chromium author session, not an official Fanqie API. Initial login requires an interactive desktop on the backend host. Install with `npm ci` and `npm run browser:install`; start with `npm run dev`, or build and start production normally.

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

Securely inject a fixed `PLATFORM_SECRETS_KEY` before startup for encrypted session persistence. Without it, sessions remain in memory and require login after restart. Real updated cookies/localStorage are synchronized after verified operations; no invented dual-token refresh endpoint is used. Retain the original encryption key privately. Expiry, revocation and CAPTCHA still require human login.

Local auto-approval is off by default and browser/project-local (`publication-auto-approve:<projectId>`). It authorizes prepare to approve/start while retaining snapshot hashes and approval provenance. It is not Fanqie's editorial approval.

Workflow continuation is independently stored per workflow. Select automatic generation, explicitly save account binding, volume, action and required AI declaration. Only complete successful live runs with reviewed, hard-validated and saved/adopted canonical chapters from that run continue. Demo, single-node, canceled/failed/incomplete, conflicting or unadopted outputs never upload. No target is inferred from having a single account. Restart never replays uncertain continuation.

## Status and recovery

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

Reconciliation matches account, book, volume, historical title/full body and required review receipt. An empty list or missing chapter is not permission to resend. When reconciliation succeeds, remaining chapters pause for explicit resumption. Restart interruptions are reconciled first.

Hiding inactive records is browser display-only; server audit/idempotency/unknown blocking remain. Advanced backup-and-clear removes project-local previews/operations/receipts/all batches, including hidden records, and can allow duplicates. Verify official state and confirm the risk first. Neither deletes local canonical chapters or remote text; clearing does not remove bindings or resend.

## Developer contract and acceptance

Batch base: `/api/projects/:projectId/platform-publication-batches`; operations: `GET /`, `GET /volumes`, `POST /prepare`, `POST /:batchId/start`, `/resume`, `/pause`, `/reconcile`. `prepare` can explicitly carry `autoApprove:true`. Start still needs the exact preview hash and authorization. Project, origin and CSRF checks apply; old endpoints are not approval bypasses.

Implementation references: [browser adapter](../../packages/server/src/features/platforms/fanqie-browser.ts), [runtime](../../packages/server/src/features/platforms/platform-runtime.ts), [queue](../../packages/server/src/features/platforms/publication-queue.ts), [routes](../../packages/server/src/features/platforms/platform-routes.ts), [continuation](../../packages/server/src/features/workflow/workflow-publication.ts), [manual chapters](../../packages/server/src/features/chapters/manual-chapters.ts).

Tests use temporary data, local APIs and Chromium, not real-account writes. Historical user feedback reported successful identity/work reads and draft upload; that is not current external acceptance for automated review submission or full workflow continuation. Real targets and changing website DOM require author-supervised verification.
