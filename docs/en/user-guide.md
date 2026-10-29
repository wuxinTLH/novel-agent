# User guide

[中文原文](../使用手册.md) · [English documentation index](README.md) · [English overview](../../README/README_en.md)

This is the operational English counterpart of the Chinese user guide, not a claim of a fully translated UI. UI labels may remain Chinese. Novel Agent v0.0.2a targets a local computer or trusted LAN; authentication is optional and off by default. Do not expose the default service to the public Internet.

## Install and start

Use Node.js 22.16 or newer. Run from the repository root:

```powershell
npm ci
npm run browser:install
npm run dev
```

Development uses UI `http://127.0.0.1:5173` and API `http://127.0.0.1:3001`. For a production build run `npm run build`, then `npm start`, and open `http://127.0.0.1:3001`. Fanqie login requires a visible Chromium window on the backend machine; a LAN browser does not provide remote desktop control.

## Workspace and authoring

- `/workflow`: create, switch, edit, arrange and execute independent workflows. Character and worldbuilding shortcuts create separate workflows. A project must retain at least one workflow; deleting one does not delete chapters or assets.
- `/assets`: manage worldbuilding, characters, plot and chapter reference material.
- `/chapters`: edit saved manuscripts, generate candidates, compare revisions and export.
- `/platforms`: platform overview and the guided Fanqie page.
- `/settings`: model profiles, protocols, credentials, execution mode and optional SQLconnect.

Refresh preserves the route. Unknown routes show a 404 and return after five seconds. Workflow arrangement (layered, horizontal, vertical or grid) changes positions only, not dependencies or execution semantics. Project settings edit title, type, synopsis and a PNG/JPEG/WebP cover up to 4 MiB. Avatars are cropped and stored only in the current browser after server-side file checking.

### Worldbuilding and characters

Create a worldbuilding workflow, enter or expand setting text and optionally name the output. It saves setting prose, not chapter planning, audit commentary or novel chapters. Character workflows save character assets. Character nodes accept name, gender, personality, history, template and an integer count of 1–100. Blank fields may be generated from available material.

### Chapter generation and scheduling

New chapter graphs use **chapter planning → prose generation → consistency review**: three ordinary model calls per chapter, excluding failures, repairs and custom nodes. Existing saved graphs and prompts are not automatically rewritten. Prepare worldbuilding or overall plot in separate setting workflows or add custom nodes deliberately. Conflict, reversal and climax presets, where offered, are optional author-selected additions, not mandatory default stages.

Production node concurrency is configurable from **1 to 8** and defaults to 1 when absent. Only independent eligible branches can overlap; a linear three-node graph remains sequential. Writer/review barriers and chapter commits remain sequential, as do chapter batches. Higher caps may trigger simultaneous paid calls. Prose and setting workflow modes must match; changing mode is not a way to bypass required writer nodes.

1. Configure a real model or explicitly select demo mode.
2. Open target/requirements configuration from workflows or chapters.
3. Choose continuation, one specific chapter or a chapter range; save project/chapter requirements.
4. Run the intended complete workflow. Demo output is a fixed template, not evidence of model quality.
5. In manual mode, regeneration produces a candidate for explicit adoption. Automatic mode adopts only after review, hard text validation and original-revision checks. Failure preserves recovery material and stops the batch.

Select a node to inspect its prompt, associated assets and upstream context. Empty asset selection means all assets. Nodes can inherit the global model or specify one explicitly; a deleted, disabled or unconfigured explicit model causes an error rather than silent fallback. Existing prompts are preserved when presets evolve. Start nodes do not call a model.

### Add chapters without a model

In chapters, choose **添加正文（上传 / 手动编写）**. Enter chapter number, title and body, or select UTF-8 / GB18030 (GBK-compatible) and upload one TXT. Encoding is explicit, not guessed. Limits: 2,000,000 bytes per file, 200,000 body characters, 120 title characters and integer chapter number 1–1,000,000. The body cannot be blank. A filename supplies the initial title only if none is entered. Import strips an initial BOM and normalizes line endings; it neither splits chapters nor removes title paragraphs.

Preview and edit before saving a canonical chapter. Existing numbers conflict rather than overwrite. The same request ID and content are idempotent; reusing an ID with changed content is rejected. Errors preserve input. Check whether the chapter was saved before retrying; do not change chapter numbers blindly. Local save never uploads or submits remotely.

### Export and temporary reading

Export Markdown, DOCX or EPUB from saved canonical chapters in chapter-number order. Unsaved editor text, unadopted candidates and temporary documents are excluded. **准备 PDF 打印** opens a manuscript-specific browser print view; choose Print / Save as PDF and inspect fonts and pagination. It is not server-side PDF generation or a cross-reader layout guarantee.

Temporary reading currently accepts DOCX up to 8 MiB. Convert legacy `.doc` to DOCX yourself. **PDF upload is rejected**, even if an old UI label or historical paragraph mentions PDF reading: reliable PDF content reconstruction is unavailable. There is no OCR or PDF text extraction. DOCX is reconstructed as sanitized text structure; images, links, styling and active content are discarded. It does not import chapters or upload to third parties.

Copies remain in server memory for 30 minutes, disappear on restart, and can be deleted early. Limits: 10 per project, 64 per runtime / 64 MiB, two concurrent processors. DOCX ZIP validation permits 512 entries, 32 MiB actual expansion, 200:1 per-entry ratio and five seconds; conversion permits ten seconds, 4 MiB output and 128 MiB V8 old-space. Heap limits are not OS RSS limits; sanitization is not antivirus. See [file safety](file-sandbox.md).

## Fanqie publication

See the [integration guide](fanqie-integration.md) for status handling and API contracts. This uses Playwright on the official author website, not an official publishing API. Create remote books and volumes in the official dashboard first.

1. Open Fanqie from the platform overview. Follow **verify account → bind book → select chapters → preview and approve → check results**. Results remain accessible if login expires.
2. Open manual login on the backend desktop. Complete passwords, QR codes and CAPTCHA yourself; do not paste tokens or cookies. Click identity verification and confirm the live stable author ID, not merely a cached nickname.
3. Explicitly choose the account, read works and bind the exact remote work. Binding does not upload. Refresh is read-only; unbinding does not delete remote content. To change accounts, use a new connection and explicit rebinding.
4. Read volumes. One volume may be selected automatically; multiple volumes require an explicit choice. New chapters require a volume.
5. Select 1–50 saved canonical chapters, draft or review action, and the exact target. Review requires an explicit truthful AI declaration: `useAi=1` yes, `useAi=2` no.
6. With auto-approval off, prepare complete previews, inspect every title/body/version/account/book/volume/remote ID and overwrite fingerprint, then approve and start. Preparation is read-only. Plans distinguish create, exact reuse and same-ID overwrite of an editable draft. Published/reviewing/ambiguous or changed drafts are not forcibly overwritten.
7. Inspect per-chapter read-back and exact receipts. Saved draft means verified draft, and submitted for review means a matching review receipt—not approval or public publication. Extra declarations, CAPTCHA and unknown confirmation screens require manual handling.

The separate chapter-number/title editor supports `第1章 标题` and `第 1 章 标题` only when the number agrees with the local chapter. It does not rewrite prose to make comparisons pass.

### Two independent automation settings

The platform checkbox enables local auto-approval, off by default and stored per project in this browser as `publication-auto-approve:<projectId>`. Preparation can then approve/start without a second human confirmation, including the single-chapter entry. Account, content, version, duplicate and AI-declaration checks remain.

Workflow continuation is separately persisted per workflow. Choose automatic generation, then explicitly save an enabled publication target containing `linkId`, `volumeId`, `action` and review `useAi`. Merely selecting automatic generation or local auto-approval does not configure continuation. Only a complete successful **live** run with validated canonical chapters from that run can continue. Demo, single-node, failed/canceled/incomplete runs, candidates and revision conflicts do not upload. Manual chapter creation does not trigger continuation. Disabling continuation does not withdraw operations already sent.

### Pause, uncertainty and history

Pause takes effect after the current chapter; it does not roll back in-flight writes. Refresh local status before retrying an interrupted request. Unknown results block sending. Use **只读核对远端结果（不重发）** and exact saved remote IDs; if absent, supply an accurate chapter ID from that chapter's official edit link, never a book ID or a title-based guess. Reconciliation matches account, book, volume, historical full text/title and review receipt. Missing or conflicting evidence stays unknown. Successful reconciliation pauses remaining work for explicit resumption. Restart never automatically replays uploads or continuation.

Hiding inactive history only changes this browser's display; server audit and duplicate protection remain. The separate advanced backup-and-clear action removes local project platform previews, receipts, operations and all batches, including hidden ones, and can permit duplicate uploads. Check the official dashboard first. Neither operation deletes remote prose or canonical local chapters; clearing does not remove bindings or resend content.

Use a fixed securely injected `PLATFORM_SECRETS_KEY` for encrypted sessions across backend restarts. Without it, sessions are in memory only. The application synchronizes actual updated browser cookies/localStorage; it does not invent a token-refresh protocol. Changed/lost keys cannot decrypt old credentials. Expiry and risk controls still require manual login.

## Models and data safety

Multiple model profiles support Chat Completions, Responses API and Anthropic Messages. Supply a valid URL/model/API key for live mode. Profiles persist locally in tenant `models.json` or in explicitly activated SQL; keys remain local, encrypted and never returned to the browser. Existing profiles are not reset to demo. Local/private-network/cloud-metadata model endpoints are rejected. Model parameters, usage estimates and budget preflight are not guarantees of a provider billing cap.

Protect the whole data directory, uploads, browser state and backups. SQLconnect passwords are plaintext, unlike encrypted model keys. Local `auth.key` uses POSIX `0600`, but Windows ACLs need separate care. Business writes require tenant-bound `X-Platform-CSRF`; authentication adds a valid session and `X-CSRF-Token`. One data directory supports one application instance, not distributed generation/publishing safety.

## Authentication and local administration

Stop the service, create a complete backup and use the local CLI. It takes the data lock; pass `--data-dir <PATH>` explicitly for a custom directory. Do not assume the admin CLI inherits service `DATA_DIR` or loads `.env`. Mutations require `--confirm`.

Securely inject `NOVEL_BOOTSTRAP_PASSWORD` (12 or more characters, at most 1024 bytes), never through arguments, screenshots or Git:

```powershell
npm run admin -- bootstrap-admin --username admin --confirm
npm run admin -- enable-auth --owner <UUID> --confirm
```

Record the existing active user's returned owner UUID, not username. Bootstrap creates the first super administrator but does not enable authentication. First login never acquires legacy data automatically. `enable-auth --no-legacy --confirm` is only for a new directory with no legacy business/assets or SQL activation. `assign-legacy --owner <UUID> --confirm` separately assigns legacy ownership without changing authentication; it is not a cross-tenant copy command. Restart after changes. To deliberately disable authentication, stop service and use `disable-auth --allow-public-access --confirm`; this acknowledges unauthenticated exposure, not Internet safety.

When authentication is off, management requires the real socket loopback address, local Host/Origin, cross-site rejection and `X-Admin-CSRF` for writes. LAN business access is not administrative access. Authenticated management follows the [explicit four-role matrix](roles-permissions.md), not weight inheritance. Super administrators cannot browse other tenants' private business content. Password changes/resets, disabling and role changes revoke affected sessions; the last active super administrator is protected. Logout does not cancel already-started work.

Stable verified user IDs select immutable owner runtimes. Legacy data keeps the original directory; others use `DATA_DIR/users/<SHA-256(user UUID)>`. Client-supplied user/owner IDs are not trusted; unauthenticated requests do not fall back to shared data. At most 32 tenant runtimes are supported.

### Optional mail, OIDC, MFA and Turnstile

Every account feature and authentication itself is off by default. Configure SMTP only with `NOVEL_SMTP_ENABLED=true` and securely injected `NOVEL_SMTP_HOST`, `NOVEL_SMTP_USER`, `NOVEL_SMTP_PASSWORD`, `NOVEL_SMTP_FROM`. Port defaults to 587, or 465 with `NOVEL_SMTP_SECURE=true`. Certificate validation stays enabled; explicitly enabled incomplete configuration fails startup.

Administration → System and security → Account feature configuration groups registration, email verification, recovery and MFA switches and expandable OIDC connection/secret fields. Click Save configuration; editing does not save or enable authentication. Blank secret input preserves the saved secret. Registration creates only a writer after mandatory email confirmation, not an auto-login. Single-use mail tokens expire in 15 minutes; links use `/account/complete#purpose=...&token=...`. Password recovery revokes sessions but retains MFA and does not reveal whether an email exists.

OIDC requires explicit HTTPS issuer/client/endpoints/JWKS/callback configuration, code + PKCE S256, state/browser binding, nonce and exact issuer/audience/signature checks. Callback: `/api/auth/account/oidc/callback`. Administrators map exact issuer + subject to an existing user with `PUT /api/admin/account/oidc/users/:id`; no email-based auto-link or registration. TOTP setup requires a current code; ten one-time recovery codes are shown once. Login issues no business session before the second factor. Used counters/codes cannot replay, removing/enabling factors revokes sessions, and global disabling cannot bypass a bound factor.

Mail/OIDC require a separately configured TLS proxy and `NOVEL_TRUSTED_PUBLIC_ORIGIN=https://novel.example.com` replaced with one exact HTTPS origin (no credentials/path/query/fragment/wildcards). Preserve browser Host including port, clear untrusted forwarding headers and block direct external backend access. The app does not trust `X-Forwarded-*` or provide TLS. Authentication cookies become Secure; use HTTPS and align account `publicOrigin`/OIDC redirect. This does not enable authentication or relax local administration. Turnstile additionally requires real keys and matching action/hostname with online server verification. Real SMTP/OIDC/Turnstile/proxy deployments remain independently unaccepted; do not downgrade account schemas without a plan.

## SQL and maintenance

[SQLconnect](../sqlconnect.md) is already an English technical reference. Its saved connection/test/reserved-table initialization is not storage migration or authentication. Create databases yourself, verify TLS (off only on loopback), and protect plaintext credentials. Initialization can partially commit; explicitly repair/retry, not assume transactional DDL.

For v3, prepare trusted `storage-profiles.json` default/multiple profiles and owner mappings. Stop **all** runtimes sharing targets, including other hosts, select a nonexistent external backup destination, and run:

```powershell
npm run maintenance -- migrate-all --owner <UUID> --destination <EXTERNAL_BACKUP> --confirm
```

Append `--data-dir <PATH>` explicitly if needed. Maintenance loads the root `.env`, but `DATA_DIR` does not replace the argument. It backs up first, validates all mappings, imports into empty targets, verifies read-back and activates. Existing SQL activation is not an in-place upgrade path: do not delete manifests. Active SQL errors fail closed, not back to stale JSON. v3 canonical entities/revisions/receipts commit transactionally; credentials/uploads/browser state remain local. Persistent DB pools acknowledge actual COMMIT. Same-tenant synchronous waits and auth-control-plane SQL can still block; owner admission allows independent owners while snapshots/imports/migrations are exclusive. MySQL/SQL Server are simulated-only, and PostgreSQL v2 success is not v3 acceptance.

### Online backup and offline restore

Administration → Backup and maintenance offers three steps: create full backup, validate selected backup, generate offline restore plan. Backup pauses and drains **all tenants and the control plane**, closes Workers/browsers and snapshots under a global barrier; failure to drain refuses the backup. Defaults: queue 8, terminal history 100, artifacts 20. Progress is stage-based, cancellation waits for a safe checkpoint and is unavailable during committing. Restart marks interruptions and never retries automatically.

Managed artifacts live outside data (normally `.data-managed-backups`), not downloadable through the browser. Select a recent backup or enter an existing managed UUID, not a path. Validation/plan checks structure/hashes, not decryptability, business correctness or live DB compatibility; neither executes restore nor connects backed-up source addresses. Protect ACLs, capacity and external keys.

Offline commands:

```powershell
npm run maintenance -- backup --destination <PATH> --confirm
npm run maintenance -- restore --source <PATH> --data-dir <NEW> --confirm
# SQL restore additionally requires explicit trusted target profiles:
npm run maintenance -- restore --source <PATH> --database-config <EXPLICIT_TARGET_PROFILES> --data-dir <NEW> --confirm
```

A full application backup includes safe local binaries/empty directories and all configured v3 repository owners/documents/entities/revisions/receipts, **not a whole database dump**. It excludes `.instance.lock`, `.instance.lock.recovery`, `admin-backups`, `.maintenance-journal.json`, `*.tmp`, `.maintenance-*`; unsafe paths, symbolic/hard links are rejected. Environment-only `MODEL_SECRETS_KEY` / `PLATFORM_SECRETS_KEY` must be saved separately. Legacy version-1 SQL activation is unsupported here: use separate `pg_dump` plus the complete local tree and keys.

Restore requires new/empty files and v3 application targets. SQL target profiles must explicitly cover source IDs/mappings; source database addresses are never trusted. Local rollback copies do not provide atomic cross-database rollback. A failure journal blocks startup: reconcile actual committed states and backups, never just delete the journal. Restore revokes auth sessions and never replays remote publication. There is no scheduled backup or distributed maintenance guarantee.

Legacy `npm run admin -- migrate-sql --owner <UUID> --confirm` remains single-owner PostgreSQL v2, not v3. It requires an existing active identity, planned legacy ownership, no extra tenant layout and an empty owner target. The DB user needs `USAGE, CREATE ON SCHEMA public`; PostgreSQL `42501` requires appropriate minimal grants, not superuser. It stores four document snapshots (`projects`, `models`, platform connections and publication queue), leaves secrets/uploads local and uses blocking per-operation connections. Its partial `admin-backups` is not a full backup. Preserve local tree and database independently; there is no one-click SQL rollback.

## Interface and verification

Language selection (`zh-CN` / `en`) is browser-local under `novel-locale`; coverage remains partial, especially authoring/platform/backend messages. Themes are light, dark, system and blue/pink/white. The separate theme menu reloads registry/CSS; failure preserves the active theme or uses initial light fallback. Hashed CSS/JS/fonts may cache one year; HTML uses `no-cache`. See the [theme guide](../../public/themes/README.md).

Run `npm run typecheck`, `npm test` and `npm run build` for local validation. Tests use temporary directories/stubs, not real paid models or platform accounts. Browser smoke and historic counts are described in the [acceptance record](acceptance-checklist.md); historical results do not prove the present working tree or external services. The [storage report](../../scripts/benchmark-storage-report.md) is simulated, not live SQL performance. Live DB scripts require explicit disposable credentials and opt-in; read their instructions before running. No external acceptance is claimed by this translation.
