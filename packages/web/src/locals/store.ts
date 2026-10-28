import { DEFAULT_LOCALE, normalizeLocale, type Locale } from './core';

export const LOCALE_STORAGE_KEY = 'novel-locale';
type Listener = () => void;
type LocaleEnvironment = Pick<
  Window,
  'localStorage' | 'document' | 'addEventListener' | 'removeEventListener'
>;

/** Factory also permits isolated non-React tests. Each browser application uses the singleton below. */
export function createLocaleStore(
  environment: () => LocaleEnvironment | undefined = () =>
    typeof window === 'undefined' ? undefined : window,
) {
  let locale: Locale = DEFAULT_LOCALE;
  let initialized = false;
  let unsavedPreference = false;
  const listeners = new Set<Listener>();
  let stopListening: (() => void) | undefined;
  const updateLanguage = () => {
    const browser = environment();
    if (browser?.document?.documentElement) browser.document.documentElement.lang = locale;
  };
  const readStored = (): Locale | undefined => {
    try {
      return normalizeLocale(environment()?.localStorage.getItem(LOCALE_STORAGE_KEY));
    } catch {
      return undefined;
    }
  };
  const initialize = () => {
    if (initialized || !environment()) return;
    initialized = true;
    locale = readStored() ?? DEFAULT_LOCALE;
    updateLanguage();
  };
  const notify = () => {
    updateLanguage();
    for (const listener of listeners) listener();
  };
  const getSnapshot = (): Locale => {
    initialize();
    return locale;
  };
  const setLocale = (value: unknown) => {
    initialize();
    const next = normalizeLocale(value);
    const changed = next !== locale;
    locale = next;
    try {
      environment()?.localStorage.setItem(LOCALE_STORAGE_KEY, next);
      unsavedPreference = false;
    } catch {
      // Privacy mode / disabled storage: switching still works in memory, including remounts.
      unsavedPreference = true;
    }
    if (changed) notify();
    else updateLanguage();
  };
  const subscribe = (listener: Listener) => {
    initialize();
    listeners.add(listener);
    const browser = environment();
    if (browser && !stopListening) {
      const onStorage = (event: StorageEvent) => {
        if (event.key !== LOCALE_STORAGE_KEY && event.key !== null) return;
        try {
          if (event.storageArea && event.storageArea !== browser.localStorage) return;
        } catch {
          return;
        }
        const next = readStored();
        if (next !== undefined && next !== locale) {
          locale = next;
          notify();
        }
      };
      browser.addEventListener('storage', onStorage);
      stopListening = () => browser.removeEventListener('storage', onStorage);
      // Catch changes made by another tab while no subscriber was mounted. A failed write
      // must not roll back a user's current in-memory choice on a later component mount.
      const next = unsavedPreference ? undefined : readStored();
      if (next !== undefined && next !== locale) {
        locale = next;
        notify();
      }
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        stopListening?.();
        stopListening = undefined;
      }
    };
  };
  return { getSnapshot, setLocale, subscribe };
}

const localeStore = createLocaleStore();
export const getLocale = localeStore.getSnapshot;
export const setLocale = localeStore.setLocale;
export const subscribeLocale = localeStore.subscribe;
/** A constant snapshot avoids request-to-request locale leakage and hydration mismatch. */
export const getServerLocale = (): Locale => DEFAULT_LOCALE;
