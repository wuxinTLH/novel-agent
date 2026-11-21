import fs from 'node:fs';
import { initDatabaseConfig, resolveInitDatabase } from './database.js';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SERVER_INIT_KEYS, serverInitCompleteSchema, type ServerInitConfig } from '../../../../../shared/server-init.js';
import { AuthService, type AuthDocument } from '../auth/auth.js';
import { createSmsTransport } from '../auth/sms-provider.js';
import { assertHardenedStartup } from '../../core/security-profile.js';
import { trustedPublicOrigin } from '../../core/trusted-origin.js';

const valuesSchema = z.record(z.enum(SERVER_INIT_KEYS), z.string().max(4096));
const configSchema = z.object({ version: z.literal(1), values: valuesSchema }).strict();
const artifacts = new Set(['.instance.lock', '.init-token']);
export const initJournal = '.init-journal.json';
function safeFile(file: string) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024) throw new Error('INIT_FILE_INVALID');
  return file;
}
function names(dir: string): string[] {
  // Inspect every existing ancestor before any lock/token write can traverse a link.
  let current = path.resolve(dir);
  for (;;) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('INIT_DIRECTORY_INVALID'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  try {
    if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw new Error('INIT_DIRECTORY_INVALID');
    return fs.readdirSync(dir);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
/** Read only: any unfamiliar file, even an empty config, preserves the old startup/CLI path. */
export function isFreshInitDirectory(dir: string): boolean {
  const entries = names(dir);
  if (entries.includes(initJournal)) throw new Error('INIT_RECOVERY_REQUIRED');
  return entries.every(name => artifacts.has(name));
}
export function assertInitRecoveryClear(dir: string) {
  if (names(dir).includes(initJournal)) throw new Error('INIT_RECOVERY_REQUIRED');
}
export function loadServerInitEnvironment(dir: string, env: NodeJS.ProcessEnv) {
  assertInitRecoveryClear(dir);
  const file = path.join(dir, 'server-init.json');
  let parsed: z.infer<typeof configSchema>;
  try { parsed = configSchema.parse(JSON.parse(fs.readFileSync(safeFile(file), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('SERVER_INIT_CONFIG_INVALID'); }
  for (const key of SERVER_INIT_KEYS) if (!env[key] && parsed.values[key]) env[key] = parsed.values[key];
}
/** Private control-plane file, exclusive temp, fsync, rename; never follows existing links. */
export function writeInitFile(dir: string, name: string, value: string | Buffer) {
  const file = path.join(dir, name);
  if (fs.existsSync(file)) throw new Error('INIT_TARGET_EXISTS');
  const temp = path.join(dir, '.init-' + randomUUID() + '.tmp');
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, value); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    if (process.platform !== 'win32') { const directory = fs.openSync(dir, 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); } }
  } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function validateInitTokenEnvironment(env: NodeJS.ProcessEnv) {
  if (env.NOVEL_INIT_TOKEN && (env.NOVEL_INIT_TOKEN.length < 32 || env.NOVEL_INIT_TOKEN.length > 4096 || /[\s\x00-\x1f\x7f]/.test(env.NOVEL_INIT_TOKEN))) throw new Error('INIT_TOKEN_INVALID');
}
export function initToken(dir: string, env: NodeJS.ProcessEnv): { token: string; generated: boolean } {
  validateInitTokenEnvironment(env);
  if (env.NOVEL_INIT_TOKEN) {
    return { token: env.NOVEL_INIT_TOKEN, generated: false };
  }
  const file = path.join(dir, '.init-token');
  let token: string;
  try { token = fs.readFileSync(safeFile(file), 'utf8').trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    token = randomBytes(32).toString('hex'); writeInitFile(dir, '.init-token', token + '\n');
  }
  if (token.length < 32 || token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(token)) throw new Error('INIT_TOKEN_INVALID');
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  return { token, generated: true };
}
export function initConfig(env: NodeJS.ProcessEnv): ServerInitConfig {
  return { database: initDatabaseConfig(env), fields: SERVER_INIT_KEYS.map(key => {
    const secret = /SECRETS_KEY|ACCESS_KEY|SECRET_ID|SECRET_KEY/.test(key);
    return { key, secret, configured: !!env[key], ...(!secret ? { value: env[key] || '' } : {}) };
  }) };
}
export function completeInitialization(dir: string, env: NodeJS.ProcessEnv, input: unknown) {
  if (!isFreshInitDirectory(dir)) throw new Error('INIT_ALREADY_COMPLETED');
  const request = serverInitCompleteSchema.parse(input);
  const database = resolveInitDatabase(env, request.database);
  const values: Record<string, string> = {};
  for (const key of SERVER_INIT_KEYS) values[key] = env[key] || request.values[key] || '';
  const config = configSchema.parse({ version: 1, values });
  const origin = trustedPublicOrigin(values.NOVEL_TRUSTED_PUBLIC_ORIGIN);
  assertHardenedStartup({ hardened: true, authEnabled: true, trustedOrigin: origin, gatewayEnabled: false,
    modelKey: values.MODEL_SECRETS_KEY, platformKey: values.PLATFORM_SECRETS_KEY });
  if (!createSmsTransport(values)) throw new Error('SERVER_SMS_PROVIDER_REQUIRED');
  // Reuse the exact server password/username/phone/bootstrap policy without any disk side effects.
  const key = randomBytes(32);
  let document: AuthDocument | undefined;
  const auth = new AuthService({ dataDir: dir, enabled: true, securityProfile: 'server', secretKey: key,
    persistence: { read: () => null, write: value => { document = value; } } });
  auth.bootstrapSuperadmin(request.username, request.password, request.phone);
  if (!document) throw new Error('INIT_AUTH_FAILED');
  writeInitFile(dir, initJournal, JSON.stringify({ version: 1, phase: 'committing' }));
  // Any error from here leaves the journal and permanently blocks business startup; no automatic replay.
  // Prospective v3 configuration only. No database connections, DDL, migration or manifest.
  if (database.mode === 'sql-later') writeInitFile(dir, 'storage-profiles.json', JSON.stringify({
    version: 3, defaultProfileId: 'init-default', profiles: [{ id: 'init-default', connection: database.connection }], ownerProfiles: [],
  }) + '\n');
  writeInitFile(dir, 'init-storage.json', JSON.stringify({ version: 1, mode: database.mode, activeBackend: 'local-json',
    schemaInitialized: false, sqlActivation: 'deferred-offline' }) + '\n');
  writeInitFile(dir, 'server-init.json', JSON.stringify(config) + '\n');
  writeInitFile(dir, 'auth.key', key);
  writeInitFile(dir, 'auth.json', JSON.stringify(document) + '\n');
  writeInitFile(dir, '.init-completed', '1\n');
  writeInitFile(dir, 'auth-enabled.json', JSON.stringify({ enabled: true, legacyOwnerId: null }) + '\n');
  fs.unlinkSync(path.join(dir, initJournal));
  if (process.platform !== 'win32') { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
}
