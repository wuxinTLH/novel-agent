# CoreModel: local and server deployment

[中文](../deployment-modes.md) · [Project overview](../../README/README_en.md) · [Hardening and gaps](security-hardening.md)

## Mode and startup contract

The exact environment variable is `CoreModel`, unrelated to model-provider selection. Only literal `local` / `server` are accepted. Unset means `local`; all other explicit values (including empty or differently cased values) fail startup.

| Setting | `local` | `server` |
| --- | --- | --- |
| Node HTTP listener | Only `127.0.0.1` | `0.0.0.0` |
| Access | This machine only; no direct LAN access | Only through a controlled same-origin real HTTPS reverse proxy; block direct backend access |
| Authentication | Optional, off by default | Must already be enabled offline or startup fails |
| Security profile | Defaults to `standard`; optional `hardened` | Forces `hardened`; explicit `SECURITY_PROFILE=standard` fails |
| Audit | Off by default in standard, optional opt-in | Mandatory; explicit `SECURITY_AUDIT=false` fails |
| Local gateway | Off by default, optional loopback aliases | Must be disabled |

`SECURITY_PROFILE` accepts only `standard` / `hardened`; `SECURITY_AUDIT` only `true` / `false`. Other explicit values fail startup. Explicit hardened in local still requires strict prerequisites and forces audit. Server cannot bypass checks by disabling authentication, selecting standard or disabling audit.

Local trusted HTTPS origins permit only loopback hosts `localhost` / `127.0.0.1` / `[::1]`, still subject to exact HTTPS origin validation; remote/LAN origins fail startup. Local hardened can use a real loopback HTTPS proxy. This does not claim to stop a host administrator from creating external tunnels.

## Native local execution

```powershell
$env:CoreModel='local'
npm start
```

Use `http://127.0.0.1:3001`. Local anonymous use grants no remote management rights; Host/Origin/Cookie/CSRF checks remain. Additional loopback gateways are local-only, do not expose LAN access and do not create independent data instances. Native local is recommended for desktop users, especially for first interactive Chromium platform login.

## Server: offline bootstrap before startup

1. Stop the service and protect data, databases and external keys; the CLI also takes the data-directory lock.
2. Explicitly set `$env:CoreModel='server'` in the CLI environment (the CLI does not automatically load `.env`), securely inject `NOVEL_BOOTSTRAP_PASSWORD`, then run `npm run admin -- bootstrap-admin --username admin --phone <E164_PHONE> --data-dir <DATA_DIRECTORY> --confirm` offline. For existing unbound users, stop the service and migrate each account with `npm run admin -- set-phone --username <USERNAME> --phone <E164_PHONE> --data-dir <DATA_DIRECTORY> --confirm`; this revokes that user's sessions. Phone numbers must be E.164; protect backups containing them.
3. Record the returned owner UUID and run `npm run admin -- enable-auth --owner <RETURNED_OWNER_UUID> --data-dir <DATA_DIRECTORY> --confirm`. Only a genuinely empty directory can use `--no-legacy`. Creating an account alone does not enable authentication.
4. Configure `CoreModel=server`, an exact HTTPS `NOVEL_TRUSTED_PUBLIC_ORIGIN`, independent high-entropy `MODEL_SECRETS_KEY` / `PLATFORM_SECRETS_KEY` of at least 32 characters each, and `GATEWAY_ENABLED=false`. **Choose an SMS provider before startup** with `NOVEL_SMS_PROVIDER=aliyun` or `tencent` and all selected-provider credentials and approved signature/template settings; missing/invalid configuration fails startup, without a live delivery probe. See the [auth contract](../../packages/server/src/features/auth/README.md#sms-provider-and-turnstile-server-mode) for variable names and flow. Explicit `SECURITY_PROFILE=hardened` / `SECURITY_AUDIT=true` are allowed; their opposite values are not.
5. Supply a real TLS reverse proxy, preserving browser Host (including non-default port), Origin, Cookie and CSRF, clearing untrusted forwarding headers and allowing only the proxy to reach the backend. Node provides no TLS and does not trust `X-Forwarded-*`. Setting an HTTPS origin neither installs certificates nor enables authentication. Separate web hosting must proxy `/api` and `/uploads` on the same browser origin, without cross-origin business CORS.
6. Start and test anonymous denial, roles/tenants, CSRF, Secure cookies, audit and inaccessible direct backend through the actual HTTPS entrance.

The single exact HTTPS origin must have no user information, non-root path, query, fragment or wildcard. Align account-mail `publicOrigin` and OIDC callbacks with it. Key length checks do not prove entropy.

### Server account policy

Newly set server passwords require at least 15 Unicode characters and at most 1024 bytes; limited common-password, low-diversity, account-name-derived and current-password reuse checks apply without retroactively invalidating stored passwords. **Every password login requires SMS verification at the bound phone**; unbound/unverified accounts fail closed, and optional enrolled TOTP is an additional step, not a substitute. Self-registration verifies the phone before email confirmation creates a bound account. When Turnstile is enabled, the server checks it on login, registration and issuance of registration/login/phone-binding SMS; obtain a fresh challenge for each request. The v0.0.4a server uses 60-minute access, rotating seven-day refresh and a persisted 30-day idle cutoff; **eight days offline exhausts refresh**, so 30 days offline cannot be promised. The client attempts refresh on session restoration and eligible failed reads, but does not replay potentially committed mutations. At most five active browser login families per user. Local retains its existing policy. See the [authentication contract](../../packages/server/src/features/auth/README.md) and final regression/external acceptance for definitive behavior.

## Site appearance, upgrades and backups

Separate Header/Footer and administrator appearance controls do not change deployment, same-origin or authentication boundaries. `GET /api/site-appearance` exposes only nonsecret styles; administrative reads/writes require `appearance.manage` (admin/superadmin), retaining write CSRF. Global control-plane `DATA_DIR/site-appearance.json` stays local even with SQL business storage: database-only backups are insufficient. Preserve the safe complete data tree, the appearance file when created and independent external keys. Online backup requires global quiescence; restore/deployment replacement follows existing shutdown procedures. In containers this is `/app/data/site-appearance.json` on the persistent data volume, not image-baked configuration or a static resource. After restore inspect contrast, the default empty company name and fixed author link. See [site appearance](site-appearance.md) and [backup/restore](user-guide.md#online-backup-and-offline-restore).

## Docker and Compose

The [Dockerfile](../../Dockerfile) defaults to build argument `ARG CoreModel=server`, validated as local/server during build; image `ENV CoreModel` preserves the selected default. A runtime override is allowed but validated again at startup. For example, `docker build --build-arg CoreModel=local -t novel-agent:local .` changes the image default; it **does not make local accessible through published ports**.

[Compose](../../compose.yaml) uses `${CoreModel:-server}` for both build arg and runtime environment. Its default is server, unlike native execution's local default. Complete offline CLI bootstrap and HTTPS/key configuration before the first server startup: an initial `docker compose up` is not bootstrap. See the [security guide](security-hardening.md#local-docker-commands-and-offline-bootstrap) for compiled CLI commands and non-root/read-only permissions. Keep separate named data and backup volumes; never delete their only copies.

**Container local binds only container-internal `127.0.0.1`. Published host ports cannot reach that listener. Do not describe local plus port mapping as a usable local Docker deployment.** Prefer native local for desktop use; a browser outside the container needs server with every prerequisite and a real HTTPS proxy.

No usable Docker Engine was available in the implementation environment: image build/run were not performed. Static configuration checks do not establish target-host acceptance. Chromium is not included. Mode checks, HTTP defenses and bounded local audit are not OS-kernel protection, immutable centralized audit, certification or public-production assurance. Single-instance/non-HA limits and independent external-service acceptance remain. The maintained prerelease remains `v0.0.5a` (package SemVer `0.0.5-a`), without a new version. Same-tag/asset replacement is explicitly authorized; old downloads/checksums do not identify the replacement assets. Download again and consult [release notes](../../RELEASE_NOTES.md) and [current validation](../release-validation-v0.0.5a.md); historical reports are not current acceptance.
