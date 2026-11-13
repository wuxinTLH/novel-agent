# Header / Footer and site appearance

[中文](../site-appearance.md) · [Permissions](roles-permissions.md) · [MIT License](../../LICENSE) · [Chinese translation](../../LICENSE.zh-CN.md)

`NavigationHeader` owns the application top bar, preserving breadcrumbs, language/theme controls and existing actions. `NavigationFooter` owns the global footer, separately from workflow-page action bars.

## Administration

Only super administrators and administrators receive the explicit `appearance.manage` permission. Role weights and hidden buttons are not authorization. Existing verified-session/local-loopback and CSRF checks remain enforced.

Header and Footer have independent background, text, accent and border colors, font sizes and vertical padding. Empty colors inherit the active theme; otherwise only `#RRGGBB` is accepted. Font sizes are 12–24 px and vertical padding is 0–32 px. Arbitrary CSS, HTML, scripts, URLs and font resources are not accepted. Administrators must still review contrast/readability in the preview.

The company name defaults to empty, omitting its copyright line, and is rendered as plain text when configured. The footer always includes `© SakuraMikku`, linked to <https://github.com/wuxinTLH/novel-agent> with `target="_blank"` and `rel="noopener noreferrer"`. This attribution is not a configuration field. Avoid colors that make it indistinguishable from the background; this does not prevent a host administrator from changing source code.

## Usage

1. Open Administration → Site appearance. With authentication enabled, use an administrator or super administrator; operations/writer accounts have no configuration entry.
2. Edit Header and Footer independently and inspect each preview. Leave colors empty or choose “Inherit theme”. Company name is optional, trimmed, limited to 120 characters and displayed as plain text.
3. “Save appearance” commits changes and updates the current page's global navigation. “Reset appearance” changes only the draft and still requires saving. Reload asks before discarding unsaved edits.
4. On a 409 conflict, preserve edits you need, reload and merge manually, without overwriting or replaying writes automatically. After session expiry/identity change, close and reopen Administration.

Theme selection is a browser-local preference; site appearance is application-global. Explicit navigation colors override corresponding theme colors; empty colors follow the theme. Review light/dark and narrow-screen readability, especially the fixed author link.

## API and persistence

- `GET /api/site-appearance`: public same-origin appearance read with no identity, tenant data or secrets. It does not expose other business APIs anonymously.
- `GET /api/admin/site-appearance`: authorized administrative read.
- `PUT /api/admin/site-appearance`: strict complete body `{ expectedRevision, companyName, header, footer }`, returning a direct `SiteAppearance` object.

Reads and successful writes use `Cache-Control: no-store`. Invalid requests return 400 `SITE_APPEARANCE_INVALID`; conflicts return 409 `SITE_APPEARANCE_CONFLICT`; unavailable storage returns 503 `SITE_APPEARANCE_UNAVAILABLE`. Both administrative methods require `appearance.manage`; writes retain existing administration/session CSRF credentials. The public endpoint permits GET/HEAD only, not writes or subpaths.

Both style objects contain `backgroundColor`, `textColor`, `accentColor`, `borderColor`, `fontSize`, `paddingY`. Defaults: version 1, revision 0, empty company/colors, font size 14 and padding 16. Revision conflicts return 409: reload and review manually, without silently overwriting another administrator's changes or automatically replaying a write.

This is application-global control-plane state in `DATA_DIR/site-appearance.json`, not per-project/tenant configuration or SQL business-document fallback. Single-instance writes use a temporary file, synchronous durability and rename; failed writes preserve the previous configuration. Corrupt configuration returns an error instead of silently becoming defaults. Preserve the control-plane file in backups/restores and follow the project's full-application backup and stopped-service restore rules.

## License

The English [LICENSE](../../LICENSE) is the MIT license, with `2026-2099 SakuraMikku` copyright. The [Chinese version](../../LICENSE.zh-CN.md) is a reference translation; the English text governs ambiguity. The year range does not promise future maintenance/service. Dependencies retain their own licenses.
