# `locals/`: partial Chinese/English localization

`zh-CN` is the default. The typed translation keys are the original Chinese source phrases, which lets existing components opt in one phrase at a time. The `en` catalog has matching keys; unknown or missing English entries fall back to Chinese, then the literal key. **This is partial adoption:** adding dictionaries and a language selector does not translate components until their visible phrases are wrapped with `t(...)`. Do not describe the entire app as translated.

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

## Themed language menu

`LanguageSwitcher` uses a custom trigger button and `role="menu"` with `menuitemradio` buttons, not a native `<select>`. It shows 中文 / English and the current choice, focuses the selected option when opened, supports Up/Down and Home/End navigation, closes on Escape (restoring trigger focus), outside pointer input or focus leaving the widget, and restores trigger focus after selection. The trigger exposes `aria-haspopup`, `aria-expanded` and the open menu relationship.

`language-switcher.scss` uses semantic theme variables for the trigger, popup, focus and selected state; `public/themes/theme-mtf.css` adds scoped blue/pink/white menu treatments. This changes presentation, not the supported locales, persistence key or partial-translation boundary. Keyboard and visual acceptance should be checked in the browser; source inspection alone does not establish accessibility conformance.
