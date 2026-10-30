# Server hardening and gaps toward a Level 4 MLPS target

[中文](../security-hardening.md) · [Project overview](../../README/README_en.md) · [Permissions](roles-permissions.md)

> **Status: application controls confirmed with the lead implementer; deployment and assessment still require independent acceptance.** This is a control-oriented application/deployment gap list, not an official standards clause mapping, classification report, assessment or certification. Targeting Level 4 under China's classified cybersecurity protection framework (等保四级 / MLPS) does not mean this application or a deployment meets that level. HTTP defenses, Docker and logging cannot establish that conclusion. The responsible organization and qualified assessors must determine actual applicability, boundaries and evidence. No official clause wording is reproduced or invented here.

## 1. Current boundaries

- `CoreModel` accepts only local/server (unset: local; invalid: startup failure). Local binds only `127.0.0.1`, with no direct LAN access and optional authentication off. Server binds `0.0.0.0`, requires enabled auth, forces hardened/audit and must be reached only through a same-origin real HTTPS proxy; block backend bypass. See [deployment modes](deployment-modes.md).
- One instance owns a data directory. Tenant Workers, SQL CAS and platform-account locks are not distributed runtime leases. **This is not HA, active-active, disaster recovery or automatic failover.** Do not scale Compose replicas against the same directory/owner.
- This increment adds a shared HTTP boundary, explicit strict-startup checks, bounded audit chaining and least-privilege container settings. Implementation and lead-supplied parameters have been checked; actual test and target-host Docker results must be recorded separately, not inferred from this guide.
- Local tests prove only their temporary-directory/stub scenarios, not real proxy, identity-provider, database, container-host or assessment acceptance.

## 2. Application controls versus deployment responsibilities

| Control area          | Existing application support                                                                                                                                                                                           | Prerequisites and remaining gaps                                                                                                                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity              | CLI-only first-superadmin bootstrap; explicit auth activation and legacy owner assignment; password/disable/role changes revoke sessions; optional TOTP and pre-mapped OIDC                                            | Default anonymous access is unsuitable for a high-assurance deployment. Establish unique named identities, administrator MFA, lifecycle/login/session/emergency-access policies. Optional MFA is not universal enforcement or a hardware factor                          |
| Authorization         | Server-side role/module checks, independent tenant runtimes, Origin and CSRF checks; operations role cannot freely change security settings                                                                            | Four roles do not implement OS/database/network authorization, comprehensive separation of security duties, mandatory access control or classified-data isolation. Test all APIs, exports and maintenance paths                                                          |
| HTTP boundary         | Origin policy, bounded rate limiting, business no-store, CSP/framing/nosniff headers, explicit trusted HTTPS origin without forwarding-header trust                                                                    | The shared HTTP boundary now unifies entry/tenant headers, method/path validation and server UUIDs; malformed raw HTTP may still be rejected earlier by Node. Proxy must preserve Host, remove hostile forwarding headers, bound requests/connections and block backend bypass  |
| Data and keys         | Application encryption for model/platform credentials; model egress rejects local/private/metadata targets; local auth key                                                                                             | Not a cryptographic compliance claim: no validated Chinese commercial-cryptography stack/product, HSM/KMS integration or dual-person key custody. SQLconnect passwords remain plaintext. Protect configuration, database TLS, backups and endpoints separately           |
| Files and isolation   | Admission, reconstruction, size/time limits; PDF rejected without reliable reconstruction; upload/legacy-read path checks                                                                                              | Workers/child processes are not OS sandboxes or malware detection. Containers share the host kernel; configure least privilege, patches, mandatory access controls, egress and required detection                                                                        |
| Audit                 | Existing account/administrative/publication records; this increment adds optional bounded SHA-256-linked audit (mandatory in hardened mode), with request metadata rather than comprehensive attributable user actions | A local hash chain is not a signature, trusted timestamp, remote witness or immutable storage. A host/log writer can rewrite a whole chain. Independent centralized collection, access separation, alerts and required retention are necessary; rotation is not archival |
| Backup/availability   | Full-application backup, global quiescence and integrity checks; restore/migration are offline; failure journal blocks startup                                                                                         | Not a full database dump; retain external keys separately; no atomic cross-database rollback guarantee. Exercise restore/decryption, define RPO/RTO/capacity/failure plans. Single-instance downtime remains                                                             |
| Governance/operations | Role separation, offline admin CLI, managed backup directory and bounded maintenance queue                                                                                                                             | No general two-person approval/execution mechanism; a confirmation dialog is not dual control. Organization/process controls, change approval, supply-chain governance, incident exercises and continuing audit remain necessary                                         |

See [authentication](../../packages/server/src/features/auth/README.md), [services](services.md), [file safety](file-sandbox.md), [SQL configuration](../sqlconnect.md) and the [user guide](user-guide.md) for existing behavior.

## 3. Prerequisites application code cannot supply

1. **Host and physical environment:** determine protected assets, data classification, system boundaries and accountable owners. Establish facility/cloud security, trusted administration endpoints, patch/baseline/malware controls and host audit. POSIX mode bits do not replace Windows NTFS ACLs; verify Linux ownership/mount permissions too.
2. **Network zoning:** separate ingress proxy, application, database, management and audit planes, using default-deny precise allowlists. Only the proxy should reach the backend; restrict database and management access. Application SSRF checks are not a host egress firewall: review model, SMTP, OIDC and platform-browser traffic independently.
3. **Secure access:** supply maintained TLS termination, certificate lifecycle management and real HTTPS acceptance. Configure exact `NOVEL_TRUSTED_PUBLIC_ORIGIN`; the service provides neither TLS itself nor automatic auth activation. Separately hosted web clients still need same-origin `/api` and `/uploads`.
4. **Cryptography and secrets:** identify applicable Chinese commercial-cryptography requirements and validate products, protocols, HSM/KMS and key-management arrangements. Existing AES/SHA/TOTP is not a Chinese-cryptography capability simply by relabeling it. Never put secrets in images, Git, command arguments or ordinary logs; verify old-data decryption and recovery before rotation.
5. **Independent audit:** collect identity, authorization, configuration, high-risk business, host/container, proxy and database events. Secure collection identities and transport, synchronize time, define retention/capacity/collection-failure handling and alert response. Central storage needs privileges separate from application administrators and applicable immutable/deletion-resistant protection.
6. **Governance and assessment:** separate development, operations and security-audit responsibilities/conflicting privileges; establish dual approval and controlled emergency access. Gather actual configuration, test, log and exercise evidence. Follow applicable classification, filing, remediation and assessment processes, never substitute a README or image tag.

## 4. Safe authentication activation

1. Isolate the network and stop the service. Back up data, databases and external keys; verify recovery steps.
2. Supply `NOVEL_BOOTSTRAP_PASSWORD` securely, then use the local CLI. Custom directories require explicit `--data-dir`; do not assume the admin CLI uses `DATA_DIR`.

```powershell
$env:CoreModel='server' # CLI does not load .env; apply server credential policy
npm run admin -- bootstrap-admin --username admin --data-dir <DATA_DIRECTORY> --confirm
npm run admin -- enable-auth --owner <RETURNED_OWNER_UUID> --data-dir <DATA_DIRECTORY> --confirm
```

Existing data requires an explicit owner. Only a fresh empty directory may use `--no-legacy`. Creating users, configuring MFA or adding a proxy does not activate authentication. Never put real passwords in arguments.

3. Configure precise HTTPS origin, proxy/firewall and protected directories/keys, then start with authentication enabled. Test anonymous and cross-role/tenant denial, CSRF, revocation and HTTPS cookies.
4. Verify administrator MFA, recovery-code custody and emergency procedures; feature switches alone do not enforce organizational policy.
5. Native local defaults to `SECURITY_PROFILE=standard`, with optional hardened; server forces hardened and rejects explicit `SECURITY_PROFILE=standard`. Other values fail startup. Hardened mode requires authentication already enabled, a valid exact HTTPS `NOVEL_TRUSTED_PUBLIC_ORIGIN`, gateway disabled, and distinct `MODEL_SECRETS_KEY` / `PLATFORM_SECRETS_KEY` of at least 32 characters each. Audit is mandatory. Length is not entropy: generate independent high-entropy secrets. These limited checks do not prove real TLS, mandatory MFA, network isolation or compliance, nor enforce non-root/read-only execution.

### Request boundary, timeouts and audit parameters

The shared HTTP boundary permits `GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS`, rejects ambiguous encoding, traversal, encoded slash/backslash and ambiguous framing, and generates UUIDs rather than trusting client request IDs. Defaults: URL 16 KiB, application header preflight 32 KiB/100 fields, declared Content-Length preflight 64 MiB. Declared length is not actual stream metering; JSON/upload parsers retain tighter limits, and Node may reject raw HTTP earlier. Valid query values are not interpreted as routing syntax. Separate static hosts need equivalent response policies independently.

Node header reception is limited to 15 seconds, request reception to 120 seconds, keep-alive to 5 seconds, headers to 100 and requests per socket to 1000. Request-reception timeouts are not absolute generation/SSE response deadlines. Independently configure proxy connection/read/write/capacity controls without blindly breaking long-running responses.

`SECURITY_AUDIT` accepts only `true` / `false` (other explicit values fail startup), defaulting off in local standard; `true` opts in, while local hardened forces audit. Server forces audit and rejects explicit `SECURITY_AUDIT=false`. Logs are under the data directory at `security-audit/security-audit.jsonl`: 8 MiB segments, current plus 8 rotated segments (up to 9 files). Creation modes are directory `0700` and file `0600`; check pre-existing permissions/Windows ACLs separately. Records contain SHA-256 previous links, increasing sequence, time, UUID, method, status, duration and fixed reasons, never raw URLs, query, body, headers or user identity. This is not complete attributable business audit.

Routing admission waits for append and fsync; failure returns 503 without entering business routing. Completion-write failure cannot undo an existing operation/response, but poisons the sink so subsequent business admission fails closed. Startup validates only the current segment's internal chain, not older segments. Clearing the current segment, deleting logs or rewriting an internally valid chain cannot be detected by this local check; independent remote anchoring/collection comparison is necessary. A host administrator can rewrite/delete logs. Rotation evicts the oldest segment: collect/archive independently before eviction. There is no remote witness, non-repudiation, trusted timestamp or built-in central collector.

## 5. Containers and verification

The [Dockerfile](../../Dockerfile) uses Node 22 bookworm-slim multi-stage builds and non-root `node` (UID 1000), without Chromium. Tags are not pinned digests: verify/pin the base digest and scan dependencies/images in the deployment pipeline. [Compose](../../compose.yaml) configures read-only root, `/tmp` tmpfs (128 MiB, noexec/nosuid/nodev), all capabilities dropped, no-new-privileges, 256 PIDs, 2 GiB memory and 2 CPUs. Keep runtime-default seccomp; the project supplies no specialized syscall allowlist. Verify effective host policy.

Preserve non-root execution, a read-only root filesystem, minimal capabilities and no-new-privileges. Verify effective host seccomp/AppArmor/SELinux controls. Do not use privileged mode, host networking or Docker-socket mounts to bypass restrictions. Evaluate necessary writes and capacity separately for data, temporary/browser files and external backups. Docker's default seccomp is not a project-specific syscall allowlist.

First platform login still requires interactive Chromium on the backend machine. A headless container cannot automatically complete that flow. If non-root/seccomp restrictions prevent browser operation, independently evaluate a supported environment; adding `--no-sandbox`, elevating privileges or disabling isolation does not establish security.

### Local Docker commands and offline bootstrap

A working Docker Engine and Compose are prerequisites. Docker-management privileges can normally control the host; do not grant them as ordinary application-user access. Run from the repository root. Publishing only `127.0.0.1:3001` limits the host port, not container-network access.

```powershell
docker compose config --quiet
docker compose build
# Bootstrap before first server startup; stop any existing instance, sharing the named volume
docker compose stop
# First inject NOVEL_BOOTSTRAP_PASSWORD securely into the invoking environment
docker compose run --rm --no-deps -e NOVEL_BOOTSTRAP_PASSWORD novel-agent node build/packages/server/src/features/administration/admin.js bootstrap-admin --username admin --data-dir /app/data --confirm
docker compose run --rm --no-deps novel-agent node build/packages/server/src/features/administration/admin.js enable-auth --owner <RETURNED_OWNER_UUID> --data-dir /app/data --confirm
# Configure actual HTTPS / independent keys as below before first startup
docker compose up -d
```

Never put real secrets in password arguments. The image contains production dependencies only: do not use development-tool-dependent `npm run admin` / `npm run maintenance`. The compiled maintenance entry is `node build/packages/server/src/features/administration/maintenance-cli.js`. Docker defaults to build argument `ARG CoreModel=server`, validated as local/server; image `ENV CoreModel` retains the selected mode and runtime overrides are validated at startup. Compose build arg/runtime both use `${CoreModel:-server}`: default server forces hardened/audit and rejects explicit standard/disabled audit. Missing authentication or prerequisites fails startup. Enable auth offline, configure the actual HTTPS origin, two independent >=32-character keys and gateway off, then first start behind a real Host-preserving TLS proxy. Host ports default to loopback. **Container local binds only internal loopback, unreachable through published ports; prefer native local for desktop use.** See [deployment modes](deployment-modes.md). Compose interpolation can read root `.env`: protect it, and note that `docker compose config` without `--quiet` can print expanded secrets.

Writable mounts are the `/app/data` data volume, separate `/app/.data-managed-backups` backup volume and `/tmp`. The image prepares both persistent directories for UID 1000. Custom bind mounts need their own ownership/ACL verification; do not conceal failures by making root writable. Offline backup destinations also need an explicit writable mount outside the data directory. Backups contain secrets; do not delete the only data/backup volumes with `docker compose down -v`. No Chromium is included; the default image does not support first interactive Fanqie login in a remote container.

The implementation environment has Docker CLI 29.3.1 but no reachable Docker Engine pipe: **image build and container execution were not performed**. The lead confirmed `docker compose config --quiet` passed; static checks/application tests do not validate the Node 22 container, host isolation or real TLS. Proposed security prerelease is `v0.0.2-a.2`, with final tagging/publication owned by the lead, not a compliance claim. The release artifact is a `.tar.gz` archive containing Git-tracked source, compiled server/web output and the lockfile, without node_modules, `.env` or data; a commit manifest and SHA256SUMS accompany it. Verify these before running `npm ci --omit=dev --ignore-scripts`, `npm rebuild sharp`, then `node build/packages/server/src/index.js` from its extracted root. Retain the lockfile and verify release provenance/checksums. Compiled artifacts do not mean dependencies are installed or containers accepted.

## 6. Delivery checklist

- [ ] Identify scope, applicable requirements, owners and dependencies, with no level/certification claim.
- [ ] Explicitly enable auth; prove anonymous/cross-role/cross-tenant denials and identity/MFA/recovery policies.
- [ ] Test real HTTPS, Host/Origin/CSRF/cookies, proxy limits and inaccessible direct backend.
- [ ] Verify non-root/read-only/capabilities/seccomp, volume permissions, resource bounds, restart and maintenance writes on the target host.
- [ ] Exercise audit forwarding, chain checks, rotation/archive, deletion/rewrite detection, clock/capacity alerts; do not equate local chaining with immutability.
- [ ] Track unmet Chinese-cryptography/HSM/key-lifecycle/database/backup-encryption requirements as gaps, not capabilities of existing application encryption.
- [ ] Evidence dual control, host/network baselines, supply-chain scanning/remediation, full restore and downtime procedures.
- [ ] Record actual typecheck/regression/full-test/build results, and explicitly mark unrun Docker, external-service and assessment checks. GitHub publication changes none of these boundaries.

This checklist organizes engineering work. Checking every box is still not a Level 4 compliance determination.
