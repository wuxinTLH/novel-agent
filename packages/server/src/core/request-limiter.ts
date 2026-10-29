interface Window { count: number; expires: number }
/** Fixed windows bound both per-client work and retained identities, including rejected requests. */
export function createRequestLimiter({ limit = 240, windowMs = 60_000, maxClients = 4096, now = Date.now } = {}) {
  const clients = new Map<string, Window>();
  let nextSweep = 0;
  return {
    check(key: string): { allowed: boolean; retryAfter: number } {
      const time = now();
      if (time >= nextSweep) {
        for (const [client, window] of clients) if (window.expires <= time) clients.delete(client);
        nextSweep = time + Math.min(windowMs, 1000);
      }
      let window = clients.get(key);
      if (window && window.expires <= time) { clients.delete(key); window = undefined; }
      if (!window) {
        // Do not evict active clients: rotating identities must not reset existing quotas.
        if (clients.size >= maxClients) return { allowed: false, retryAfter: Math.ceil(windowMs / 1000) };
        window = { count: 0, expires: time + windowMs };
        clients.set(key, window);
      }
      const retryAfter = Math.max(1, Math.ceil((window.expires - time) / 1000));
      if (window.count >= limit) return { allowed: false, retryAfter };
      window.count++;
      return { allowed: true, retryAfter: 0 };
    },
    get size() { return clients.size; },
  };
}
