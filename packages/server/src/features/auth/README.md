# Authentication and opt-in accounts

Authentication and every account capability remain **off by default**. Creating users, configuring extensions, or sending mail never enables authentication. Initial superadmin creation remains local CLI only. Account metadata lives in the existing version-1 auth document (optional `account` field), including when the owner's AuthPersistence is SQL-backed. TOTP seeds and OIDC client secrets use the existing auth encryption key. Do not downgrade binaries after account extensions are configured: older schemas can strip unknown fields.

## Integration contracts

`createAccountEmailTransport(process.env)` from `account-mail.ts` returns `undefined` unless `NOVEL_SMTP_ENABLED=true` and requires `NOVEL_SMTP_HOST`, `NOVEL_SMTP_USER`, `NOVEL_SMTP_PASSWORD`, `NOVEL_SMTP_FROM` plus optional `NOVEL_SMTP_PORT` (587 by default) / `NOVEL_SMTP_SECURE=true` (465 by default). Parent must pass it as `emailTransport` to AuthService; missing transport means admin cannot enable registration, verification, or recovery. SMTP enforces TLS certificate validation, bounded connection/greeting/socket timeouts, disables file/URL attachment access, and never logs the message. Missing credentials fail at startup only if the SMTP opt-in flag is set. Do not log these environment values.

`AuthServiceOptions.emailTransport?: (mail: AccountMail) => Promise<void>` is an owner-injected delivery transport. `AccountMail` includes `to`, `purpose`, raw single-use `token`, and an HTTPS `url` with fragment parameters. The included nodemailer SMTP factory is optional and owner configured; injection also supports alternative provider adapters. Do not log this object. Rejecting transport delivery produces a generic unavailable response; a token may have been sent despite a transport timeout. Tokens expire in 15 minutes and are SHA-256 hashed at rest. Public registration always requires email possession, independent of the self-service email-change flag.

The existing auth router installs the endpoints below automatically. The existing management router installs admin config and OIDC subject mapping beneath its mount point, using its existing authorization callback. Parent admin routing must forward these new paths; no public bootstrap route is added.

All mutating public endpoints require the existing `/csrf` prelogin cookie and `X-CSRF-Token`, except OIDC GET callback which requires single-use state and a browser-bound SameSite=Lax HttpOnly cookie. Authenticated mutations require the existing authenticated CSRF token; admin mutations require existing admin authorization/CSRF. All responses are no-store. Endpoint names below are relative to `/api/auth`:

- `GET /account/features`: public default-off capabilities.
- `GET /account`: own email, verification, MFA status and remaining recovery count only.
- `POST /account/register`: `{username,email,password,turnstileToken?}`; generic 202, sends confirmation; registered users can only have ordinary user role.
- `POST /account/register/complete`: `{token}`; single-use, verified email, no automatic login.
- `POST /account/email`: authenticated `{email}`; sends verification.
- `POST /account/email/complete`: authenticated `{token}`; token bound to that user. Replacing a verified email revokes previous reset links; reset links additionally bind the currently verified email.
- `POST /account/recovery`: `{email}`; generic 202 for unknown and known addresses.
- `POST /account/recovery/complete`: `{token,password}`; revokes sessions and outstanding user tokens. MFA is retained, never bypassed by password recovery.
- `POST /account/mfa/setup`: authenticated, returns temporary `{token,secret,uri}`. Secret must not be persisted in browser storage.
- `POST /account/mfa/enable`: authenticated `{token,code}`; returns ten recovery codes once, revokes all user sessions.
- `POST /account/mfa/verify`: prelogin CSRF plus `novel_mfa` cookie, `{code}`; consumes a fresh TOTP counter or one recovery code before issuing any authenticated session.
- `DELETE /account/mfa`: authenticated `{code}`; requires fresh TOTP/recovery proof, revokes sessions.
- `POST /account/oidc/start`: prelogin CSRF, returns `{url}` to navigate to provider.
- `GET /account/oidc/callback?state=...&code=...`: validates state/cookie, exchanges code with PKCE, uses jose remote JWKS verification restricted to RS256/PS256/ES256, exact issuer/audience/azp, nonce, expiry and iat. Returns session JSON or `{mfaRequired:true}` for JSON clients; an explicit Accept containing `text/html` instead receives a 303 redirect to `/account/complete?oidc=success`, `?oidc=mfa`, or sanitized `?oidc=failed`, removing the authorization code/state from the browser address. Parent must handle that completion route. No auto-registration and **no email-based account linking**.
- `GET/PUT /account/config`: admin only. Full config: `registration,emailVerification,passwordRecovery,mfa,publicOrigin,oidc`; OIDC object contains `enabled,issuer,clientId,authorizationEndpoint,tokenEndpoint,jwksUri,redirectUri,clientSecret?`. GET returns `hasClientSecret`, never the secret. HTTPS URLs required for enabled delivery/OIDC. Config changes invalidate outstanding extension tokens. MFA cannot be globally disabled while users have enrolled factors.
- `PUT /account/oidc/users/:id`: admin-only explicit `{issuer,subject}` link. This endpoint is available on the management router too.

Normal password login returns `{mfaRequired:true}` instead of an authenticated session for enrolled users. Parent AuthGate must retain prelogin CSRF, prompt for factor, and submit `/account/mfa/verify`. No business/tenant principal is created before successful second factor. Pending challenges are invalidated on password, disabled or role changes. Disabling MFA globally cannot bypass enrolled factors.

`AuthService.waitForIdle()` drains actual handler promises (including aborted HTTP's ongoing scrypt/mail/provider operations). Parent maintenance **must prevent new requests first**, then await this method before snapshotting. It is not itself an admission lock.

Dedicated `AccountSettings` and `AccountCompletion` frontend components take a parent-supplied existing API/CSRF request function. Parent must wire navigation/login/MFA/registration/recovery and admin config UI. Completion URLs use `/account/complete#purpose=...&token=...`; read then clear the fragment, never send tokens in logs or query strings. Email-change completion belongs to authenticated settings.

`AccountAccess` accepts `turnstile?: TurnstilePublicSettings` plus `renderChallenge?: (attempt: number, onToken: (token: string) => void) => ReactNode`; parent should reuse AuthGate's existing challenge implementation. Registration cannot submit without a challenge token when enabled. It chooses registration initially if recovery is unavailable. `AccountAdminSettings` takes the same request function and edits only default-off account settings.

## Verification and limitations

Offline tests exercise registration, verification/recovery replay and expiry, CSRF, persisted secret redaction, session revocation, MFA pending sessions/recovery replay, PKCE and signed OIDC JWT audience/nonce/state checks. No real SMTP/provider deployment was validated. OIDC endpoints are explicitly administrator configured, not discovery-selected; providers must support code+S256 and client-secret-post (or public PKCE clients). Standard OAuth without OIDC identity tokens is intentionally unsupported. HTTPS reverse-proxy deployment, upstream request admission for unauthenticated account endpoints, secure-cookie configuration, and end-to-end provider/UI acceptance remain parent integration responsibilities. This is not a claim of production/public-internet readiness.
