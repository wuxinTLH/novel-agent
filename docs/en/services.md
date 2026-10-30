# Backend layers, services and tenant boundaries

[中文原文](../services.md) · [English index](README.md) · [SQL reference](../sqlconnect.md)

## Organization

The [entry point](../../packages/server/src/index.ts) loads environment, takes the data lock, assembles services, listens and closes resources. The server workspace is `space.syjx.agent.novel.server`, organized into core (HTTP/assembly/locking/tenancy), features (business services/routes/tests), and infrastructure (storage/database/security). This is one application with a control plane, tenant Workers and database Workers—not separately deployed distributed microservices. API paths and legacy document layouts are preserved; startup does not rewrite old data automatically.

| Area | Responsibility |
| --- | --- |
| `context.ts`, `application.ts`, `registry.ts` | Shared Store/Runner/platform/model context, FeatureService contracts, explicit registration/order/duplicate-ID checks. |
| `http.ts` | Common origin, CSRF, rate/body limits, headers, API 404 and sanitized errors; features must not bypass it. |
| `web-hosting.ts` | Optional static assets and SPA delivery, separate from API fallback. `SERVE_WEB` defaults to `true`; `false` leaves APIs/uploads and JSON fallback without HTML. `WEB_DIST_DIR` selects a trusted build directory, default application-root `dist`. |
| Models/projects/workflow/assets/generation/chapters | Profiles and credentials, project mutation locks, graph validation and rollback, assets, generation/candidates/idempotency/cancellation/revisions. |
| Platforms | Connections/binding, isolated browser, queue and verified account locks. |
| Authentication/administration | Identity, sessions, explicit roles, strict local management when authentication is off. |
| Tenant runtime | Immutable-owner application/Store/Runner/secrets/browser/queue/uploads per Worker. |
| SQLconnect | Legacy optional connection probes and reserved schema initialization, not activation. |
| Storage | Document boundary, v3 profiles/owner mapping/activation, canonical relational entities, pools and acknowledged persistence. |
| Documents/account/maintenance | Reconstructed temporary DOCX and exports; optional mail/OIDC/MFA; bounded online backup queue and offline CLIs. |

Extensions implement FeatureService behind common protections and must participate in awaited shutdown hooks. See [server package](../../packages/server/README.md).

## Web delivery and HTTP boundaries

Root `build:web` and `build:server` commands build independently; integrated startup remains the default. A separate static entry must proxy `/api` and `/uploads` on the same browser origin to one backend, never expose the data directory or rewrite API errors as HTML. Host/Origin/Cookie/CSRF and trusted HTTPS-origin configuration still apply; no new cross-origin business CORS is added. See [deployment instructions](user-guide.md#separate-builds-and-same-origin-deployment). This separates delivery responsibilities, not distributed services or public-Internet safety guarantees.

Origin policy now requires a literal IPv4 address before accepting private ranges, rejecting prefix-disguised DNS names such as `10.attacker.example`. Exploiting the old check requires controlled DNS and rebinding reachability; it does not directly bypass authenticated sessions and browser private-network restrictions may apply. API guards now match Express's case-insensitive routing: `/API/...` must enforce business CSRF and `no-store` too. Local HTTP regressions are not proof of all-vulnerability or real-deployment acceptance.

## Authentication and immutable ownership

Authentication and Turnstile default off. `GET /api/services/user` and `/api/auth/session` report status; install, account creation, DB configuration and migration do not enable authentication. First superadmin is bootstrapped locally while stopped; no HTTP bootstrap exists. Optional registration creates only an email-confirmed writer. Explicit `enable-auth --owner UUID` assigns old data, or `--no-legacy` for a genuinely empty layout.

Unauthenticated management requires a real loopback socket, local Host/Origin, no cross-site request and `X-Admin-CSRF` for writes. Forwarded headers are not trusted; unauthenticated LAN use is not admin access. Authenticated management follows [explicit role permissions](roles-permissions.md), not weights or an unconditional superadmin requirement for all read/backup operations. Administrative status does not authorize reading other tenants' content/secrets.

Only server-verified sessions select identity; client owner headers/query values are ignored. The legacy owner retains the old directory; other UUIDs use `DATA_DIR/users/<SHA-256(user UUID)>`; SQL is owner-scoped. Unauthenticated requests fail closed, never fall back to shared storage. Runtime capacity is 32; overflow reports `TENANT_RUNTIME_CAPACITY`, not unbounded scaling.

Passwords use scrypt, cookies HttpOnly/SameSite=Strict. Password changes/resets, disablement and role changes revoke affected sessions. The final active superadmin cannot be disabled/demoted. Admin password reset in authenticated mode requires current-password reauthentication; logout does not cancel background jobs. Session lists expose nonreversible IDs/expiry metadata, not raw tokens.

APIs include `POST /api/auth/password`, `GET/DELETE /api/auth/sessions`, `DELETE /api/auth/sessions/:sessionId`, `GET/POST /api/admin/users`, `PATCH /api/admin/users/:id`, `POST /api/admin/users/:id/password`, and admin user-session listing/revocation. Business writes retain `X-Platform-CSRF` and authenticated `X-CSRF-Token`.

Turnstile stores an encrypted secret and exposes only `hasSecret`; enabled login requires real online success/action/hostname validation and fails closed on network errors. Local auth data becomes a global owner document after SQL activation, but `auth.key` stays local. POSIX `0600` does not configure Windows ACLs. The deployment remains local/trusted-LAN, not a public-Internet guarantee.

## v3 storage, concurrency and single-instance limits

[Profiles](../sqlconnect.md#v3-storage-profiles) configure multiple MySQL/PostgreSQL/SQL Server connections, default and explicit owner bindings. MySQL/SQL Server have mocked coverage only; live vendor compatibility is unproven. Migration is stopped-service `maintenance migrate-all`; legacy SQLconnect save/initialize is not migration. Active configuration is not edited online and failures never revert to stale JSON.

`novel_agent_v3_*` tables hold canonical project/chapter/asset/workflow entities. Compatibility document structure/settings/revisions reconstruct full project documents on read/export; duplicate whole-project prose is not a second authority. Owner/document revisions, import receipts and entities commit transactionally, with CAS conflicts rejecting overwrite.

DB Workers reuse async connection pools. Tenant Workers synchronously await actual COMMIT, not write-behind; this can block that tenant. Other tenant business event loops are isolated, but control-plane auth SQL still has bounded synchronous blocking. Ordinary admission queues per owner before pool acquisition; independent owners can overlap. Snapshots/import/migration use an exclusive barrier that waits for admitted transactions to finish. DB repository/owner locks remain necessary; no contention-free throughput claim is implied. Unknown/timed-out commits fail closed, not automatic retries of external side effects.

**One application instance and local data lock remain mandatory.** SQL row locks/CAS do not provide distributed runtime leases. Single-instance control-plane platform locks coordinate all tenants by server-verified provider/stable account ID; unknown manual login takes a whole-provider lock. Clients cannot choose lock keys. Busy/unavailable fails closed; HTTP disconnect or TTL never releases uncertain work. Worker exit cleans remaining leases. Other hosts/apps/official dashboard edits are not covered. Stop all runtimes sharing databases before maintenance; a local file lock cannot stop another machine.

The [historical simulated benchmark](../../scripts/benchmark-storage-report.md) measured four permits, 80 operations and three samples: eight-owner owner admission about 254–261 ops/s versus profile serialization 64–66 ops/s (3.86–4.05×); one owner unchanged. No SQL/network/disk/DB-lock performance was measured. Optional live v3 scripts require explicit safe environment and database-creation opt-in; v2 success is not v3 evidence.

## Optional account services and document processing

[Account configuration](../../packages/server/src/features/auth/README.md) covers off-by-default registration/mail recovery/OIDC/TOTP. SMTP is explicit (`NOVEL_SMTP_ENABLED=true`, HOST/USER/PASSWORD/FROM variables), default port 587 or 465 with SECURE, using verified TLS. Single-use mail links expire in 15 minutes and place tokens in fragments. Registration confirms email and does not auto-login.

OIDC uses configured endpoints, code/PKCE S256, browser-bound state, nonce and JWKS exact issuer/audience/signature verification. Exact issuer/subject must be mapped to an existing user; email is not an account-linking authority. MFA verifies a fresh counter/one-use code before issuing business sessions. Recovery does not remove MFA; global disable cannot bypass a bound factor.

Mail/OIDC require an independently deployed TLS proxy and exact `NOVEL_TRUSTED_PUBLIC_ORIGIN`; preserve Host, clear untrusted forwarding headers and block direct external backend access. Secure cookies become mandatory. This neither provides TLS nor enables authentication/relaxes local admin. Real SMTP/OIDC/Turnstile/proxy acceptance remains outstanding.

Document routes use existing project/origin/CSRF guards. DOCX/EPUB export saved canonical chapters in order, not candidates/unsaved edits. PDF export is a browser print view, with manual font/pagination checks. Temporary DOCX is at most 8 MiB, memory-only for 30 minutes, 10/project and 64/runtime/64 MiB, two concurrent processors. ZIP limits: 512 entries, 32 MiB expansion, 200:1 ratio, five seconds. Conversion: ten seconds, 128 MiB V8 heap and 4 MiB sanitized output. **PDF upload is rejected**; no reliable reconstruction/OCR exists. Original OOXML is not served; `.doc` needs external conversion. See [file-sandbox boundaries](file-sandbox.md).

## Online maintenance and offline recovery

One main-process maintenance manager queues backup/validate/restore-plan. Defaults are 8 queued tasks, 100 terminal records and 20 artifacts; capacity does not silently delete sensitive backups. Backup prevents new tenant/control-plane work, drains actual promises, closes all Workers/browsers and snapshots every configured profile while holding global quiescence and the instance lock. Unsafe draining refuses backup. Admission resumes after safe completion/failure.

Managed artifacts live outside data (normally `.data-managed-backups`); no browser download, raw path/manifest/error leak or arbitrary filesystem input is exposed. Stages are estimates, not byte progress; cancellation needs safe checkpoints and cannot interrupt committing. Restart marks interrupted, never retries. Validate/restore-plan neither imports nor connects source DBs and does not prove keys, business semantics or target compatibility. Restore/migration remain offline; no scheduled/distributed backup service exists.

Full backup includes safe local tree, binaries/empty directories, all tenant uploads/secrets/browser data and every configured v3 owner's documents/entities/revisions/receipts. **Not a whole DB dump**: unrelated tables/users/grants/server config are excluded. Every tree level excludes `.instance.lock`, `.instance.lock.recovery`, `admin-backups`, `.maintenance-journal.json`, `*.tmp`, `.maintenance-*`; unsafe links/paths reject. Environment-only model/platform encryption keys must be retained separately. Legacy v1 SQL needs independent `pg_dump` plus full local tree/keys, not maintenance backup.

Restore defaults to empty targets and explicit trusted SQL target profiles, never backed-up source addresses. Local rollback copies cannot atomically roll back multiple DB commits. A failure journal blocks startup until persistent state is reconciled; do not simply delete it. Restore revokes sessions and never replays publication. See the [operational commands](user-guide.md#online-backup-and-offline-restore).
