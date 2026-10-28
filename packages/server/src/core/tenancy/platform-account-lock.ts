import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isMainThread, type MessagePort, type Worker } from 'node:worker_threads';

/** Single-process only. Identities must come from server-verified connections, never HTTP lock keys. */
export interface PlatformAccountLockScope { providerId: string; accountId?: string }
export type PlatformAccountLease = () => void | Promise<void>;
export interface PlatformAccountLockClient {
  acquire(scope: PlatformAccountLockScope): Promise<PlatformAccountLease>;
}
export class PlatformAccountLockError extends Error {
  constructor(readonly code: 'PLATFORM_BUSY' | 'PLATFORM_LOCK_UNAVAILABLE') {
    super(code === 'PLATFORM_BUSY' ? '平台账号正在执行其他操作，请稍后重试。' : '平台账号安全锁不可用；未执行外部操作。');
  }
}
export interface PlatformAccountLockCredentials { capability: string; identityKey: string }
const protocol = 'platform-account-lock-v1';
interface Request { type: typeof protocol; capability: string; requestId: string; action: 'acquire' | 'release'; providerId?: string; account?: string; leaseId?: string }
interface Reply { type: typeof protocol; requestId: string; leaseId?: string; code?: 'PLATFORM_BUSY' | 'PLATFORM_LOCK_UNAVAILABLE' }
function opaque(key: string, scope: PlatformAccountLockScope) {
  if (!scope.providerId || scope.providerId.length > 100 || (scope.accountId !== undefined && !scope.accountId.trim()))
    throw new PlatformAccountLockError('PLATFORM_LOCK_UNAVAILABLE');
  return { providerId: scope.providerId, account: scope.accountId === undefined ? undefined : createHmac('sha256', key).update(JSON.stringify([scope.providerId, scope.accountId])).digest('hex') };
}

/** No TTL: cancellation/disconnection does not prove a browser side effect has settled. */
export class PlatformAccountLockCoordinator {
  private readonly identityKey = randomBytes(32).toString('hex');
  private readonly leases = new Map<string, { owner: object; providerId: string; account?: string }>();
  private readonly bound = new WeakSet<object>();
  credentials(): PlatformAccountLockCredentials { return { capability: randomBytes(32).toString('hex'), identityKey: this.identityKey }; }
  private take(owner: object, providerId: string, account?: string): string {
    for (const held of this.leases.values()) {
      if (held.providerId === providerId && (account === undefined || held.account === undefined || held.account === account))
        throw new PlatformAccountLockError('PLATFORM_BUSY');
    }
    const id = randomUUID();
    this.leases.set(id, { owner, providerId, account });
    return id;
  }
  private release(owner: object, id: string) {
    if (this.leases.get(id)?.owner === owner) this.leases.delete(id);
  }
  localClient(): PlatformAccountLockClient {
    const owner = {};
    return { acquire: async scope => {
      const key = opaque(this.identityKey, scope);
      const id = this.take(owner, key.providerId, key.account);
      return () => this.release(owner, id);
    } };
  }
  /** Bind immediately after constructing Worker, before its first message. Never clean up on 'error'. */
  bindWorker(worker: Worker, credentials: PlatformAccountLockCredentials): void {
    if (!isMainThread || this.bound.has(worker) || credentials.identityKey !== this.identityKey)
      throw new PlatformAccountLockError('PLATFORM_LOCK_UNAVAILABLE');
    this.bound.add(worker);
    const owner = {};
    const listener = (input: unknown) => {
      if (!input || typeof input !== 'object' || (input as Request).type !== protocol) return;
      const message = input as Request;
      if (typeof message.capability !== 'string' || typeof message.requestId !== 'string' || message.requestId.length > 100) return;
      const actual = Buffer.from(message.capability), expected = Buffer.from(credentials.capability);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return;
      const reply: Reply = { type: protocol, requestId: message.requestId };
      try {
        if (message.action === 'acquire') {
          if (typeof message.providerId !== 'string' || !message.providerId || message.providerId.length > 100 ||
            (message.account !== undefined && !/^[a-f0-9]{64}$/.test(message.account)))
            throw new PlatformAccountLockError('PLATFORM_LOCK_UNAVAILABLE');
          reply.leaseId = this.take(owner, message.providerId, message.account);
        } else if (message.action === 'release' && typeof message.leaseId === 'string') this.release(owner, message.leaseId);
        else throw new PlatformAccountLockError('PLATFORM_LOCK_UNAVAILABLE');
      } catch (error) { reply.code = error instanceof PlatformAccountLockError ? error.code : 'PLATFORM_LOCK_UNAVAILABLE'; }
      // If delivery fails retain ownership until exit: the operation may already be running.
      try { worker.postMessage(reply); } catch { /* fail closed */ }
    };
    worker.on('message', listener);
    worker.once('exit', () => {
      worker.off('message', listener);
      for (const [id, held] of this.leases) if (held.owner === owner) this.leases.delete(id);
    });
  }
}

export function createWorkerPlatformAccountLockClient(port: MessagePort, credentials: PlatformAccountLockCredentials, timeoutMs = 10_000): PlatformAccountLockClient {
  const pending = new Map<string, { resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let available = true;
  const request = (body: Omit<Request, 'type' | 'capability' | 'requestId'>): Promise<Reply> => {
    if (!available) return Promise.reject(new PlatformAccountLockError('PLATFORM_LOCK_UNAVAILABLE'));
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => { pending.delete(requestId); reject(new PlatformAccountLockError('PLATFORM_LOCK_UNAVAILABLE')); }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      try { port.postMessage({ ...body, type: protocol, capability: credentials.capability, requestId }); }
      catch { clearTimeout(timer); pending.delete(requestId); reject(new PlatformAccountLockError('PLATFORM_LOCK_UNAVAILABLE')); }
    });
  };
  port.on('message', (input: unknown) => {
    if (!input || typeof input !== 'object' || (input as Reply).type !== protocol) return;
    const reply = input as Reply;
    const item = pending.get(reply.requestId);
    if (!item) {
      // Late grant after timeout: no operation ran, so releasing this specific grant is safe.
      if (reply.leaseId) void request({ action: 'release', leaseId: reply.leaseId }).catch(() => {});
      return;
    }
    clearTimeout(item.timer); pending.delete(reply.requestId);
    if (reply.code) item.reject(new PlatformAccountLockError(reply.code)); else item.resolve(reply);
  });
  port.once('close', () => {
    available = false;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new PlatformAccountLockError('PLATFORM_LOCK_UNAVAILABLE')); }
    pending.clear();
  });
  return { acquire: async scope => {
    const key = opaque(credentials.identityKey, scope);
    const reply = await request({ action: 'acquire', ...key });
    if (!reply.leaseId) throw new PlatformAccountLockError('PLATFORM_LOCK_UNAVAILABLE');
    let released = false;
    return async () => { if (!released) { released = true; await request({ action: 'release', leaseId: reply.leaseId }); } };
  } };
}

let installed: PlatformAccountLockClient | undefined;
const singleton = isMainThread ? new PlatformAccountLockCoordinator() : undefined;
/** Call before constructing any worker runtime. Do not dispose until all operations/browser contexts settle. */
export function installPlatformAccountLockClient(client: PlatformAccountLockClient): void { installed = client; }
export function defaultPlatformAccountLockClient(): PlatformAccountLockClient {
  return installed ?? singleton?.localClient() ?? { acquire: async () => { throw new PlatformAccountLockError('PLATFORM_LOCK_UNAVAILABLE'); } };
}
export function mainPlatformAccountLockCoordinator(): PlatformAccountLockCoordinator {
  if (!singleton) throw new PlatformAccountLockError('PLATFORM_LOCK_UNAVAILABLE');
  return singleton;
}
