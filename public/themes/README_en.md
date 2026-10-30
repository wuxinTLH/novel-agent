# Theme Resources

[中文](README.md) | English

The registry is served at `/themes/themes.json`. CSS in this directory is published as static resources: adding a palette does not require modifying application components or recompiling Sass.

## Registry format (version 1)

```json
{
  "version": 1,
  "defaultTheme": "theme-system",
  "themes": [
    { "id": "theme-system", "name": "跟随系统", "css": "theme-system.css" },
    { "id": "theme-light", "name": "极简白", "css": "theme-light.css" },
    { "id": "theme-dark", "name": "极简黑", "css": "theme-dark.css" },
    { "id": "theme-mtf", "name": "蓝粉白", "css": "theme-mtf.css" }
  ]
}
```

- `version`: numeric registry version, currently `1`.
- `defaultTheme`: an ID present in `themes`.
- `themes`: menu display order; 1–100 entries. Any invalid entry rejects the whole registry.
- `id`: unique, stable `theme-xxx` identifier, also the full root `data-theme` value.
- `name`: display label, which may be Chinese; at most 80 characters before trimming and nonempty after trimming. Current labels mean follow system, minimal white, minimal black and blue/pink/white.
- `css`: a CSS filename in this directory, not an arbitrary URL or path; must match `^theme-[a-z0-9]+(?:-[a-z0-9]+)*\.css$`.

## Adding a theme

1. Add a separate CSS file here, such as `theme-ocean.css`.
2. Define the complete semantic variables under `:root[data-theme='theme-ocean']`. Follow existing palettes for `color-scheme`, background, text, panels, surfaces, borders, muted text, accents, focus and overlays. `--muted` aliases `--muted-text`.
3. Scope component exceptions too, for example `:root[data-theme='theme-ocean'] select`. Do not add unconditional `:root`, `body` or component rules: already-loaded styles must not leak into another theme after switching.
4. Append `{ "id": "theme-ocean", "name": "海洋蓝", "css": "theme-ocean.css" }` to `themes` in `themes.json`. Change `defaultTheme` if desired.
5. Click the theme menu's reload action. Entries appear in registry order. Check explicit light/dark themes, system preference changes and absence of leftover styles after switching. Failed switching retains the current theme; initial loading failure uses the main stylesheet's light fallback.

Development reads this source directory directly. `npm run build:web` (or a full build) copies it to `dist/themes`. Default integrated hosting serves these resources; with `WEB_DIST_DIR`, deploy complete web output including `themes/` there. Backend `SERVE_WEB=false` serves no themes: the separate static server must serve same-origin `/themes/` with appropriate CSP/security headers and proxy only `/api` and `/uploads` to the backend. After updating the deployed resources, use the reload action; changing source files alone still requires building and deploying and cannot update an existing deployment automatically.

`packages/web/src/lib/themes/themes-load.ts` provides `themesLoad`, registry validation and concurrency-safe switching. Legacy saved values `system/light/dark/mtf` migrate to `theme-xxx`. Removed or unknown selections fall back to `defaultTheme`. Invalid registries do not replace the current list or appearance. CSS is trusted local content; do not register unreviewed third-party styles.

## Bundled resources and scope

- `theme-light.css`: minimal white palette and the light basis for `theme-system`.
- `theme-dark.css`: minimal black palette, dark dropdown arrows and menu exceptions. Only `theme-system` rules inside `@media (prefers-color-scheme: dark)` follow the system; explicit `theme-dark` ignores system preference.
- `theme-system.css`: local `@import` of light then dark resources, avoiding duplicate palette maintenance. Imported rules retain complete theme-ID scope; CSS responds to system preference changes immediately.
- `theme-mtf.css`: blue/pink/white background and panel gradients, plus selected theme-menu gradients.
- Application styles retain only light semantic fallbacks and shared layout/interactions. Resource selectors are more specific than unconditional root fallbacks, so correctness does not depend on stylesheet insertion order.

The language selector is a custom button/menu using `menuitemradio`, not a native select. Its base styling consumes semantic theme variables; blue/pink/white adds theme-scoped trigger, popup and selected-item treatments. Preserve readable focus/hover/selected states when customizing menus, without changing locale persistence or suggesting that all application text is translated.

Local `@import` may share resources, but every complete theme ID must stay isolated. Do not use legacy `light`, `dark`, `system` or `mtf` as `data-theme` values. These instructions describe source behavior; visual browser, accessibility and deployed-resource acceptance must be checked separately.
