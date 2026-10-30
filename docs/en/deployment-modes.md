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
2. Explicitly set `$env:CoreModel='server'` in the CLI environment (the CLI does not automatically load `.env`), securely inject `NOVEL_BOOTSTRAP_PASSWORD`, then run `npm run admin -- bootstrap-admin --username admin --data-dir <DATA_DIRECTORY> --confirm` offline.
3. Record the returned owner UUID and run `npm run admin -- enable-auth --owner <RETURNED_OWNER_UUID> --data-dir <DATA_DIRECTORY> --confirm`. Only a genuinely empty directory can use `--no-legacy`. Creating an account alone does not enable authentication.
4. Configure `CoreModel=server`, an exact HTTPS `NOVEL_TRUSTED_PUBLIC_ORIGIN`, independent high-entropy `MODEL_SECRETS_KEY` / `PLATFORM_SECRETS_KEY` of at least 32 characters each, and `GATEWAY_ENABLED=false`. Explicit `SECURITY_PROFILE=hardened` / `SECURITY_AUDIT=true` are allowed; their opposite values are not.
5. Supply a real TLS reverse proxy, preserving browser Host (including non-default port), Origin, Cookie and CSRF, clearing untrusted forwarding headers and allowing only the proxy to reach the backend. Node provides no TLS and does not trust `X-Forwarded-*`. Setting an HTTPS origin neither installs certificates nor enables authentication. Separate web hosting must proxy `/api` and `/uploads` on the same browser origin, without cross-origin business CORS.
6. Start and test anonymous denial, roles/tenants, CSRF, Secure cookies, audit and inaccessible direct backend through the actual HTTPS entrance.

The single exact HTTPS origin must have no user information, non-root path, query, fragment or wildcard. Align account-mail `publicOrigin` and OIDC callbacks with it. Key length checks do not prove entropy.

### Server account policy

Newly set server passwords require at least 15 Unicode characters and at most 1024 bytes; a limited common-password blocklist, low character diversity and account-name-derived passwords are rejected. Changes/resets/recovery cannot reuse the current password. Stored passwords are not retroactively invalidated or subject to a forced immediate change. After authentication (including enrolled MFA when configured), each user retains at most 5 active sessions; issuing another at the limit revokes the session with the earliest expiresAt. Local retains its existing password/session policy. Optional MFA is not mandatory-by-default MFA. See the [authentication contract](../../packages/server/src/features/auth/README.md) and actual regression evidence for final behavior.

## Docker and Compose

The [Dockerfile](../../Dockerfile) defaults to build argument `ARG CoreModel=server`, validated as local/server during build; image `ENV CoreModel` preserves the selected default. A runtime override is allowed but validated again at startup. For example, `docker build --build-arg CoreModel=local -t novel-agent:local .` changes the image default; it **does not make local accessible through published ports**.

[Compose](../../compose.yaml) uses `${CoreModel:-server}` for both build arg and runtime environment. Its default is server, unlike native execution's local default. Complete offline CLI bootstrap and HTTPS/key configuration before the first server startup: an initial `docker compose up` is not bootstrap. See the [security guide](security-hardening.md#local-docker-commands-and-offline-bootstrap) for compiled CLI commands and non-root/read-only permissions. Keep separate named data and backup volumes; never delete their only copies.

**Container local binds only container-internal `127.0.0.1`. Published host ports cannot reach that listener. Do not describe local plus port mapping as a usable local Docker deployment.** Prefer native local for desktop use; a browser outside the container needs server with every prerequisite and a real HTTPS proxy.

No usable Docker Engine was available in the implementation environment: image build/run were not performed. Static configuration checks do not establish target-host acceptance. Chromium is not included. Mode checks, HTTP defenses and bounded local audit are not OS-kernel protection, immutable centralized audit, certification or public-production assurance. Single-instance/non-HA limits and independent external-service acceptance remain. The target prerelease is `v0.0.2-a.2`; actual publication must be confirmed by the publisher.
