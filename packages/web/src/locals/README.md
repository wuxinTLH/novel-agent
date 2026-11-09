# `locals/`: Chinese/English system interface

`zh-CN` is the default. Typed translation keys use the original Chinese source phrases. The `en` catalog has matching keys; unknown or missing entries fall back to Chinese, then the literal key. Fixed frontend copy is centralized in `dictionaries.ts`, composed from `app.ts`, `features.ts`, `identity.ts`, `account-platform.ts` and `runtime.ts`. A language selector alone is not proof of coverage: new visible strings must use these catalogs and pass static and browser checks.

```tsx
import { LanguageSwitcher, useLocale } from '../locals';

function Example() {
  const { locale, setLocale, t } = useLocale();
  return (
    <>
      <LanguageSwitcher />
      <p>{t('你好，{name}', { name: 'Alice' })}</p>
    </>
  );
}
```

`useLocale()` returns `{ locale, setLocale, t }`. `locale` is `'zh-CN' | 'en'`; `setLocale(value)` normalizes a string to a supported language and persists `novel-locale` in localStorage. Parent auth identity clearing should preserve this key. `t(key, params?)` accepts a typed Chinese dictionary key; `{name}` placeholders are interpolated without interpreting HTML. Missing placeholder values retain their original braces. For non-React callers and tests use `core.ts` (`normalizeLocale`, `interpolate`, `translate`, `createTranslator`, `dictionaries`) and `store.ts` (`getLocale`, `setLocale`, `subscribeLocale`) without importing the JSX/CSS barrel.

The locale store tolerates unavailable/denied browser storage, updates `document.documentElement.lang`, notifies same-tab subscribers, and listens for supported locale changes from other tabs. Browser language is normalized by `normalizeLocale` when supplied explicitly but is **not automatically selected**: without a saved preference the default remains Chinese. SSR uses the Chinese snapshot; on hydration, the saved browser setting is applied. Avoid interpolating untrusted strings into `dangerouslySetInnerHTML`.

To migrate a component, call `useLocale()` at component level, replace visible phrases with `t('原中文')`, add that phrase to both dictionaries, and check that markup, pluralization and placeholders work in both languages. Status messages originating from servers may need separate handling; do not automatically translate opaque server text.

## Coverage and data boundaries

The migration traverses the authoring shell and all ten main routes: novel/character/world workflows, assets, knowledge, manuscripts, settings, project settings, platforms and project library. Component coverage also includes generation/history/candidates, scheduling, document tools, account/authentication, administration/maintenance, database/model settings, confirmation dialogs, errors and accessibility labels. Runtime helpers resolve known fixed validation messages at call time, not at module initialization.

User-authored project/stage/workflow/node names, titles, manuscript text, prompts, model responses, identifiers and unknown backend errors are not rewritten or sent to translation services. Recognized built-in node defaults are translated only for display using exact canonical-value matching; persisted values and prompts remain unchanged. Known error codes and fixed messages have display mappings, while unknown diagnostics remain verbatim. A Chinese user title can therefore correctly remain visible in English mode.

## Regression checks

- `node scripts/audit-locale.mjs` prints hard violations and the complete classified manual-review inventory. `--json` emits machine-readable results; `--summary` reduces output. A hard violation exits nonzero.
- `node --import tsx --test packages/web/src/locals/*.test.ts` checks catalog parity, English values, interpolation, storage behavior and AST fixtures. The guard traverses frontend TS/TSX, checks visible text/attributes and literal translation calls, and does not blanket-ignore paths or line numbers.
- `node scripts/smoke-locale-coverage.mjs` exercises isolated production pages, dialogs, language reversal and mobile layout after a build. It must not use real author data, browser sessions, model endpoints or external publishing targets.

Static checks cannot prove every dynamic response is localized; review indirect configuration labels and validate actual rendered pages. Do not silently translate arbitrary business content merely to make a Han-character scan pass.

### Verified migration baseline

The completed migration passed root type checking and both production builds, 78 focused localization/editing/generation regressions, and 100 isolated browser checkpoints across the ten routes, dialogs, administration tabs, 390px viewports, reverse language switching and reload persistence. The browser report recorded zero untranslated-interface findings, horizontal-overflow failures, unexpected console errors, failed requests or attempted forbidden side effects. Optional Google Fonts CSP messages are recorded separately; CSP was not relaxed. Account login/binding-dependent and live generation-result states were not exercised by this browser fixture; component/static tests supplement those boundaries, not a claim of live-service acceptance.

The AST baseline covers 54 frontend source files and 1,906 literal translation calls with zero hard violations. Its 278 classified review items include data values, system-key lookup tables and dynamic keys: they are not silently ignored or asserted to be untranslated defects. Add tests when extending indirect rendering or confirmation options. Current merged catalogs contain 1,982 keys; this is a baseline, not a fixed capacity limit.

System-name display matching has a narrow ambiguity: an author deliberately choosing the exact canonical built-in workflow/theme name may see its translated display name. Stored names remain unchanged. Creation forms keep canonical defaults as data; changing the interface language does not rewrite saved names, prompts or request protocol values.

## Shell placement

In the authoring shell, `LanguageSwitcher` sits in the top bar immediately left of the theme control. Mode/account status is below the sidebar logo and permission-gated administration below the guide. Standalone authentication screens may render their own language selector. Placement does not change `novel-locale` or identity-cache preservation.

## Themed language menu

`LanguageSwitcher` uses a custom trigger button and `role="menu"` with `menuitemradio` buttons, not a native `<select>`. It shows 中文 / English and the current choice, focuses the selected option when opened, supports Up/Down and Home/End navigation, closes on Escape (restoring trigger focus), outside pointer input or focus leaving the widget, and restores trigger focus after selection. The trigger exposes `aria-haspopup`, `aria-expanded` and the open menu relationship.

`language-switcher.scss` uses semantic theme variables for the trigger, popup, focus and selected state; `public/themes/theme-mtf.css` adds scoped blue/pink/white menu treatments. This changes presentation, not the supported locales, persistence key or user-content translation boundary. Keyboard and visual acceptance should be checked in the browser; source inspection alone does not establish accessibility conformance.
