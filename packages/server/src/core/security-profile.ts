import type { Server } from 'node:http';
import { readCoreModel } from './core-model.js';
import { trustedPublicOrigin } from './trusted-origin.js';

export function readSecurityProfile(env: NodeJS.ProcessEnv) {
  const coreModel = readCoreModel(env);
  const profile = env.SECURITY_PROFILE ?? (coreModel === 'server' ? 'hardened' : 'standard');
  if (env.SECURITY_AUDIT !== undefined && !['true', 'false'].includes(env.SECURITY_AUDIT)) throw new Error('SECURITY_AUDIT_INVALID');
  if (!['standard', 'hardened'].includes(profile)) throw new Error('SECURITY_PROFILE_INVALID');
  if (coreModel === 'server' && profile !== 'hardened') throw new Error('SERVER_SECURITY_PROFILE_CONFLICT');
  if (coreModel === 'server' && env.SECURITY_AUDIT === 'false') throw new Error('SERVER_SECURITY_AUDIT_CONFLICT');
  return { hardened: profile === 'hardened', audit: env.SECURITY_AUDIT === 'true' || profile === 'hardened' };
}
export function assertHardenedStartup(options: { hardened: boolean; authEnabled: boolean; trustedOrigin?: string; gatewayEnabled: boolean; modelKey?: string; platformKey?: string }) {
  if (!options.hardened) return;
  if (!options.authEnabled) throw new Error('HARDENED_AUTH_REQUIRED');
  try {
    if (!options.trustedOrigin || !trustedPublicOrigin(options.trustedOrigin)) throw new Error();
  } catch {
    throw new Error('HARDENED_HTTPS_ORIGIN_REQUIRED');
  }
  if (options.gatewayEnabled) throw new Error('HARDENED_GATEWAY_FORBIDDEN');
  if (!options.modelKey || options.modelKey.length < 32 || !options.platformKey || options.platformKey.length < 32 || options.modelKey === options.platformKey) throw new Error('HARDENED_DISTINCT_SECRET_KEYS_REQUIRED');
}
/** Bound parsing and idle resources without imposing a short timeout on SSE/model responses. */
export function configureHttpServer(server: Server) {
  server.headersTimeout = 15_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 1000;
}
