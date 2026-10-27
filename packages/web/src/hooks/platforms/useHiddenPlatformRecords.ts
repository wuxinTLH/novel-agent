import { useState } from 'react';

/** Presentation-only cleanup. Never changes server operations or deduplication. */
export function useHiddenPlatformRecords(projectId: string, scope: string) {
  const key = `platform-hidden:${projectId}:${scope}`;
  const [stored, setStored] = useState<{ key: string; ids: string[] }>(() => ({ key, ids: load(key) }));
  const ids = stored.key === key ? stored.ids : load(key);
  const save = (next: string[]) => {
    setStored({ key, ids: next });
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Session-only cleanup remains available. */ }
  };
  return { hiddenIds: ids, hide: (id: string) => save([...new Set([...ids, id])]), show: (id: string) => save(ids.filter(value => value !== id)), restore: () => save([]) };
}
function load(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
}
