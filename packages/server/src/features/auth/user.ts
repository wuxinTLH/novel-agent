import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Request, RequestHandler } from 'express';

export interface UserPrincipal {
  /** Internal stable identity returned by a verified authentication provider, never a request header. */
  id: string;
}
export interface UserScope {
  userId: string;
  dataDir: string;
  mode: 'local' | 'user';
}
export type VerifyPrincipal = (request: Request) => Promise<UserPrincipal | null>;

/**
 * Dormant identity boundary. All per-user stores (projects/assets, model secrets,
 * platform credentials/bindings and publication queues) must share this directory.
 * It deliberately does not provide a login endpoint or trust a userId from the client.
 */
export class UserService {
  readonly enabled: boolean;
  private readonly baseDir: string;
  constructor(dataDir: string, private readonly verify?: VerifyPrincipal) {
    this.baseDir = path.resolve(dataDir);
    this.enabled = !!verify;
  }
  status() {
    return {
      id: 'User', enabled: this.enabled,
      mode: this.enabled ? 'verified-user' : 'local',
      authenticationReady: this.enabled,
    };
  }
  localScope(): UserScope {
    if (this.enabled) throw new Error('USER_SCOPE_REQUIRED');
    return { userId: 'local', dataDir: this.baseDir, mode: 'local' };
  }
  private scopeFor(principal: UserPrincipal): UserScope {
    if (typeof principal.id !== 'string' || !principal.id.trim() || principal.id.length > 512) {
      throw new Error('USER_IDENTITY_INVALID');
    }
    const key = createHash('sha256').update(principal.id).digest('hex');
    return { userId: principal.id, dataDir: path.join(this.baseDir, 'users', key), mode: 'user' };
  }
  async resolve(request: Request): Promise<UserScope> {
    if (!this.verify) return this.localScope();
    const principal = await this.verify(request);
    if (!principal) throw new Error('USER_AUTHENTICATION_REQUIRED');
    return this.scopeFor(principal);
  }
  /** Only status is registered today. Enabling multi-user HTTP requires scoped runtimes, not a flag. */
  readonly statusHandler: RequestHandler = (_request, response) => { response.json(this.status()); };
}
