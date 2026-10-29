# Feature completion and acceptance record

[中文原文](../功能完善验收清单.md) · [English index](README.md)

This English counterpart separates implemented local behavior, historical test records, design limits and outstanding external acceptance. Historical numbers below are retained from the Chinese record, **not tests rerun by translating this page**, and not evidence for every later working-tree change.

## P1 authoring protections

| Feature | Implementation and limit |
| --- | --- |
| Hard word count | Count Unicode letters/numbers, excluding whitespace/punctuation/emoji; min/max block adoption. Target remains advisory. |
| Review/repair | Structured automatic review, explicit veto, bounded rewrites and re-review. Model judgment is not factual truth; manual mode retains author choice. |
| Long-form context | Retrieve actual earlier prose fragments, retain recent chapters under budget and add global/earlier facts. Text retrieval, not vector semantics; no future chapters. |
| Draft protection | Browser-local persistent drafts scoped by account/project/workflow/chapter, refresh recovery and in-memory fallback on storage failure. No cross-device sync; late save responses must not overwrite continued typing. |
| History | View/compare/CAS restore, new revision preserving pre-restore prose; newest 20 revisions, not unlimited backup. |
| Interrupted runs | Verify original workflow/target snapshots and run only unfinished targets; reject changed configuration/manuscripts. Cannot resume an interrupted upstream network stream or replay saved chapters. |

## P2/P3 implementation

Structured knowledge includes characters/relationships/timeline/foreshadowing/facts, tags and chapter links, CAS editing/deletion and generation context; authors must still verify facts. Asset versions support history/CAS restore, treating old unversioned assets as initial revisions.

Models expose temperature/output tokens/timeouts/context/vision/image count/prices. Capability declarations must be accurate. Usage is identified as actual provider data or estimated; token/cost preflight can reject before requests, but estimates are not provider billing caps. Three protocols support incremental parsing and bounded isolated progress state; demo is not live-provider streaming acceptance.

Workflows support bounded safe ready branches, strict JSON conditions, all/any joins, skip propagation and failure/cancellation protection. **Current production cap is 1–8, default 1**; earlier historical 1–4 limits no longer describe current settings. New chapter graphs have planning → prose → review, not a mandatory worldbuilding/overall-plot call for every chapter. Writers and chapter commits remain serial. Optional conflict/twist/climax/foreshadow nodes are author-selected additions, not required default stages.

Qidian/Qimao remain unavailable pending official interfaces/authorization/test accounts. Real remote work creation/metadata editing remains unimplemented. MV3 is loadable with dual-confirmation pairing/session/revocation/capability UI, but no real account reads/draft writes and no authenticated tenant routing. Mock is explicitly simulated. Database/SMTP/OIDC/real review flows need dedicated external acceptance.

## File safety

Assets, covers, TXT chapters, DOCX and avatars use unified checking/reconstruction. Images decode fully, enforce dimensions and reencode metadata-free PNG. Text is strict decoded; DOCX ZIP paths/expansion/active content are checked then converted to sanitized output. Existing-image downloads and model outbound images sanitize again. PDF is rejected without reliable reconstruction; signatures do not prove safety.

Lease timing/cancellation/timeouts/input-output limits/minimal child environment have local tests. This is application-level processing, **not AppContainer/no-network namespace isolation**. V8 heap limits do not cap native RSS. No absolute safety/antivirus claim exists; hostile deployment requires real OS resource/privilege/network isolation. See [file safety](file-sandbox.md).

## Historical local verification records

The source records successive historical stages, not one consistent current test total:

- Initial complete regression: **484/484**, including simulated platform/browser/local HTTP/tenant/knowledge/rate-limit checks, not real remote success.
- Build/typecheck passed at that stage, with a frontend main-bundle warning above 500 kB.
- Incremental budget/upload failure tests **20/20**, MV3 message permissions **3/3**.
- Isolated browser completion checks **10/10**, with no browser errors/external requests: parameters/demo/draft refresh/history/CAS/facts/scheduling/image reconstruction/dangerous-file rejection/pairing UI, not real platform writes.
- Later gateway/identity integration stage: **495/495** full regression, **22/22** focused gateway/tenant/identity checks, build passed with about **838 kB** main bundle. A first browser rerun exposed an early assertion after async refresh; initialization/waits were corrected before the recorded **10/10** rerun.
- `smoke:auth` historically used disposable deployment/random credentials and normal login/logout to exercise admin/writer project isolation, chapter persistence, old-session/tenant-CSRF rejection, identity-cache clearing and locale persistence across restart. Same-host aliases shared cookies; unchanged identity preserved drafts and changed identity refreshed stale views. No test identity bypass or real data auth mutation was used.

No real platform editorial approval, SQL v3 vendor deployment, SMTP/OIDC/Turnstile or paid-provider acceptance is established by these local records. Do not combine historical v2 PostgreSQL success into v3 proof.

## Subsequent hardening recorded in the source

Scheduling uses editable numeric drafts and submit-time integer validation, with polling preserving unsaved settings (the old recorded 1–4 UI bound is superseded by current 1–8). Model saves lock inputs; pairing distinguishes loading/empty/busy; knowledge inputs are accessible and revision-restore errors stay local. Knowledge PATCH now persists tags/chapter associations after validating links before mutation and returns the new revision.

Rate limiting uses bounded counters: 240 requests/window, at most 4096 clients with expiry, no eviction of active clients to reset quota; 429 includes retry wait. Tenant entry uses the same bounded approach and does not trust forwarded addresses. This is per process, not distributed protection. Gateway startup follows successful backend listen and shutdown has a total deadline.

Dependency hardening recorded `tedious 19.2.2`, `@azure/identity 4.13.0`, `uuid 11.1.1`; the historical npm advisory audit reported zero vulnerabilities including dev dependencies at that time. This does not prove future advisory status or absence of all vulnerabilities.

Gateway aliases are explicitly enabled loopback entrances to one backend, not independent data instances. Both entry and tenant origin policies reject unknown ports/malicious origins/LAN alias Hosts and retain CSRF. Same-host cookies share across ports but localStorage does not. Focus/visibility identity revalidation clears/reloads only on verified identity change; offline errors do not infer anonymous mode and stale responses do not install old identity.

## Outstanding work and acceptance

| Priority | Remaining work |
| --- | --- |
| P1 platforms | Qidian/Qimao formal authorization/APIs/test accounts; remote book creation/metadata editing; real Fanqie review and continuation acceptance. |
| P1 file isolation | AppContainer/no-network namespace/native RSS controls absent; PDF reconstruction, OCR and legacy DOC unsupported. |
| P1 external services | Real v3 three-dialect DB deployments, SMTP/OIDC/MFA/Turnstile and live-provider streaming/usage combinations. |
| P2 scale | Single backend with up to 32 tenant Workers; no distributed owner locks, multi-instance consistency or load balancing; auth SQL can block control plane. |
| P2 extension | Pairing/session/revocation/capabilities only; remote business reads/writes unavailable. |
| P2 backup/storage | No scheduled backup or online restore/migration; no cross-DB atomic rollback; credential ACLs need deployment care. |
| P2 editing/retrieval | Local drafts not synchronized; bounded history, not unlimited backup; textual, not vector retrieval. |
| P3 frontend | Partial localization and large main bundle. |
| P3 reading/gateway | Temporary rather than persistent document library; PDF is browser print export. Gateway buffers bounded HTTP, not SSE/WebSocket; defaults 1 MiB request/16 MiB response/30 seconds may not suit large/long operations. |

This is a scoped record, not a claim that all defects have been discovered.

## Reproduce local checks

```text
npm test
npm run build
node scripts/smoke-completion.mjs
npm run smoke:auth
node --test extensions/platform-bridge/protocol.test.mjs
```

Browser scripts use disposable data/deployments and do not reuse repository secrets or call real models/accounts. Extension protocol tests check permissions/fixed loopback routing; actual popup installation and author-site compatibility still need human acceptance. Always report commands actually run, not historical counts as current results.
