import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID, createDecipheriv } from 'node:crypto';
import { z } from 'zod';
import { acquireDataLock } from '../../core/local-runtime.js';
import { businessDocuments } from '../../infrastructure/storage/storage-config.js';
import { migrateProjects } from '../projects/store.js';
import { PlatformStore } from '../platforms/platform-store.js';
import { PublicationQueue } from '../platforms/publication-queue.js';
import os from 'node:os';
import { storageConfigSchema, profileForOwner } from '../../../../../shared/storage.js';
import { sqlConnectConfigSchema } from '../../../../../shared/sqlconnect.js';

export const GLOBAL_AUTH_OWNER = '00000000-0000-4000-8000-000000000001';
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const snapshotSchema = z
  .object({
    version: z.literal(3),
    owners: z.array(
      z
        .object({
          ownerId: z.string().min(1).max(64),
          revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          documents: z.array(
            z
              .object({
                key: z.string().min(1).max(255),
                content: z.string(),
                revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
              })
              .strict(),
          ),
          receipts: z.array(
            z
              .object({ sourceHash: z.string().min(1).max(128), documentCount: z.number().int().positive() })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();
export type MaintenanceSnapshot = z.infer<typeof snapshotSchema>;
/** Explicitly selected targets only. Never construct connections from an untrusted backup. */
export interface MaintenanceBackend {
  profileIds: readonly string[];
  exportSnapshot(profileId: string): Promise<MaintenanceSnapshot>;
  /** Must check the entire target, including owners, receipts and documents; no writes. */
  assertEmpty(profileId: string): Promise<void>;
  /** Atomic, conflict-refusing import preserving revisions and receipts. */
  importSnapshot(profileId: string, snapshot: MaintenanceSnapshot): Promise<void>;
}
export interface MaintenanceBase {
  dataDir: string;
  /** Acknowledges ALL processes sharing ANY selected SQL database have stopped. */
  runtimeStopped: true;
  backend?: MaintenanceBackend;
}
const entrySchema = z
  .object({
    path: z.string(),
    type: z.enum(['file', 'directory']),
    size: z.number().int().nonnegative(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
const manifestSchema = z
  .object({
    format: z.literal('novel-agent-full-backup'),
    version: z.literal(2),
    backupId: z.string().uuid(),
    createdAt: z.string().datetime(),
    complete: z.literal(true),
    consistency: z.literal('offline-all-runtimes-stopped'),
    exclusions: z.array(z.string()),
    entries: z.array(entrySchema),
    sql: z.array(
      z
        .object({
          profileId: z.string().min(1),
          path: z.string(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
    externalKeys: z.array(z.enum(['MODEL_SECRETS_KEY', 'PLATFORM_SECRETS_KEY'])),
  })
  .strict();
export type FullBackupManifest = z.infer<typeof manifestSchema>;
const excluded = new Set([
  '.instance.lock',
  '.instance.lock.recovery',
  'admin-backups',
  '.maintenance-journal.json',
]);
const uuid = z.string().uuid();
function check(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
function stopped(options: MaintenanceBase) {
  check(options.runtimeStopped === true, 'MAINTENANCE_OFFLINE_REQUIRED');
}
function inside(parent: string, child: string) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function unrelated(a: string, b: string) {
  check(!inside(a, b) && !inside(b, a), 'MAINTENANCE_PATH_OVERLAP');
}
function safeAncestors(directory: string) {
  let current = path.resolve(directory);
  for (;;) {
    try {
      const stat = fs.lstatSync(current);
      check(stat.isDirectory() && !stat.isSymbolicLink(), 'MAINTENANCE_UNSAFE_DIRECTORY');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function safeRelative(name: string) {
  check(
    name.length > 0 &&
      name.length <= 4096 &&
      !name.includes('\\') &&
      !name.includes('\0') &&
      !path.posix.isAbsolute(name),
    'MAINTENANCE_UNSAFE_PATH',
  );
  for (const component of name.split('/')) {
    check(
      component !== '' &&
        component !== '.' &&
        component !== '..' &&
        !/[<>:"|?*\x00-\x1f]/.test(component) &&
        !/[. ]$/.test(component) &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component),
      'MAINTENANCE_UNSAFE_PATH',
    );
  }
}
function privateWrite(file: string, bytes: string | Buffer) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function atomicJson(file: string, value: unknown) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    privateWrite(temporary, JSON.stringify(value) + '\n');
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function safeBytes(file: string) {
  const stat = fs.lstatSync(file);
  check(
    stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 512 * 1024 * 1024,
    'MAINTENANCE_UNSAFE_FILE',
  );
  const bytes = fs.readFileSync(file);
  const after = fs.lstatSync(file);
  check(
    after.ino === stat.ino &&
      after.size === stat.size &&
      after.mtimeMs === stat.mtimeMs &&
      bytes.length === stat.size,
    'MAINTENANCE_SOURCE_CHANGED',
  );
  return bytes;
}
function inventory(root: string, filter: boolean): z.infer<typeof entrySchema>[] {
  const entries: z.infer<typeof entrySchema>[] = [];
  let total = 0;
  const seen = new Set<string>();
  function walk(relative: string) {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      if (filter && (excluded.has(name) || name.endsWith('.tmp') || name.startsWith('.maintenance-')))
        continue;
      const key = relative ? relative + '/' + name : name;
      safeRelative(key);
      check(!seen.has(key.toLowerCase()), 'MAINTENANCE_PATH_COLLISION');
      seen.add(key.toLowerCase());
      check(entries.length < 100000, 'MAINTENANCE_ENTRY_LIMIT');
      const file = path.join(root, key),
        stat = fs.lstatSync(file);
      check(!stat.isSymbolicLink(), 'MAINTENANCE_UNSAFE_FILE');
      if (stat.isDirectory()) {
        entries.push({ path: key, type: 'directory', size: 0 });
        walk(key);
      } else {
        const bytes = safeBytes(file);
        total += bytes.length;
        check(total <= 8 * 1024 * 1024 * 1024, 'MAINTENANCE_SIZE_LIMIT');
        entries.push({ path: key, type: 'file', size: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  walk('');
  return entries;
}
function validateSnapshot(value: unknown): MaintenanceSnapshot {
  const snapshot = snapshotSchema.parse(value),
    owners = new Set<string>();
  for (const owner of snapshot.owners) {
    check(!owners.has(owner.ownerId), 'MAINTENANCE_DUPLICATE_OWNER');
    owners.add(owner.ownerId);
    check(
      new Set(owner.documents.map((d) => d.key)).size === owner.documents.length &&
        new Set(owner.receipts.map((r) => r.sourceHash)).size === owner.receipts.length,
      'MAINTENANCE_DUPLICATE_DOCUMENT',
    );
    check(
      !owner.ownerId.includes('\0') &&
        owner.documents.every((d) => !d.key.includes('\0') && !d.content.includes('\0')),
      'MAINTENANCE_INVALID_SNAPSHOT',
    );
  }
  return snapshot;
}
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalJson(item)]),
    );
  return value;
}
function snapshotHash(snapshot: MaintenanceSnapshot) {
  return sha256(
    JSON.stringify({
      version: 3,
      owners: [...snapshot.owners]
        .sort((a, b) => a.ownerId.localeCompare(b.ownerId))
        .map((owner) => ({
          ...owner,
          documents: [...owner.documents]
            .sort((a, b) => a.key.localeCompare(b.key))
            .map((document) => ({
              ...document,
              content:
                document.key === 'projects.json'
                  ? JSON.stringify(canonicalJson(JSON.parse(document.content)))
                  : document.content,
            })),
          receipts: [...owner.receipts].sort((a, b) => a.sourceHash.localeCompare(b.sourceHash)),
        })),
    }),
  );
}
function profiles(backend?: MaintenanceBackend) {
  const ids = backend ? [...backend.profileIds].sort() : [];
  check(new Set(ids).size === ids.length && ids.every((id) => id.length > 0), 'MAINTENANCE_PROFILE_INVALID');
  return ids;
}
function assertBackendRequired(dir: string, backend?: MaintenanceBackend) {
  check(
    !fs.existsSync(path.join(dir, 'business-storage.json')) || profiles(backend).length > 0,
    'MAINTENANCE_SQL_BACKEND_REQUIRED',
  );
}

export async function backupFull(
  options: MaintenanceBase & { destination: string },
): Promise<FullBackupManifest> {
  stopped(options);
  const root = path.resolve(options.dataDir),
    destination = path.resolve(options.destination);
  unrelated(root, destination);
  safeAncestors(root);
  safeAncestors(path.dirname(destination));
  check(!fs.existsSync(destination), 'MAINTENANCE_DESTINATION_EXISTS');
  assertBackendRequired(root, options.backend);
  const release = acquireDataLock(root);
  try {
    return await performBackup(options);
  } finally {
    release();
  }
}
/** Caller owns the data lock. Kept private so callers cannot bypass exclusion. */
async function performBackup(
  options: MaintenanceBase & { destination: string },
): Promise<FullBackupManifest> {
  const root = path.resolve(options.dataDir),
    destination = path.resolve(options.destination);
  unrelated(root, destination);
  safeAncestors(root);
  safeAncestors(path.dirname(destination));
  check(!fs.existsSync(destination), 'MAINTENANCE_DESTINATION_EXISTS');
  assertBackendRequired(root, options.backend);
  const stage = destination + '.' + randomUUID() + '.tmp';
  try {
    check(!fs.existsSync(path.join(root, '.maintenance-journal.json')), 'MAINTENANCE_RECOVERY_REQUIRED');
    fs.mkdirSync(stage, { mode: 0o700 });
    fs.mkdirSync(path.join(stage, 'files'), { mode: 0o700 });
    fs.mkdirSync(path.join(stage, 'sql'), { mode: 0o700 });
    const entries = inventory(root, true);
    for (const entry of entries) {
      const target = path.join(stage, 'files', entry.path);
      if (entry.type === 'directory') fs.mkdirSync(target, { mode: 0o700 });
      else {
        const bytes = safeBytes(path.join(root, entry.path));
        check(sha256(bytes) === entry.sha256, 'MAINTENANCE_SOURCE_CHANGED');
        privateWrite(target, bytes);
      }
    }
    const sql: FullBackupManifest['sql'] = [];
    for (const [index, profileId] of profiles(options.backend).entries()) {
      const snapshot = validateSnapshot(await options.backend!.exportSnapshot(profileId));
      const bytes = JSON.stringify(snapshot) + '\n',
        relative = `sql/${index}.json`;
      privateWrite(path.join(stage, relative), bytes);
      sql.push({ profileId, path: relative, sha256: sha256(bytes) });
    }
    check(JSON.stringify(inventory(root, true)) === JSON.stringify(entries), 'MAINTENANCE_SOURCE_CHANGED');
    const externalKeys: FullBackupManifest['externalKeys'] = [];
    if (process.env.MODEL_SECRETS_KEY) externalKeys.push('MODEL_SECRETS_KEY');
    if (entries.some((e) => e.path.endsWith('platform-secrets.enc')))
      externalKeys.push('PLATFORM_SECRETS_KEY');
    const manifest: FullBackupManifest = {
      format: 'novel-agent-full-backup',
      version: 2,
      backupId: randomUUID(),
      createdAt: new Date().toISOString(),
      complete: true,
      consistency: 'offline-all-runtimes-stopped',
      exclusions: [...excluded, '*.tmp', '.maintenance-*'],
      entries,
      sql,
      externalKeys,
    };
    privateWrite(path.join(stage, 'backup-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    validateBackup(stage);
    fs.renameSync(stage, destination);
    return manifest;
  } catch (error) {
    // A failed private staging directory is deliberately retained for diagnosis; never publish it.
    throw error;
  }
}

/** Pure/offline validation: never opens SQL connections or starts runtime constructors. */
export function validateBackup(backupDir: string): {
  manifest: FullBackupManifest;
  snapshots: Map<string, MaintenanceSnapshot>;
} {
  const root = path.resolve(backupDir);
  safeAncestors(root);
  const manifest = manifestSchema.parse(
    JSON.parse(safeBytes(path.join(root, 'backup-manifest.json')).toString('utf8')),
  );
  safeAncestors(path.join(root, 'files'));
  safeAncestors(path.join(root, 'sql'));
  const actual = inventory(path.join(root, 'files'), false);
  const expected = [...manifest.entries].sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of expected) {
    safeRelative(entry.path);
    check(
      !entry.path
        .split('/')
        .some((part) => excluded.has(part) || part.endsWith('.tmp') || part.startsWith('.maintenance-')),
      'MAINTENANCE_EXCLUDED_ENTRY',
    );
    check(
      entry.type === 'file' ? !!entry.sha256 : entry.size === 0 && !entry.sha256,
      'MAINTENANCE_MANIFEST_INVALID',
    );
  }
  check(
    new Set(expected.map((e) => e.path.toLowerCase())).size === expected.length,
    'MAINTENANCE_PATH_COLLISION',
  );
  check(
    JSON.stringify([...actual].sort((a, b) => a.path.localeCompare(b.path))) === JSON.stringify(expected),
    'MAINTENANCE_CHECKSUM_MISMATCH',
  );
  const snapshots = new Map<string, MaintenanceSnapshot>(),
    sqlPaths = new Set<string>();
  for (const item of manifest.sql) {
    safeRelative(item.path);
    check(
      /^sql\/\d+\.json$/.test(item.path) && !sqlPaths.has(item.path) && !snapshots.has(item.profileId),
      'MAINTENANCE_PROFILE_INVALID',
    );
    sqlPaths.add(item.path);
    const bytes = safeBytes(path.join(root, item.path));
    check(sha256(bytes) === item.sha256, 'MAINTENANCE_CHECKSUM_MISMATCH');
    snapshots.set(item.profileId, validateSnapshot(JSON.parse(bytes.toString('utf8'))));
  }
  const sqlActual = inventory(path.join(root, 'sql'), false);
  check(
    sqlActual.every((e) => e.type === 'file' && sqlPaths.has('sql/' + e.path)) &&
      sqlActual.length === sqlPaths.size,
    'MAINTENANCE_UNDECLARED_FILE',
  );
  check(
    fs.readdirSync(root).sort().join(',') === 'backup-manifest.json,files,sql',
    'MAINTENANCE_UNDECLARED_FILE',
  );
  return { manifest, snapshots };
}

function validateBusiness(key: string, content: string) {
  const value: unknown = JSON.parse(content);
  check(value !== null && typeof value === 'object', 'MAINTENANCE_DOCUMENT_INVALID');
  if (key === 'projects.json') migrateProjects(value);
  if (key === 'models.json') {
    const model = z
      .object({
        baseUrl: z.string(),
        model: z.string(),
        id: z.string().optional(),
        name: z.string().optional(),
        mode: z.enum(['demo', 'live']).optional(),
        protocol: z.enum(['responses', 'anthropic-messages', 'chat-completions']).optional(),
        enabled: z.boolean().optional(),
        createdAt: z.string().optional(),
      })
      .passthrough();
    z.union([
      z.array(model),
      z.object({ models: z.array(model), activeModelId: z.string().optional() }).passthrough(),
    ]).parse(value);
  }
  if (key === 'platform-connections.json' || key === 'publication-queue.json') {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-maintenance-validation-'));
    try {
      privateWrite(path.join(temporary, key), content);
      if (key === 'platform-connections.json') new PlatformStore(temporary);
      else
        new PublicationQueue(
          path.join(temporary, key),
          {
            async validate() {},
            async execute() {
              throw new Error('MAINTENANCE_VALIDATION_ONLY');
            },
          },
          { persist() {} },
        );
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}
function validateLayout(root: string, snapshots: Map<string, MaintenanceSnapshot>) {
  const modeFile = path.join(root, 'auth-enabled.json');
  const mode = fs.existsSync(modeFile)
    ? z
        .object({ enabled: z.boolean(), legacyOwnerId: z.string().uuid().nullable() })
        .strict()
        .parse(JSON.parse(safeBytes(modeFile).toString('utf8')))
    : { enabled: false, legacyOwnerId: null };
  const manifestFile = path.join(root, 'business-storage.json');
  let manifestOwner: string | null = null;
  if (fs.existsSync(manifestFile)) {
    const manifest = z
      .object({ ownerId: z.string().uuid(), migrationHash: z.string().regex(/^[a-f0-9]{64}$/) })
      .passthrough()
      .parse(JSON.parse(safeBytes(manifestFile).toString('utf8')));
    manifestOwner = manifest.ownerId;
    check(snapshots.size > 0, 'MAINTENANCE_SQL_BACKEND_REQUIRED');
    check(!mode.enabled || mode.legacyOwnerId === manifestOwner, 'MAINTENANCE_AUTH_OWNER_MISMATCH');
  }
  let activeAuth: string | null = null;
  for (const snapshot of snapshots.values())
    for (const owner of snapshot.owners)
      if (owner.ownerId === GLOBAL_AUTH_OWNER)
        for (const doc of owner.documents)
          if (doc.key === 'auth.json') {
            check(activeAuth === null, 'MAINTENANCE_DUPLICATE_AUTH');
            activeAuth = doc.content;
          }
  if (!manifestOwner && fs.existsSync(path.join(root, 'auth.json')))
    activeAuth = safeBytes(path.join(root, 'auth.json')).toString('utf8');
  check(!mode.enabled || activeAuth !== null, 'MAINTENANCE_AUTH_REQUIRED');
  if (activeAuth !== null) {
    const auth = parseAuth(activeAuth),
      mapping = new Set(auth.users.map((u) => sha256(u.id)));
    check(
      mode.legacyOwnerId === null || auth.users.some((u) => u.id === mode.legacyOwnerId),
      'MAINTENANCE_LEGACY_OWNER_INVALID',
    );
    const usersDir = path.join(root, 'users');
    if (fs.existsSync(usersDir)) {
      safeAncestors(usersDir);
      for (const name of fs.readdirSync(usersDir)) check(mapping.has(name), 'MAINTENANCE_UNOWNED_DIRECTORY');
    }
  }
}
function validateBackupBusiness(root: string, snapshots: Map<string, MaintenanceSnapshot>) {
  for (const entry of inventory(root, false))
    if (entry.type === 'file' && businessDocuments.some((key) => path.posix.basename(entry.path) === key))
      validateBusiness(
        path.posix.basename(entry.path),
        safeBytes(path.join(root, entry.path)).toString('utf8'),
      );
  for (const snapshot of snapshots.values())
    for (const owner of snapshot.owners)
      for (const doc of owner.documents)
        if (businessDocuments.some((key) => key === doc.key)) validateBusiness(doc.key, doc.content);
}
function validateSecrets(root: string, snapshots: Map<string, MaintenanceSnapshot>) {
  const authDocuments: string[] = [];
  const local = path.join(root, 'auth.json');
  if (fs.existsSync(local)) authDocuments.push(safeBytes(local).toString('utf8'));
  for (const snapshot of snapshots.values())
    for (const owner of snapshot.owners)
      if (owner.ownerId === GLOBAL_AUTH_OWNER)
        for (const doc of owner.documents) if (doc.key === 'auth.json') authDocuments.push(doc.content);
  for (const raw of authDocuments) {
    const auth = parseAuth(raw);
    const key = safeBytes(path.join(root, 'auth.key'));
    check(key.length === 32, 'MAINTENANCE_KEY_INVALID');
    if (auth.turnstile?.encryptedSecret) {
      const bytes = Buffer.from(auth.turnstile.encryptedSecret, 'base64');
      check(bytes.length >= 29, 'MAINTENANCE_KEY_INVALID');
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(-16));
      decipher.update(bytes.subarray(12, -16));
      decipher.final();
    }
  }
  for (const entry of inventory(root, false).filter(
    (e) => e.type === 'file' && /(?:model|platform)-secrets\.enc$/.test(e.path),
  )) {
    const model = entry.path.endsWith('model-secrets.enc'),
      dir = path.dirname(path.join(root, entry.path));
    const configured = process.env[model ? 'MODEL_SECRETS_KEY' : 'PLATFORM_SECRETS_KEY'];
    const key = configured
      ? createHash('sha256').update(configured).digest()
      : model
        ? Buffer.from(safeBytes(path.join(dir, 'model-secrets.key')).toString('utf8').trim(), 'base64')
        : undefined;
    check(key && key.length === 32, 'MAINTENANCE_EXTERNAL_KEY_REQUIRED');
    const encrypted = z
      .object({
        version: z.literal(1),
        entries: z.record(z.string(), z.object({ iv: z.string(), tag: z.string(), data: z.string() })),
      })
      .parse(JSON.parse(safeBytes(path.join(root, entry.path)).toString('utf8')));
    for (const [id, value] of Object.entries(encrypted.entries)) {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
      decipher.setAAD(Buffer.from(model ? `model:${id}` : id));
      decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
      decipher.update(Buffer.from(value.data, 'base64'));
      decipher.final();
    }
  }
}
const authSchema = z.object({
  version: z.literal(1),
  users: z.array(
    z.object({
      id: z.string().uuid(),
      username: z.string().regex(/^[a-z0-9][a-z0-9_.-]{2,63}$/),
      role: z.enum(['superadmin', 'user']),
      disabled: z.boolean(),
      passwordHash: z.string().regex(/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/),
      createdAt: z.string().datetime(),
    }),
  ),
  sessions: z.array(
    z.object({
      userId: z.string().uuid(),
      tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
      csrfToken: z.string().regex(/^[a-f0-9]{64}$/),
      expiresAt: z.number().finite(),
    }),
  ),
  turnstile: z.object({
    enabled: z.boolean(),
    siteKey: z.string(),
    action: z.string(),
    hostname: z.string(),
    encryptedSecret: z.string(),
  }),
});
function parseAuth(raw: string) {
  const auth = authSchema.parse(JSON.parse(raw)),
    ids = new Set(auth.users.map((u) => u.id));
  check(
    ids.size === auth.users.length &&
      new Set(auth.users.map((u) => u.username)).size === auth.users.length &&
      !ids.has(GLOBAL_AUTH_OWNER) &&
      auth.sessions.every((s) => ids.has(s.userId)),
    'MAINTENANCE_AUTH_INVALID',
  );
  check(
    auth.users.some((u) => u.role === 'superadmin' && !u.disabled),
    'MAINTENANCE_ADMIN_REQUIRED',
  );
  return auth;
}

/** SQL imports cannot atomically commit with files/multiple databases. A failure retains a durable
 * journal and the original directory; operator must inspect imported profile receipts before retry.
 * Never auto-delete SQL to simulate rollback. Targets must be explicitly selected fresh databases. */
export async function restoreFull(
  options: MaintenanceBase & {
    backupDir: string;
    replace?: boolean;
    /** Mandatory with SQL: writes explicitly selected target connection configuration, never source credentials. */ activateStaged?: (
      stageDir: string,
    ) => void;
  },
) {
  stopped(options);
  const root = path.resolve(options.dataDir),
    backup = path.resolve(options.backupDir);
  unrelated(root, backup);
  safeAncestors(root);
  safeAncestors(path.dirname(root));
  const validated = validateBackup(backup),
    ids = profiles(options.backend);
  check(
    JSON.stringify([...validated.snapshots.keys()].sort()) === JSON.stringify(ids),
    'MAINTENANCE_PROFILE_MISMATCH',
  );
  assertBackendRequired(path.join(backup, 'files'), options.backend);
  validateSecrets(path.join(backup, 'files'), validated.snapshots);
  validateBackupBusiness(path.join(backup, 'files'), validated.snapshots);
  validateLayout(path.join(backup, 'files'), validated.snapshots);
  check(ids.length === 0 || options.activateStaged, 'MAINTENANCE_TARGET_CONFIG_REQUIRED');
  for (const key of validated.manifest.externalKeys)
    check(process.env[key], 'MAINTENANCE_EXTERNAL_KEY_REQUIRED');
  const existed = fs.existsSync(root);
  if (existed)
    check(options.replace === true || fs.readdirSync(root).length === 0, 'MAINTENANCE_REPLACE_ACK_REQUIRED');
  const release = acquireDataLock(root),
    operationId = randomUUID(),
    stage = root + '.restore-' + operationId,
    rollback = root + '.rollback-' + operationId;
  const journal = path.join(root, '.maintenance-journal.json');
  try {
    check(!fs.existsSync(journal), 'MAINTENANCE_RECOVERY_REQUIRED');
    for (const id of ids) await options.backend!.assertEmpty(id);
    fs.mkdirSync(stage, { mode: 0o700 });
    for (const entry of validated.manifest.entries) {
      const target = path.join(stage, entry.path);
      if (entry.type === 'directory') fs.mkdirSync(target, { mode: 0o700 });
      else {
        const bytes = safeBytes(path.join(backup, 'files', entry.path));
        check(sha256(bytes) === entry.sha256, 'MAINTENANCE_CHECKSUM_MISMATCH');
        privateWrite(target, bytes);
      }
    }
    // Derive a restore state without reviving historical session cookies. Originals remain intact.
    const stagedAuth = path.join(stage, 'auth.json');
    if (fs.existsSync(stagedAuth)) {
      const auth = parseAuth(safeBytes(stagedAuth).toString('utf8'));
      auth.sessions = [];
      atomicJson(stagedAuth, auth);
    }
    for (const snapshot of validated.snapshots.values())
      for (const owner of snapshot.owners)
        if (owner.ownerId === GLOBAL_AUTH_OWNER)
          for (const document of owner.documents)
            if (document.key === 'auth.json') {
              const auth = parseAuth(document.content);
              auth.sessions = [];
              document.content = JSON.stringify(auth) + '\n';
            }
    if (ids.length)
      for (const file of ['sqlconnect.json', 'storage-profiles.json']) {
        const target = path.join(stage, file);
        if (fs.existsSync(target)) fs.unlinkSync(target);
      }
    options.activateStaged?.(stage);
    check(
      ids.length === 0 ||
        fs.existsSync(path.join(stage, 'storage-profiles.json')) ||
        fs.existsSync(path.join(stage, 'sqlconnect.json')),
      'MAINTENANCE_TARGET_CONFIG_REQUIRED',
    );
    if (ids.length) {
      const configFile = path.join(stage, 'storage-profiles.json');
      if (fs.existsSync(configFile)) {
        const config = storageConfigSchema.parse(JSON.parse(safeBytes(configFile).toString('utf8')));
        check(
          JSON.stringify(config.profiles.map((p) => p.id).sort()) === JSON.stringify(ids),
          'MAINTENANCE_PROFILE_MISMATCH',
        );
        const owners = new Set<string>();
        for (const [profileId, snapshot] of validated.snapshots)
          for (const owner of snapshot.owners) {
            check(!owners.has(owner.ownerId), 'MAINTENANCE_DUPLICATE_OWNER');
            owners.add(owner.ownerId);
            check(
              profileForOwner(config, owner.ownerId).id === profileId,
              'MAINTENANCE_OWNER_ROUTING_MISMATCH',
            );
          }
      } else {
        check(ids.length === 1, 'MAINTENANCE_PROFILE_MISMATCH');
        sqlConnectConfigSchema.parse(
          JSON.parse(safeBytes(path.join(stage, 'sqlconnect.json')).toString('utf8')),
        );
      }
    }
    // Verify the hook cannot introduce links or unsafe filesystem objects.
    inventory(stage, false);
    // This is a complete rollback copy of the previous local tree, including excluded history.
    // Rename keeps it byte-for-byte; the lock is released only after the synchronous activation.
    const state = {
      version: 1,
      operationId,
      kind: 'restore',
      backupId: validated.manifest.backupId,
      transforms: ['revoke-auth-sessions'],
      phase: 'prepared',
      importedProfiles: [] as string[],
      stage,
      rollback,
    };
    atomicJson(journal, state);
    for (const [id, snapshot] of validated.snapshots) {
      state.phase = 'sql-importing:' + id;
      atomicJson(journal, state);
      await options.backend!.importSnapshot(id, snapshot);
      check(
        snapshotHash(validateSnapshot(await options.backend!.exportSnapshot(id))) === snapshotHash(snapshot),
        'MAINTENANCE_SQL_VERIFICATION_FAILED',
      );
      state.importedProfiles.push(id);
      state.phase = 'sql-verified';
      atomicJson(journal, state);
    }
    state.phase = 'activation';
    atomicJson(journal, state);
    // Preserve a recovery marker in the new directory as well as the old directory.
    atomicJson(path.join(stage, '.maintenance-journal.json'), state);
    privateWrite(path.join(stage, '.instance.lock'), safeBytes(path.join(root, '.instance.lock')));
    fs.renameSync(root, rollback);
    try {
      fs.renameSync(stage, root);
    } catch (error) {
      if (!fs.existsSync(root)) fs.renameSync(rollback, root);
      throw error;
    }
    fs.unlinkSync(path.join(rollback, '.instance.lock'));
    fs.unlinkSync(path.join(root, '.maintenance-journal.json'));
    return { operationId, rollbackDir: rollback, restartRequired: true as const };
  } finally {
    release();
  }
}

export interface ProfileMigrationOptions extends MaintenanceBase {
  /** CLI requires this external path; takes a verified safety backup while holding this operation's lock. */
  backupDestination?: string;
  backend: MaintenanceBackend;
  legacyOwnerId: string | null;
  profileForOwner(ownerId: string): string;
  /** Called only after all committed SQL state is verified. Must atomically publish activation. */
  activate(plan: {
    version: 3;
    migrationHash: string;
    owners: { ownerId: string; relativeDir: string; profileId: string }[];
  }): void;
}
export async function migrateAllProfiles(options: ProfileMigrationOptions) {
  stopped(options);
  const root = path.resolve(options.dataDir);
  safeAncestors(root);
  const release = acquireDataLock(root);
  const journal = path.join(root, '.maintenance-journal.json');
  try {
    check(!fs.existsSync(journal), 'MAINTENANCE_RECOVERY_REQUIRED');
    check(!fs.existsSync(path.join(root, 'business-storage.json')), 'MAINTENANCE_ALREADY_ACTIVE');
    const authFile = path.join(root, 'auth.json');
    const authRaw = fs.existsSync(authFile) ? safeBytes(authFile).toString('utf8') : null;
    const modeFile = path.join(root, 'auth-enabled.json');
    const mode = fs.existsSync(modeFile)
      ? z
          .object({ enabled: z.boolean(), legacyOwnerId: z.string().uuid().nullable() })
          .strict()
          .parse(JSON.parse(safeBytes(modeFile).toString('utf8')))
      : { enabled: false, legacyOwnerId: null };
    const auth = authRaw === null ? null : parseAuth(authRaw);
    check(
      auth !== null ||
        (!mode.enabled &&
          options.legacyOwnerId !== null &&
          uuid.safeParse(options.legacyOwnerId).success &&
          options.legacyOwnerId !== GLOBAL_AUTH_OWNER),
      'MAINTENANCE_AUTH_REQUIRED',
    );
    check(
      options.legacyOwnerId === null ||
        (uuid.safeParse(options.legacyOwnerId).success &&
          options.legacyOwnerId !== GLOBAL_AUTH_OWNER &&
          (!auth || auth.users.some((u) => u.id === options.legacyOwnerId))),
      'MAINTENANCE_LEGACY_OWNER_INVALID',
    );
    check(
      mode.legacyOwnerId === null || mode.legacyOwnerId === options.legacyOwnerId,
      'MAINTENANCE_LEGACY_OWNER_CONFLICT',
    );
    check(!mode.enabled || mode.legacyOwnerId === options.legacyOwnerId, 'MAINTENANCE_AUTH_OWNER_MISMATCH');
    const users = auth?.users ?? [{ id: options.legacyOwnerId! }];
    const mapping = new Map(users.map((u) => [sha256(u.id), u.id]));
    const usersDir = path.join(root, 'users');
    if (fs.existsSync(usersDir)) {
      safeAncestors(usersDir);
      for (const name of fs.readdirSync(usersDir)) {
        check(mapping.has(name), 'MAINTENANCE_UNOWNED_DIRECTORY');
        safeAncestors(path.join(usersDir, name));
        check(fs.lstatSync(path.join(usersDir, name)).isDirectory(), 'MAINTENANCE_UNSAFE_DIRECTORY');
      }
    }
    const rootAssets = inventory(root, true).filter(
      (e) =>
        !e.path.startsWith('users/') &&
        e.path !== 'users' &&
        !['auth.json', 'auth.key', 'auth-enabled.json', 'sqlconnect.json', 'storage-profiles.json'].includes(
          e.path,
        ),
    );
    check(options.legacyOwnerId !== null || rootAssets.length === 0, 'MAINTENANCE_LEGACY_OWNER_REQUIRED');
    const owners: { ownerId: string; relativeDir: string; profileId: string }[] = [];
    const ids = profiles(options.backend),
      snapshots = new Map(
        ids.map((id) => [id, { version: 3 as const, owners: [] as MaintenanceSnapshot['owners'] }]),
      );
    check(
      auth !== null || !fs.existsSync(usersDir) || fs.readdirSync(usersDir).length === 0,
      'MAINTENANCE_AUTH_REQUIRED',
    );
    for (const user of [...users].sort((a, b) => a.id.localeCompare(b.id))) {
      const hashed = 'users/' + sha256(user.id),
        relativeDir = user.id === options.legacyOwnerId ? '' : hashed;
      check(
        user.id !== options.legacyOwnerId || !fs.existsSync(path.join(root, hashed)),
        'MAINTENANCE_DUPLICATE_PROFILE',
      );
      const profileId = options.profileForOwner(user.id);
      check(snapshots.has(profileId), 'MAINTENANCE_PROFILE_MISMATCH');
      const documents: MaintenanceSnapshot['owners'][number]['documents'] = [];
      for (const key of businessDocuments)
        if (fs.existsSync(path.join(root, relativeDir, key))) {
          const content = safeBytes(path.join(root, relativeDir, key)).toString('utf8');
          validateBusiness(key, content);
          documents.push({ key, content, revision: 1 });
        }
      const sourceHash = sha256(JSON.stringify(documents.map((d) => ({ key: d.key, content: d.content }))));
      snapshots.get(profileId)!.owners.push({
        ownerId: user.id,
        revision: documents.length ? 1 : 0,
        documents,
        receipts: documents.length ? [{ sourceHash, documentCount: documents.length }] : [],
      });
      owners.push({ ownerId: user.id, relativeDir, profileId });
    }
    if (authRaw !== null) {
      const globalProfile = options.profileForOwner(GLOBAL_AUTH_OWNER);
      check(snapshots.has(globalProfile), 'MAINTENANCE_PROFILE_MISMATCH');
      snapshots.get(globalProfile)!.owners.push({
        ownerId: GLOBAL_AUTH_OWNER,
        revision: 1,
        documents: [{ key: 'auth.json', content: authRaw, revision: 1 }],
        receipts: [],
      });
    }
    validateSecrets(root, new Map());
    if (options.backupDestination)
      await performBackup({ dataDir: root, destination: options.backupDestination, runtimeStopped: true });
    for (const id of ids) await options.backend.assertEmpty(id);
    const migrationHash = sha256(JSON.stringify([...snapshots]));
    const state = {
      version: 1,
      kind: 'migrate-all-profiles',
      operationId: randomUUID(),
      migrationHash,
      phase: 'prepared',
      importedProfiles: [] as string[],
    };
    atomicJson(journal, state);
    for (const [id, snapshot] of snapshots) {
      state.phase = 'sql-importing:' + id;
      atomicJson(journal, state);
      await options.backend.importSnapshot(id, snapshot);
      check(
        snapshotHash(validateSnapshot(await options.backend.exportSnapshot(id))) === snapshotHash(snapshot),
        'MAINTENANCE_SQL_VERIFICATION_FAILED',
      );
      state.importedProfiles.push(id);
      state.phase = 'sql-verified';
      atomicJson(journal, state);
    }
    state.phase = 'activation';
    atomicJson(journal, state);
    options.activate({ version: 3, migrationHash, owners });
    fs.unlinkSync(journal);
    return { migrationHash, owners, restartRequired: true as const };
  } finally {
    release();
  }
}
