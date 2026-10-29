# Novel Agent

Language / 语言: [简体中文 (default)](README_zhCN.md) · [English](README_en.md) · [Root README](../README.md)

A novel-writing workbench for a local computer or trusted LAN, version `v0.0.2a`. It supports multiple projects and workflows, worldbuilding, character generation, chapter editing and generation, reference assets, model profiles, themes, and persistent data. The default remains single-user access without login. Authentication and tenant isolation require explicit local administration. **This is not a production deployment solution for the public Internet.**

## Quick start

Use Node.js **22.16 or newer**, and run commands from the repository root:

```powershell
npm ci
npm run browser:install
npm run dev
```

Development UI: `http://127.0.0.1:5173`; API: `http://127.0.0.1:3001`.

For a production build:

```powershell
npm run build
npm start
```

The production UI is served at `http://127.0.0.1:3001` by default. The service listens on local and LAN interfaces; restrict access to a trusted LAN and do not expose it directly to the Internet. Fanqie login requires an interactive desktop on the machine running the backend to operate the isolated Chromium window; a headless remote server cannot complete the first manual login.

For optional local aliases, enable the loopback gateway explicitly. This keeps one backend process, one tenant Worker owner, and one data-directory lock:

```powershell
$env:GATEWAY_ENABLED='true'
$env:GATEWAY_PORTS='5173,5174,5175'
$env:GATEWAY_TARGET='http://127.0.0.1:3001'
npm start
```

The gateway binds only to `127.0.0.1`, permits only an HTTP loopback target, and preserves methods, paths, cookies, Origins, and statuses. Configured aliases are explicitly admitted by both the entry and tenant Worker origin policies without trusting forwarding headers. Defaults: 1 MiB requests, 16 MiB responses, 32 concurrent requests, 30-second total deadline. It buffers bounded exchanges, does not relay SSE/WebSockets, and never retries writes. Development mode still uses Vite `5173` and API `3001`; avoid port conflicts.

Aliases are entrances to the same application, not separate users or data instances. Cookies on the same host are shared across ports. Use real logout/login to switch authenticated users; focus/visibility revalidation checks server identity and clears/reloads stale UI only when identity changes, preserving drafts for unchanged sessions. Run `npm run build` then `npm run smoke:auth` for disposable identity tests; do not change authentication on a real data directory.

## Documentation

Use the [English documentation index](../docs/en/README.md) for all guides, package/component references and historical reports. Chinese-first guides now have maintained English counterparts; already-English technical references are kept canonical rather than duplicated:

- [Complete user guide](../docs/en/user-guide.md): setup, chapters, authentication, publication queues, and maintenance.
- [Fanqie integration](../docs/en/fanqie-integration.md): supported operations and troubleshooting.
- [Services and tenant boundaries](../docs/en/services.md).
- [Roles and permissions](../docs/en/roles-permissions.md).
- [SQLconnect and storage profiles](../docs/sqlconnect.md).
- [Theme extensions](../public/themes/README_en.md).
- [Feature completion and acceptance record](../docs/en/acceptance-checklist.md).
- [File admission and safety](../docs/en/file-sandbox.md).
- [Platforms and MV3 extension](../docs/en/platform-extension.md).
- [English unreleased changelog summary](../CHANGELOG.md#english-unreleased-summary).

## Main features

### Projects, workflows, and writing

- `/workflow`: create and switch independent chapter, worldbuilding, character, or blank workflows. Arrange nodes in layered, horizontal, vertical, or grid layouts without changing execution semantics.
- `/assets`: manage worldbuilding, characters, plot, and chapter reference material. Worldbuilding workflows save setting text, not novel chapters.
- `/chapters`: edit, generate, compare, and export chapters. Manually add one chapter or import TXT as UTF-8 or GB18030/GBK; limits are 2,000,000 bytes per file and 200,000 characters per chapter. Existing chapter numbers are not overwritten. Saving locally does not upload or submit anything remotely.
- New chapter workflows use **planning → prose generation → consistency review**, normally three model calls per chapter (excluding failures/repairs/custom nodes), without rewriting saved graphs/prompts. Production node concurrency is 1–8, default 1: independent safe branches may overlap, but linear dependencies, writer/review barriers and chapter commits remain sequential. Optional conflict, twist, climax and foreshadow nodes are author-selected additions, not mandatory default stages.
- Workflow nodes can use the global model or an explicit model. Missing, disabled, or deleted explicit models require configuration repair rather than a silent fallback. Character nodes support templates and a count of 1–100.
- Manual regeneration produces a candidate that must be adopted explicitly. Automatic mode may adopt the result only after review, hard validation, and original-version checks; failure stops the batch and preserves recovery material.

### Models

`/settings` provides multiple model profiles and supports Chat Completions, Responses API, and Anthropic Messages. Configure a valid base URL, model ID, and API key before live generation. Demo mode produces fixed templates and is not a measure of model quality. Existing model profiles are not reset to demo on every restart. Model API keys are encrypted, never returned to the browser, and not embedded in project content; endpoints targeting local, private-network, or cloud metadata addresses are blocked.

### Fanqie publication

The integration uses Playwright against the author website, not an official Fanqie API. Create the remote book and volumes in the official dashboard first. In `/platforms`, follow **verify account → bind book → select chapters → preview and approve → check results**. Login, passwords, QR codes, and CAPTCHA remain manual; do not paste cookies or tokens into the app.

The queue supports draft creation, exact draft reuse or same-ID overwrite, read-back verification, and review submission, with 1–50 chapters per batch. Review submission requires an explicit AI-use declaration. **Submitted for review does not mean approved or publicly published.** Risk controls, extra declarations, and unknown confirmation pages require manual handling.

Local auto-approval is off by default and is a per-project browser preference. Workflow publication continuation is a separate persistent workflow setting: select the exact account binding, volume, draft/review action, and required AI declaration. Only a successful complete live workflow with validated, saved chapters can continue automatically; demo, single-node, failed, canceled, conflicting, and incomplete runs do not upload. Neither setting disables account, content, version, or idempotency checks.

For unknown remote results, use read-only reconciliation, not blind retries. An exact remote chapter ID may be supplied from that chapter's official edit link; the account, book, volume, title, full text, and any review receipt must match. Unproven results remain unknown. Restart does not replay publication operations. Hiding local history does not remove server-side duplicate protection; the separate advanced backup-and-clear action can permit duplicate uploads and must be used with care.

A fixed, securely supplied `PLATFORM_SECRETS_KEY` is required to retain encrypted platform sessions across backend restarts. Without it, sessions remain in memory. Saved sessions can still expire and require manual login; the app does not invent a token-refresh API.

### Export and temporary reading

Export saved canonical chapters as Markdown, DOCX, or EPUB. Unsaved editor text and unadopted candidates are excluded. PDF uses a dedicated browser print view / Save as PDF, not server-side PDF generation; check fonts and pagination manually.

Temporary DOCX reading accepts a single file up to 8 MiB; legacy `.doc` must be converted to DOCX first. Copies remain only in backend memory for 30 minutes and disappear on restart; they are not imported into chapters or uploaded to a third party. Limits include 10 documents per project, 64 documents / 64 MiB per process, and two concurrent conversions. DOCX content is sanitized and resource-limited. **PDF uploads are currently rejected** because reliable PDF content reconstruction is unavailable; header/trailer checks do not admit original files. OCR and text extraction are unavailable. Browser print / Save as PDF export remains supported. See [document-module boundaries](../packages/server/src/features/documents/README.md) and [file safety boundaries](../docs/文件沙箱.md).

## Interface language and account settings

The default locale is Simplified Chinese (`zh-CN`). Use the global toolbar **LanguageSwitcher** to select English (`en`). The choice is stored in the current browser's localStorage under `novel-locale`, not synchronized as an account preference. Frontend translations live in `packages/web/src/locals/`.

**English coverage is partial:** account feature configuration, the toolbar, and selected administration/navigation labels. Authoring, platform screens, and backend responses are not fully translated, so English mode can still contain Chinese. The existence of this English README does not imply complete English UI support.

In administration, open **System and security → Account feature configuration** (AccountAdminSettings). Registration, email verification, password recovery, and MFA appear as grouped switches with descriptions and an enabled count. The separate OIDC switch has expandable connection/secret details. Switch cards and OIDC fields use a responsive two-column grid on wide screens and one column on narrow screens. Changes require **Save configuration**; blank client-secret input preserves the stored secret, which is never returned in plaintext. These settings do not enable the independent authentication master switch.

Themes include light, dark, system-following, and blue/pink/white. The separate theme menu is next to the language menu and supports keyboard selection; theme choice is browser-local. Blue/pink/white uses a soft full-page gradient with white reading cards, high-contrast dark blue/pink controls and visible keyboard focus. The menu can reload the independent CSS registry. Failed loads preserve the current theme, with a light fallback on first load; custom images and other themes are not recolored. See the [English theme extension guide](../public/themes/README_en.md).

## Optional authentication and account capabilities

Authentication, registration, email verification, password recovery, OIDC, MFA, and Turnstile are off by default. Stop the service and back up data before local administrative CLI changes. Supply `NOVEL_BOOTSTRAP_PASSWORD` securely through the environment (at least 12 characters, at most 1024 bytes); never put a real password in command arguments, documentation, logs, or Git:

```powershell
npm run admin -- bootstrap-admin --username admin --confirm
npm run admin -- enable-auth --owner <UUID> --confirm
```

The first command creates the initial super administrator locally, with no HTTP bootstrap endpoint; it does not enable authentication. Use its returned `ownerId` UUID explicitly when assigning existing data and enabling authentication. First login never automatically takes ownership of old data. `enable-auth --no-legacy --confirm` is only for a new directory without legacy business data/assets or SQL activation. Restart after changes. For custom data directories, pass `--data-dir <PATH>` explicitly; do not assume the admin CLI uses `DATA_DIR` or loads `.env`.

When authentication is off, administrative access requires a real loopback socket and local Host/Origin checks, plus administrative CSRF for writes. LAN access without login does not grant administrator privileges. When enabled, access follows role/module permissions: super administrator, administrator, operations administrator, and writer are distinct roles, not a simple inherited privilege hierarchy. See [exact permissions and legacy-role compatibility](../docs/roles-permissions.md).

Optional account extensions require explicit configuration:

- SMTP is enabled only with `NOVEL_SMTP_ENABLED=true` and securely supplied `NOVEL_SMTP_HOST`, `NOVEL_SMTP_USER`, `NOVEL_SMTP_PASSWORD`, and `NOVEL_SMTP_FROM`. Port defaults to 587, or 465 with `NOVEL_SMTP_SECURE=true`. TLS certificate validation remains on; explicitly enabled but incomplete configuration fails startup.
- Public registration creates only a normal user after mandatory email confirmation, without automatically logging in. Single-use mail tokens expire after 15 minutes. Password recovery revokes sessions but does not remove MFA. Never share completion links or screenshots containing tokens.
- OIDC requires explicit issuer, clientId, authorization/token/JWKS endpoints, HTTPS redirect URI, and optional clientSecret. The callback is `/api/auth/account/oidc/callback`. The provider must support authorization code + PKCE S256; state, nonce, JWKS signature, and exact issuer/audience checks apply. An administrator must map the exact issuer + subject to an existing user separately. There is no email-based auto-linking or automatic registration.
- MFA uses TOTP and 10 one-time recovery codes shown only once. A business session is issued only after the second factor. Used counters/codes cannot be replayed; enabling/removing MFA revokes old sessions, and a bound factor cannot be bypassed by disabling the global MFA switch.
- Turnstile requires real site/secret keys, matching action/hostname, and successful server-side online verification. It is not a substitute for deployment security.

For mail links and OIDC, provide your own TLS reverse proxy and set `NOVEL_TRUSTED_PUBLIC_ORIGIN=https://novel.example.com` to your real single HTTPS origin (no credentials, path, query, fragment, or wildcard). Preserve the browser Host including a non-default port, clear untrusted forwarding headers, and prevent external direct access to the backend. The service does not trust `X-Forwarded-*` or provide TLS itself. This setting enables Secure authentication cookies: use the HTTPS entry, align account `publicOrigin` and OIDC `redirectUri`, and do not continue HTTP login. It neither enables authentication nor relaxes local administration checks.

Real SMTP, OIDC providers, Turnstile, and HTTPS/cookie/proxy deployments still require independent acceptance testing. Do not downgrade to an older schema after configuring account extensions without a migration plan. See [authentication configuration](../packages/server/src/features/auth/README.md).

## Data, SQL migration, and backup

### Storage and security boundaries

Local JSON in `data/` is the default. SQL activation moves supported business documents and canonical project/chapter/asset/workflow entities to the configured v3 profiles; uploads, model/platform credentials, encryption keys, and browser profiles remain local. Do not commit data or secrets.

- Model API keys are encrypted, but SQLconnect database passwords in `sqlconnect.json` are **plaintext**. Protect OS accounts, directories, Windows ACLs, and backups.
- Local `auth.key` is created/tightened to `0600`; Windows ACLs still require separate configuration. Keep required encryption keys safe.
- Business writes require tenant-bound `X-Platform-CSRF`; authenticated mode additionally requires a valid session and `X-CSRF-Token`. Login does not remove existing origin/private-network HTTP restrictions.
- Only one instance may use a data directory. SQL locks/CAS do not provide distributed runtime leases. The single-instance control plane coordinates verified platform-account locks across tenants, but cannot coordinate other hosts, official dashboards, or other apps.
- v3 workers reuse connection pools and acknowledge actual COMMIT. Ordinary storage admission is per owner; snapshots/import/migration are exclusive. Same-tenant synchronous waits and authentication-control-plane SQL can still block within bounds. At most 32 tenant runtimes are supported; this is not a multi-instance deployment promise.

### Explicit v3 migration

SQLconnect connection testing and reserved-table initialization do **not** migrate business data or enable authentication. Configure trusted `storage-profiles.json` profiles and owner mappings, create the target database yourself, and stop every runtime sharing the target. See [profile configuration](../docs/sqlconnect.md#v3-storage-profiles).

```powershell
npm run maintenance -- migrate-all --owner <UUID> --destination <EXTERNAL_BACKUP> --confirm
```

The owner must be explicit. The backup destination must be outside the data directory and not already exist. The command locks, creates a complete application backup, validates all tenant mappings, imports into empty targets, verifies read-back, and activates storage; it is not an online automatic switch. For custom directories add `--data-dir <PATH>`. The maintenance CLI loads root `.env`, but `DATA_DIR` does not replace the explicit directory argument. Activated SQL failures fail closed rather than falling back to stale JSON; connection maintenance is offline.

MySQL, PostgreSQL, and SQL Server adapters exist, but **MySQL/SQL Server have only simulated validation**. Real PostgreSQL v2 acceptance does not prove v3 compatibility; v3 live acceptance remains outstanding. The old `npm run admin -- migrate-sql --owner <UUID> --confirm` is legacy single-owner PostgreSQL v2, not the v3 migration. Existing SQL activation is not an in-place upgrade path; do not delete activation manifests to force migration. See [migration procedure](../docs/使用手册.md#全量迁移到-v3-关系存储).

### Backup and restore

Administration can queue full-application backups, integrity checks by managed backup ID, and offline restore plans. Backup temporarily blocks and drains **all tenants and the control plane**, closes workers/browsers, snapshots under a quiescence barrier, then resumes admission; it fails if safe draining cannot be achieved. Progress is by stage, not bytes. Queue/history/artifact defaults are 8/100/20; restart interruptions are not retried automatically. Managed backups are sensitive and stored outside the data directory (normally `.data-managed-backups`), without browser downloads or arbitrary path input.

Actual restore and migration remain offline CLI operations:

```powershell
npm run maintenance -- backup --destination <PATH> --confirm
# Local-only backup: no database-config needed
npm run maintenance -- restore --source <PATH> --data-dir <NEW> --confirm
# SQL backup: explicitly supply trusted target profiles
npm run maintenance -- restore --source <PATH> --database-config <EXPLICIT_TARGET_PROFILES> --data-dir <NEW> --confirm
```

Stop all relevant runtimes first. Backups contain the safe local tree, binaries/empty directories, and application repository owners/documents/entities/revisions/receipts across configured v3 profiles; **not a full database dump**. Locks, temporary files, old admin-backups, and maintenance artifacts are excluded. Environment-only `MODEL_SECRETS_KEY` / `PLATFORM_SECRETS_KEY` are not included: preserve them independently. Legacy version-1 SQL activation is unsupported by this backup tool and requires a separate `pg_dump` plus local-directory/key backup.

Restore rejects nonempty local/application-database targets by default and uses explicit target profiles, not source addresses from the backup. File rollback copies do not guarantee atomic cross-database rollback. A failure journal `.maintenance-journal.json` blocks startup until an operator safely reconciles persistent state; do not just delete it and retry. Restore revokes authentication sessions and does not replay remote publication. Integrity checks and restore plans do not prove decryptability, business correctness, or database compatibility. See [full backup/restore boundaries](../docs/使用手册.md#全量应用备份与恢复).

## Verification

```powershell
npm run typecheck
npm test
npm run build
```

Tests use temporary directories and local stubs, not real models or platform accounts. After building, `npm run smoke`, `npm run smoke:auth`, and `node scripts/smoke-administration.mjs` provide browser checks of their documented local flows; they do not prove real database, Cloudflare, SMTP/OIDC, or platform publication acceptance.

Real database scripts require explicit safe environment configuration and can write test data/create databases. Read the [Chinese validation notes](README_zhCN.md#验证) before running them. The [storage benchmark report](../scripts/benchmark-storage-report.md) is **SIMULATED** admission testing without real SQL/network/disk I/O, not a production database performance claim.

## Repository layout

The npm workspaces are `space.syjx.agent.novel.web` and `space.syjx.agent.novel.server`. Existing root commands remain supported.

```text
packages/web/src/app/             Pages and route assembly
packages/web/src/components/      Feature-organized UI components
packages/web/src/hooks/           Writing/workflow/platform logic
packages/web/src/locals/          Partial frontend localization
packages/web/src/services/        Browser API clients
packages/server/src/core/         HTTP, assembly, locking, tenancy
packages/server/src/features/     Business services and tests
packages/server/src/infrastructure/ Database/storage/security
shared/                           Shared types, validation, presets
public/themes/                    Independent theme CSS/registry
scripts/                          Build resources and acceptance checks
```

See the [web package](../packages/web/README_en.md) and [server package](../packages/server/README_en.md). Builds still produce root `dist/` (web) and `build/` (server/shared), copying SQL resources automatically; the production entry is `build/packages/server/src/index.js`. Default data remains root `data/`, and root `.env` discovery is independent of the workspace command's current directory.
