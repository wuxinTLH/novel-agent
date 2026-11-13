# Core runtime

The main process assembles one application-global site appearance store. Only exact GET/HEAD `/api/site-appearance` is public before authentication; Host/Origin/rate/security-header policies still apply. Admin GET/PUT requires `appearance.manage`, preserving CSRF. This is not tenant routing or anonymous business access. Keep `DATA_DIR/site-appearance.json` in full control-plane backups even with SQL business storage; see [site appearance](../../../../docs/en/site-appearance.md).

Application composition, HTTP policy, local runtime anchors, and feature registration. Tenant execution boundaries live in `tenancy/`.

[HTTP policy](http.ts) owns common protections, API 404 and sanitized error handling; [optional web hosting](web-hosting.ts) owns static output and SPA delivery. `SERVE_WEB=false` disables only the latter; default `true` and `WEB_DIST_DIR` configuration preserve integrated deployment. See the [deployment guide](../../../../docs/en/user-guide.md#separate-builds-and-same-origin-deployment) for same-origin `/api` and `/uploads` reverse proxying. Origin validation requires literal private IPv4 rather than DNS-name prefixes, and API guards match case-insensitive routing.

`CoreModel` accepts only `local` / `server` (unset: local; invalid: fail). Local binds only `127.0.0.1`; server binds `0.0.0.0`, requires offline-enabled auth, hardened/audit, exact HTTPS origin, independent >=32-character keys and gateway off behind a same-origin real TLS proxy. See [deployment modes](../../../../docs/en/deployment-modes.md).
