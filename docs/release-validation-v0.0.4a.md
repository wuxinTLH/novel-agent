# v0.0.4a 验证记录 / Validation record

Release tag `v0.0.4a`, package version `0.0.4-a`. This record covers the release working tree since `v0.0.3a`; historical reports are not substituted for current results.

## 环境与隔离 / Environment and isolation

- Windows, Node.js 24.22.2, npm workspaces, root lockfile.
- Unit/integration tests use synthetic fixtures, isolated temporary storage and mocked external providers. Browser acceptance runs built production output on ephemeral loopback ports, fresh application-owned browser contexts and temporary data directories.
- Older smoke scripts are run from a copied deployment root with an environment allowlist, excluding the checkout's real configuration, database credentials and live data. No real model, SMS, mail or platform write is part of this release regression.
- Real business data, platform sessions, local memory, screenshots, test receipts and credentials are not release inputs.

## 验证状态 / Verification status

Final serialized full suite: **659/659 passed**, no skipped or cancelled tests (Node.js 24.22.2, `TEST_CONCURRENCY=1`). Earlier intermittent startup failures are retained below; a successful repeat is not proof that their cause was fixed.

Completed checks:

- Full TypeScript check and both production builds passed. Vite reports the existing Zod annotation and large-chunk warnings; these are not hidden or treated as performance certification.
- Official npm registry audit: **0 vulnerabilities**, 443 dependency entries. The configured mirror rejected the advisory endpoint with HTTP 405; the audit was rerun against `https://registry.npmjs.org`.
- `docker compose config --quiet` passed. Docker Desktop's Linux engine is unavailable: **no Docker image build or container runtime acceptance**.
- Chapter browser acceptance passed default-off bulk mode, pagination, current-page/cross-page selections, cancel/confirm, CAS conflicts, unsaved-draft protection, reload, picker reveal and a visually inspected 390px layout. Header actions additionally check text fitting and pairwise non-overlap.
- Final serialized production browser/API acceptance: **12/12 passed** — world stages, locale/account, local platform-state polling, chapter catalog, authentication, deployment mode, workflow completion, project library, administration UI, documents/maintenance, legacy administration and the main end-to-end workflow. Each script used copied output/fixtures with temporary data and restricted environment; no real external service write was permitted.
- Document acceptance verifies canonical DOCX/EPUB exports, script-disabled print preview, PDF-upload fail-closed behavior, maintenance backup/integrity and unchanged authentication.
- Compiled production SQL-worker bootstrap/close passed three consecutive offline attempts under the same 5-second bound (390 / 382 / 360 ms), without issuing database operations. This does not validate database connectivity or erase the intermittent TypeScript-source bootstrap caveat.
- Documentation audit: 51 Markdown files and 437 local file links, zero missing targets; heading anchors were not comprehensively checked.
- Release filename/credential-marker checks and `git diff --check` passed at the pre-publication checkpoint; final staged checks are required again.

## 回归发现 / Issues found during verification

- Concurrent tenant first-start directory creation had a check/create race. The fix tolerates only `EEXIST`, then validates every ancestor with `lstat`; symlinks and non-directories still fail closed. Four deterministic directory-boundary tests were added.
- The real TypeScript database-worker bootstrap test intermittently exceeded its explicit 5-second deadline: the first full suite was 658/659, and the initial standalone and uncached standalone runs were 6/7. The same unchanged source then passed seven consecutive uncached standalone runs (startup 516–607 ms) and a default standalone run (420 ms); real-only probes also passed. No loader exception or root cause was established. No timeout increase, skipped assertion or speculative production fix was applied. This remains a known source-runtime startup/test reliability caveat, not a claimed remediation; final suite results below do not erase the earlier failures. Production transaction timeout, poisoning and no-retry protections remain unchanged.
- A parallel full-suite repeat was 658/659 with a different failure: the workflow API fixture did not become ready within its existing six-second startup window. The SQL-worker test passed in that repeat. Concurrent acceptance also saw one 15-second server-start failure. Runs were subsequently serialized to eliminate overlapping browser/build load; host-load causation is plausible, not proven. No readiness deadline was increased.
- Main workflow smoke now waits for the browser save acknowledgement and clean editor status, not just the server's committed revision, before reload. The older sequence could recover a still-dirty local draft and correctly disable regeneration; dirty-draft guards were not weakened.
- Stale smoke assumptions were corrected to match current UI navigation, the three-node chapter preset and the intentional rejection of original PDFs. Optional Google Fonts stylesheet CSP failures are reported separately; other browser errors remain failures. Application CSP was not relaxed.
- Visual inspection caught overlapping mobile chapter actions despite an initial no-overflow pass. The scoped responsive layout and explicit no-overlap/text-fitting assertions now cover that regression.

## 明确不覆盖 / Explicit limitations

- No fresh real paid-model generation, Fanqie upload/review/publication, SMS delivery, SMTP/OIDC/Turnstile, public TLS/proxy or vendor SQL acceptance is claimed by this run. Earlier interactive tests do not certify this release.
- MySQL/SQL Server simulated tests and historical PostgreSQL evidence are not current vendor-database acceptance.
- Browser fixtures are synthetic and do not prove remote platform DOM stability. Unknown remote results remain protected from blind resend; local chapter deletion never deletes remote drafts.
- Single-instance/non-HA, same-origin HTTPS server deployment, authentication/CSRF/tenant boundaries and independent external-key retention remain mandatory. This is a prerelease, not compliance certification or public-production readiness.
- Archive delivery contains tracked source plus compiled web/server output and a commit manifest, but no installed dependencies or Chromium. Installation and upgrade instructions are in [release notes](../RELEASE_NOTES.md).
