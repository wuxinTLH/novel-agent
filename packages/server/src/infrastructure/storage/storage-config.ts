import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { sqlConnectConfigSchema } from '../../../../../shared/sqlconnect.js';
import { bindDocumentStorage, type DocumentStorage } from './document-storage.js';
import { PostgresBridge } from './postgres-bridge.js';
import type { AuthPersistence } from '../../features/auth/auth.js';
import { storageConfigSchema, profileForOwner, type StorageConfig } from '../../../../../shared/storage.js';
import { PooledStorageBridge } from './pooled-storage-bridge.js';

export const GLOBAL_AUTH_OWNER = '00000000-0000-4000-8000-000000000001';
export function readStorageProfiles(dir: string): StorageConfig | null {
  try {
    return storageConfigSchema.parse(
      JSON.parse(fs.readFileSync(path.join(dir, 'storage-profiles.json'), 'utf8')),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('STORAGE_PROFILES_INVALID');
  }
}
export function writeStorageProfiles(dir: string, value: unknown): void {
  const config = storageConfigSchema.parse(value);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'storage-profiles.json');
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}
function bridgeForOwner(dir: string, ownerId: string): PostgresBridge | PooledStorageBridge {
  const manifest = readStorageManifest(dir);
  if (manifest?.version === 3) {
    const config = readStorageProfiles(dir);
    if (!config) throw new Error('STORAGE_PROFILES_REQUIRED');
    return new PooledStorageBridge(profileForOwner(config, ownerId).connection, ownerId);
  }
  return new PostgresBridge(readPostgresConfig(dir), ownerId);
}

const authModeSchema = z
  .object({ enabled: z.boolean(), legacyOwnerId: z.string().uuid().nullable() })
  .strict();
export function readAuthMode(dir: string) {
  try {
    return authModeSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, 'auth-enabled.json'), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { enabled: false, legacyOwnerId: null };
    throw new Error('AUTH_MODE_INVALID');
  }
}
export function createAuthPersistence(dir: string): AuthPersistence | undefined {
  if (!readStorageManifest(dir)) return undefined;
  let bridge: PostgresBridge | PooledStorageBridge | undefined;
  const storage = () => (bridge ??= bridgeForOwner(dir, GLOBAL_AUTH_OWNER));
  return {
    read() {
      const raw = storage().read('auth.json');
      return raw === null ? null : JSON.parse(raw);
    },
    write(value) {
      storage().write('auth.json', JSON.stringify(value));
    },
    async close() {
      if (bridge && 'close' in bridge) await bridge.close();
    },
  };
}

const manifestSchema = z.union([
  z
    .object({
      backend: z.literal('postgresql'),
      ownerId: z.string().uuid(),
      migrationHash: z.string().regex(/^[a-f0-9]{64}$/),
      version: z.literal(1),
    })
    .strict(),
  z
    .object({
      backend: z.literal('relational'),
      ownerId: z.string().uuid(),
      migrationHash: z.string().regex(/^[a-f0-9]{64}$/),
      version: z.literal(3),
    })
    .strict(),
]);
export type StorageManifest = z.infer<typeof manifestSchema>;
export const businessDocuments = [
  'projects.json',
  'models.json',
  'platform-connections.json',
  'publication-queue.json',
] as const;
export function readStorageManifest(dir: string): StorageManifest | null {
  const file = path.join(dir, 'business-storage.json');
  try {
    return manifestSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('BUSINESS_STORAGE_CONFIG_INVALID');
  }
}
export function readPostgresConfig(dir: string) {
  const config = sqlConnectConfigSchema.parse(
    JSON.parse(fs.readFileSync(path.join(dir, 'sqlconnect.json'), 'utf8')),
  );
  if (config.driver !== 'postgresql') throw new Error('BUSINESS_STORAGE_REQUIRES_POSTGRESQL');
  return config;
}
export function activateScopedStorage(
  root: string,
  scopeDir: string,
  ownerId?: string,
): { unbind: () => void; storage?: PostgresBridge | PooledStorageBridge } {
  const manifest = readStorageManifest(root);
  if (!manifest) return { unbind() {} };
  const storage = bridgeForOwner(root, ownerId ?? manifest.ownerId);
  // Verify connectivity without seeding or silently falling back to old JSON.
  try {
    storage.read('projects.json');
    const unbind = bindDocumentStorage(scopeDir, storage);
    return { unbind, storage };
  } catch (error) {
    if ('close' in storage) void storage.close().catch(() => {});
    throw error;
  }
}
