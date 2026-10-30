# Core runtime

Application composition, HTTP policy, local runtime anchors, and feature registration. Tenant execution boundaries live in `tenancy/`.

[HTTP policy](http.ts) owns common protections, API 404 and sanitized error handling; [optional web hosting](web-hosting.ts) owns static output and SPA delivery. `SERVE_WEB=false` disables only the latter; default `true` and `WEB_DIST_DIR` configuration preserve integrated deployment. See the [deployment guide](../../../../docs/en/user-guide.md#separate-builds-and-same-origin-deployment) for same-origin `/api` and `/uploads` reverse proxying. Origin validation requires literal private IPv4 rather than DNS-name prefixes, and API guards match case-insensitive routing.
