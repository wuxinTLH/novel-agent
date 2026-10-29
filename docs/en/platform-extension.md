# Platform capabilities and MV3 extension

[中文原文](../平台扩展.md) · [English index](README.md)

## Actual capability boundaries

Fanqie's backend browser supports human login, verified identity/work reads, bound-book drafts/full read-back/deletion and separately approved review submission with AI declaration and exact receipt. It fails closed on unexpected pages or identity. Submission is not public publishing. `publishChapter` remains false.

The MV3 extension supports **only pairing, capability inspection and revocation**, in unauthenticated single-user mode at `http://127.0.0.1:3001`. Its `accountVerified`, `listWorks`, `saveDraft`, `submitReview` and `publishChapter` are always false. Pairing or opening an author page is not verified identity. Authenticated multi-tenant mode returns `501 EXTENSION_AUTH_MODE_UNSUPPORTED`, including pairing creation; no unique extension-to-tenant runtime routing is implemented.

Qidian and Qimao are unavailable: no verified official author-management API, approved application or authorization materials exist here. Token/OAuth/work/draft/publish capabilities are false. Integration requires platform permission, application qualifications, formal APIs/auth/receipt contracts, minimum scopes and dedicated test accounts; do not guess endpoints. Mock operations prove local simulation only. Shared provider capability descriptions refer to backend conditions; extension session capabilities come from the bridge and cannot be promoted by a client.

## Install and pair

In Chrome/Edge/Chromium extension management, enable Developer mode → Load unpacked → select the directory containing [the manifest](../../extensions/platform-bridge/manifest.json). No package install or bundling is required. Copy the extension ID shown in the popup. It does not inject Fanqie scripts, read cookies, load remote code, auto-pair or schedule publishing.

Host permission `http://127.0.0.1/*` cannot express a port, but CSP connect-src and client code pin port 3001. A custom port requires changing both and reloading the extension; webpages cannot choose endpoints. `activeTab` is granted by user popup interaction. Short-lived credentials live in `storage.session` with TRUSTED_CONTEXTS, not local/sync; restart clears them and the popup never receives the token.

1. Open the single-user application at `http://127.0.0.1:3001`, select the project and open Fanqie → verify account → browser extension pairing.
2. Enter the exact extension ID and generate a pairing code. On a genuine `https://fanqienovel.com/main/…` author tab, open the popup, paste the 64-character challenge and explicitly approve. This selects a tab but does not verify login.
3. Return to the application, refresh extension approval, compare extension origin/ID and tab ID, check confirmation and approve. Incoming traffic alone is not sufficient evidence.
4. Return to the same popup and finish pairing, then inspect capabilities. Pairing succeeds but all remote business capabilities stay unavailable.
5. Disconnect/clear credentials in the popup, or revoke incomplete/interrupted pairing in the application. Never share codes/tokens/cookies or console output with outsiders.

Challenges expire in two minutes. Sessions last at most 30 minutes without renewal or project/origin transfer. The worker creates/stores its token before first finish; retry may recover a lost finish response with the **same** token, never substitute credentials. A lost claim response is not reliably recoverable: revoke and start a new pairing. Server restart, missing project, expiry, replacement or revocation invalidates credentials. Server stores hashes; application lists do not return the challenge.

## API reference

Ordinary application pairing endpoints are project-scoped and use existing session/origin/`X-Platform-CSRF` protection:

- `POST /api/projects/:projectId/platform-extension-pairings` with `{extensionId}` creates a code.
- `GET` on that collection reads pairing state for manual origin/tab inspection.
- `POST /api/projects/:projectId/platform-extension-pairings/:id/confirm` with `{}` records the application's independent confirmation.
- `DELETE /api/projects/:projectId/platform-extension-pairings/:id` revokes.

Bridge base `/api/platform-extension` accepts only the specified pending extension origin or the valid session's bound origin and fixed loopback Host. Cookies are rejected; POST requires strict JSON up to 4 KiB. Allowed origins have a 120-request/minute limit. Preflight allows GET/POST/DELETE and Authorization/Content-Type, not credentialed CORS.

| Method/path | Contract |
| --- | --- |
| `POST /claim` | `{challenge,tabId,approved:true}`, single claim. |
| `POST /finish` | `{pairingId,claimToken,token}`, only after both independent approvals; binds project/origin/tab. |
| `GET /session` | `Authorization: Bearer <64-character hex token>`. |
| `GET /capabilities` | Same authorization; honest false capabilities and unsupported reasons. |
| `DELETE /session` | Same authorization; revoke. |

Worker messages must originate from its exact same-extension popup URL. Webpages, content scripts, other extensions, extra fields and arbitrary destinations are rejected. No remote write route exists. Pairing tokens do not authorize normal business APIs and are not platform passwords/cookies.

## Verification and remaining work

```text
node --import tsx --test packages/server/src/features/platforms/extension-bridge.test.ts extensions/platform-bridge/protocol.test.mjs
npm run typecheck
```

Tests cover project/origin/token binding, dual confirmation, expiry/replay/revocation, bounded input, Cookie/Host/message rejection and absence of publish routes. Local protocol/HTTP tests do not prove Chrome Web Store review, actual browser popup lifecycle, current author-site DOM or platform authorization. Real extension installation and real account workflows require manual acceptance; historical backend browser success does not prove extension functionality.

SQL testing/schema preparation is independent from v3 activation; real vendor databases remain separate acceptance work. Platform account locks coordinate tenants only within one application instance, not other hosts, other apps or official-dashboard edits. See [SQLconnect](../sqlconnect.md) and [platform module](../../packages/server/src/features/platforms/README.md).
