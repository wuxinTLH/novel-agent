import { useMemo, useSyncExternalStore } from 'react';
import { createTranslator } from './core';
import { getLocale, getServerLocale, setLocale, subscribeLocale } from './store';

export function useLocale() {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getServerLocale);
  const t = useMemo(() => createTranslator(locale), [locale]);
  return { locale, setLocale, t };
}
