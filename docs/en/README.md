# English documentation index

[中文项目入口](../../README.md) · [English project overview](../../README/README_en.md) · [中文 README](../../README/README_zhCN.md)

Use this index for English operational instructions and technical references. English documentation does **not** mean that the whole UI is translated or that external services have passed acceptance. The default product remains a local/trusted-LAN workbench with optional authentication disabled. Commands run from the repository root unless a guide says otherwise.

## User and operator guides

| English guide | Chinese source / coverage |
| --- | --- |
| [User guide](user-guide.md) | [使用手册](../使用手册.md): installation, all authoring routes, workflow/model/node setup, manual TXT chapters, exports/DOCX reading, publication, identity/account features, migration, backup and recovery. |
| [Fanqie integration](fanqie-integration.md) | [番茄平台接入](../番茄平台接入.md): capability matrix, manual login/binding, approved writes, sessions, automation, uncertainty/reconciliation and APIs. |
| [Services and tenant boundaries](services.md) | [服务说明](../services.md): backend layers, immutable owners, auth, v3 canonical storage, worker/lock limits, documents and maintenance. |
| [Roles and permissions](roles-permissions.md) | [角色权限](../roles-permissions.md): exact four-role weights, complete authorization matrix, compatibility and online/offline boundaries. |
| [SQLconnect and v3 profiles](../sqlconnect.md) | Existing English reference: safe configuration, APIs, reserved DDL, explicit migration, backups, recovery and live-test caveats. No duplicate translation to maintain. |
| [File admission and reconstruction](file-sandbox.md) | [文件沙箱](../文件沙箱.md): input/output limits, rejection, legacy reads, cancellation/leases and absent OS isolation. |
| [Platforms and MV3 extension](platform-extension.md) | [平台扩展](../平台扩展.md): unsupported providers, installation, dual confirmation, bounded bridge protocol and acceptance limits. |
| [Completion and acceptance record](acceptance-checklist.md) | [功能完善验收清单](../功能完善验收清单.md): meaningful feature status, preserved historical counts and explicitly outstanding work. |
| [Theme extensions](../../public/themes/README_en.md) | [中文主题指南](../../public/themes/README.md): registry/CSS lifecycle, deployment and failure behavior. |

English counterparts are substantive maintained guides, not line-by-line copies. When behavior changes, update both language counterparts and keep their bidirectional links. Numeric limits, safety restrictions, commands and unsupported capabilities must stay aligned. Historical test counts remain historical, not refreshed by translation. In particular, temporary PDF uploads are rejected; PDF export remains browser printing.

## Package and component references

Already-English references remain canonical rather than duplicating identical English files.

| Area | English reference |
| --- | --- |
| Server package | [Server README](../../packages/server/README_en.md) |
| Core assembly and tenancy | [Core](../../packages/server/src/core/README.md), [tenancy](../../packages/server/src/core/tenancy/README.md) |
| Server features | [Administration](../../packages/server/src/features/administration/README.md), [assets](../../packages/server/src/features/assets/README.md), [authentication](../../packages/server/src/features/auth/README.md), [chapters](../../packages/server/src/features/chapters/README.md), [documents](../../packages/server/src/features/documents/README.md), [generation routes](../../packages/server/src/features/generation/routes/README.md), [models](../../packages/server/src/features/models/README.md), [platforms](../../packages/server/src/features/platforms/README.md), [projects](../../packages/server/src/features/projects/README.md), [workflow](../../packages/server/src/features/workflow/README.md) |
| Infrastructure | [Database](../../packages/server/src/infrastructure/database/README.md), [security](../../packages/server/src/infrastructure/security/README.md), [SQL assets](../../packages/server/src/infrastructure/storage/sql/README.md) |
| Web package | [Web README](../../packages/web/README_en.md) |
| Web components | [Administration](../../packages/web/src/components/administration/README_en.md), [projects](../../packages/web/src/components/projects/README.md), [localization](../../packages/web/src/locals/README.md) |

## Shared contracts and reports

- [Workflow scheduler integration](../../shared/workflow-scheduler.integration.md): existing English shared/runtime contract, production concurrency 1–8 (default 1), branch/join semantics, writer barriers and verification scope. The new default chapter graph has three nodes, not concurrency 3. Conflict/twist/climax/foreshadow presets are optional.
- [Storage admission benchmark](../../scripts/benchmark-storage-report.md): existing English **historical SIMULATED** measurements, original numbers retained. No real SQL/network/disk performance claim; live PostgreSQL v3 acceptance was skipped without credentials/opt-in.
- [English unreleased changelog summary](../../CHANGELOG.md#english-unreleased-summary): current feature themes and explicit validation boundaries. Chinese historical release entries remain intact rather than being presented as newly verified results.

## Current delivery and navigation changes

The [deployment guide](user-guide.md#separate-builds-and-same-origin-deployment) covers independent `build:web` / `build:server`, default integrated hosting, API-only `SERVE_WEB=false`, trusted `WEB_DIST_DIR`, and same-origin `/api` / `/uploads` reverse proxying without new business CORS or relaxed CSRF. Static hosts need their own SPA fallback and equivalent CSP/security headers. The [authoring guide](user-guide.md#knowledge-facts-and-node-picker-views) covers browser-local node-picker views, the independent `/assets/knowledge` page and discard confirmations; the [acceptance record](acceptance-checklist.md#separate-delivery-knowledge-page-and-http-hardening-increment) separates focused HTTP fixes from historical totals and still-open external/OS-isolation work.

## Inventory and maintenance policy

The initial Git-tracked Markdown inventory contained **35 files**: three root/language READMEs, changelog, eight guides in docs, 20 package READMEs, the theme README, one benchmark report and one shared scheduler guide. Chinese-first documents receive a sibling English file or an English counterpart here; existing substantial English documents are indexed rather than duplicated. The changelog receives a meaningful English unreleased summary rather than translating all historical entries. New English files join the inventory once staged/committed; the working-tree inventory must include them when checking coverage.

No source code is changed by this documentation pass. Existing Chinese content and concurrent changes are preserved except explicit corrections of stale current-behavior claims. No commit/push or live platform/database/model acceptance is implied. For current validation, run the documented local checks on your actual tree and separately arrange authorized real-service acceptance.
