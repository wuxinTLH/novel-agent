import { useEffect, useSyncExternalStore } from 'react';
import type { SiteAppearance } from '../../../../../shared/site-appearance';
import { api } from '../../services/api';
import { isSiteAppearance } from './siteAppearance';
let current: SiteAppearance | undefined;
let started = false;
let generation = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => current;
export function publishSiteAppearance(value: SiteAppearance) {
  if (!isSiteAppearance(value)) return;
  generation++;
  current = value;
  listeners.forEach(listener => listener());
}
export function useSiteAppearance() {
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (started) return;
    started = true;
    const expected = generation;
    void api<unknown>('/site-appearance').then(result => {
      if (expected === generation && isSiteAppearance(result)) publishSiteAppearance(result);
    }).catch(() => { /* Network failure deliberately preserves the active theme and mandatory attribution. */ });
  }, []);
  return value;
}
