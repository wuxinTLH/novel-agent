import { interpolate, type InterpolationValues, type Translator } from './core';
import { getLocale } from './store';
import { runtimeEn, runtimeZhCN } from './runtime';

/** Resolve fixed runtime messages at call time; dynamic data and server errors stay untouched. */
export function runtimeT(key: keyof typeof runtimeZhCN, values?: InterpolationValues): string {
  return interpolate(getLocale() === 'en' ? runtimeEn[key] : runtimeZhCN[key], values);
}

/** Translate only recognized fixed validation messages, never user text or arbitrary errors. */
export function runtimeMessage(message: string): string {
  return Object.prototype.hasOwnProperty.call(runtimeZhCN, message)
    ? runtimeT(message as keyof typeof runtimeZhCN)
    : message;
}

/** Backward-compatible Chinese default for helpers whose caller may supply a UI translator. */
export const runtimeChineseT = ((key: string, values?: InterpolationValues) =>
  interpolate(key, values)) as Translator;
