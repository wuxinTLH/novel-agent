import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { sqlConnectConfigSchema } from '../../shared/sqlconnect.js';
import { bindDocumentStorage, type DocumentStorage } from './document-storage.js';
import { PostgresBridge } from './postgres-bridge.js';
import type { AuthPersistence } from './auth.js';

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
  const bridge = new PostgresBridge(readPostgresConfig(dir), '00000000-0000-4000-8000-000000000001');
  return {
    read() {
      const raw = bridge.read('auth.json');
      return raw === null ? null : JSON.parse(raw);
    },
    write(value) {
      bridge.write('auth.json', JSON.stringify(value));
    },
  };
}

const manifestSchema = z
  .object({
    backend: z.literal('postgresql'),
    ownerId: z.string().uuid(),
    migrationHash: z.string().regex(/^[a-f0-9]{64}$/),
    version: z.literal(1),
  })
  .strict();
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
): { unbind: () => void; storage?: PostgresBridge } {
  const manifest = readStorageManifest(root);
  if (!manifest) return { unbind() {} };
  const storage = new PostgresBridge(readPostgresConfig(root), ownerId ?? manifest.ownerId);
  // Verify connectivity without seeding or silently falling back to old JSON.
  storage.read('projects.json');
  const unbind = bindDocumentStorage(scopeDir, storage);
  return { unbind, storage };
}
