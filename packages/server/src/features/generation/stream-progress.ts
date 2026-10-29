/** Volatile preview only: never persist, publish or use as accepted generation output. */
export interface StreamProgressKey { scopeId: string; projectId: string; runId: string; stepId: string }
export type StreamRunKey = Omit<StreamProgressKey, 'stepId'>;
export interface StreamNodeProgress { stepId: string; text: string; truncated: boolean; updatedAt: string }
export interface StreamProgressSnapshot { runId: string; nodes: StreamNodeProgress[] }
interface Entry extends StreamNodeProgress { key: StreamProgressKey; touched: number; cleanup: () => void }
export function createStreamProgressStore(options: { maxTextChars?: number; maxEntries?: number; maxNodesPerRun?: number; ttlMs?: number; now?: () => number } = {}) {
  const maxText = options.maxTextChars ?? 128 * 1024;
  const maxEntries = options.maxEntries ?? 128;
  const maxNodes = options.maxNodesPerRun ?? 4;
  const ttl = options.ttlMs ?? 5 * 60_000;
  const now = options.now ?? Date.now;
  if (![maxText, maxEntries, maxNodes, ttl].every(v => Number.isSafeInteger(v) && v > 0)) throw new Error('Invalid stream progress bounds');
  const entries = new Map<string, Entry>();
  const idFor = (key: StreamProgressKey) => JSON.stringify([key.scopeId, key.projectId, key.runId, key.stepId]);
  const sameRun = (a: StreamRunKey, b: StreamRunKey) => a.scopeId === b.scopeId && a.projectId === b.projectId && a.runId === b.runId;
  const remove = (id: string) => { const entry = entries.get(id); if (entry) { entries.delete(id); entry.cleanup(); } };
  const prune = () => { const cutoff = now() - ttl; for (const [id, entry] of entries) if (entry.touched <= cutoff) remove(id); };
  const oldest = (filter: (entry: Entry) => boolean) => [...entries].filter(([, e]) => filter(e)).sort((a, b) => a[1].touched - b[1].touched)[0]?.[0];
  return {
    begin(key: StreamProgressKey, signal?: AbortSignal) {
      prune(); const id = idFor(key); remove(id);
      const noop = { append(_delta: string) {}, clear() {} };
      if (!key.scopeId || !key.projectId || !key.runId || !key.stepId || signal?.aborted) return noop;
      while ([...entries.values()].filter(e => sameRun(e.key, key)).length >= maxNodes) { const victim = oldest(e => sameRun(e.key, key)); if (!victim) break; remove(victim); }
      while (entries.size >= maxEntries) { const victim = oldest(() => true); if (!victim) break; remove(victim); }
      const entry: Entry = { key: { ...key }, stepId: key.stepId, text: '', truncated: false, touched: now(), updatedAt: new Date(now()).toISOString(), cleanup: () => {} };
      const clear = () => { if (entries.get(id) === entry) remove(id); };
      const abort = () => clear();
      entry.cleanup = () => signal?.removeEventListener('abort', abort);
      entries.set(id, entry); signal?.addEventListener('abort', abort, { once: true });
      return {
        append(delta: string) {
          prune();
          if (entries.get(id) !== entry || signal?.aborted || typeof delta !== 'string' || !delta) return;
          // Slice the incoming chunk before concatenating so a giant provider delta stays bounded.
          const combinedLength = entry.text.length + delta.length;
          entry.text = (entry.text + delta.slice(-maxText)).slice(-maxText);
          if (entry.text.length && /[\uDC00-\uDFFF]/.test(entry.text[0])) entry.text = entry.text.slice(1);
          entry.truncated ||= combinedLength > maxText;
          entry.touched = now(); entry.updatedAt = new Date(entry.touched).toISOString();
        },
        clear,
      };
    },
    snapshot(key: StreamRunKey): StreamProgressSnapshot {
      prune();
      return { runId: key.runId, nodes: [...entries.values()].filter(entry => sameRun(entry.key, key)).sort((a, b) => b.touched - a.touched).map(({ stepId, text, truncated, updatedAt }) => ({ stepId, text, truncated, updatedAt })) };
    },
    clearRun(key: StreamRunKey) { for (const [id, entry] of entries) if (sameRun(entry.key, key)) remove(id); },
  };
}
export const streamProgress = createStreamProgressStore();
