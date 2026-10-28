import { dictionaries, type Dictionary, type TranslationKey } from './dictionaries';

export { dictionaries, en, zhCN, type Dictionary, type TranslationKey } from './dictionaries';
export const SUPPORTED_LOCALES = ['zh-CN', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'zh-CN';
export type InterpolationValues = Readonly<Record<string, string | number>>;
export type Translator = (key: TranslationKey, values?: InterpolationValues) => string;

/** Normalize browser language tags, including older underscore-form tags. Unknowns use Chinese. */
export function normalizeLocale(value: unknown): Locale {
  if (typeof value !== 'string') return DEFAULT_LOCALE;
  const tag = value.trim().replace(/_/g, '-');
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(tag)) return DEFAULT_LOCALE;
  const language = tag.split('-')[0].toLowerCase();
  return language === 'en' ? 'en' : DEFAULT_LOCALE;
}

/** Missing values are deliberately left visible; replacement values are never interpreted as code. */
export function interpolate(template: string, values: InterpolationValues = {}): string {
  return template.replace(/\{([a-zA-Z_][\w]*)\}/g, (match: string, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
  );
}

/** Runtime-safe for external/older keys as well as the typed React translator. */
export function translate(
  locale: unknown,
  key: string,
  values?: InterpolationValues,
  dictionary: Partial<Dictionary> = dictionaries[normalizeLocale(locale)],
): string {
  const own = (object: object, name: string): unknown =>
    Object.prototype.hasOwnProperty.call(object, name)
      ? (object as Record<string, unknown>)[name]
      : undefined;
  const translation = own(dictionary, key);
  const chinese = own(dictionaries['zh-CN'], key);
  return interpolate(
    typeof translation === 'string' && translation.length > 0
      ? translation
      : typeof chinese === 'string'
        ? chinese
        : key,
    values,
  );
}

export function createTranslator(locale: unknown): Translator {
  return (key, values) => translate(locale, key, values);
}
