import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { acquireDataLock, appRoot } from '../../core/local-runtime.js';
import { AuthService, type AuthDocument } from '../auth/auth.js';
import { migrateProjects } from '../projects/store.js';
import { PlatformStore } from '../platforms/platform-store.js';
import { PublicationQueue } from '../platforms/publication-queue.js';
import { PostgresStorage, type ImportDocument } from '../../infrastructure/storage/postgres-storage.js';
import {
  businessDocuments,
  createAuthPersistence,
  readPostgresConfig,
  readStorageManifest,
} from '../../infrastructure/storage/storage-config.js';

const globalAuthOwner = '00000000-0000-4000-8000-000000000001';
const authConfigSchema = z
  .object({ enabled: z.boolean(), legacyOwnerId: z.string().uuid().nullable() })
  .strict();
export type LocalAuthConfig = z.infer<typeof authConfigSchema>;
const uuid = z.string().uuid();
const commands = ['bootstrap-admin', 'migrate-sql', 'enable-auth', 'disable-auth', 'assign-legacy'] as const;
type Command = (typeof commands)[number];
export interface AdminOptions {
  command: Command;
  dataDir: string;
  owner?: string;
  username?: string;
  noLegacy: boolean;
  allowPublicAccess: boolean;
}
export interface AdminResult {
  command: Command;
  backup: string;
  ownerId?: string;
  restartRequired: true;
}
export const adminUsage = `Local administration (stop the server first):
  bootstrap-admin --username NAME --confirm
  migrate-sql --owner UUID --confirm
  enable-auth (--owner UUID | --no-legacy) --confirm
  disable-auth --allow-public-access --confirm
  assign-legacy --owner UUID --confirm
All commands accept --data-dir PATH (default: appRoot/data).
Bootstrap password: NOVEL_BOOTSTRAP_PASSWORD environment variable only.
Backups contain private credentials; keep them private. Legacy files are never deleted.
Backups cover selected control/business files, NOT uploads, browser/secret stores or other tenants.
Keep an independent full data-directory and database backup before administration.
Bootstrap before migration if enabling auth later; use the returned ownerId for both commands.
Migration refuses existing local tenant subdirectories; migrate these separately first.
Migration contacts only the PostgreSQL endpoint in sqlconnect.json when explicitly invoked.
`;
class AdminError extends Error {}
function requireCondition(value: unknown, code: string): asserts value {
  if (!value) throw new AdminError(code);
}
export function parseAdminArguments(args: string[]): AdminOptions {
  requireCondition(commands.includes(args[0] as Command), 'ADMIN_COMMAND_INVALID');
  const command = args[0] as Command;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 1; index < args.length; index++) {
    const argument = args[index];
    requireCondition(!values.has(argument) && !flags.has(argument), 'ADMIN_DUPLICATE_ARGUMENT');
    if (['--data-dir', '--owner', '--username'].includes(argument)) {
      const value = args[++index];
      requireCondition(value && !value.startsWith('--'), 'ADMIN_ARGUMENT_VALUE_REQUIRED');
      values.set(argument, value);
    } else {
      requireCondition(
        ['--confirm', '--no-legacy', '--allow-public-access'].includes(argument),
        'ADMIN_ARGUMENT_INVALID',
      );
      flags.add(argument);
    }
  }
  requireCondition(flags.has('--confirm'), 'ADMIN_CONFIRM_REQUIRED');
  const owner = values.get('--owner');
  const username = values.get('--username');
  if (owner)
    requireCondition(uuid.safeParse(owner).success && owner !== globalAuthOwner, 'ADMIN_OWNER_INVALID');
  const noLegacy = flags.has('--no-legacy');
  const allowPublicAccess = flags.has('--allow-public-access');
  requireCondition(
    !owner || ['migrate-sql', 'enable-auth', 'assign-legacy'].includes(command),
    'ADMIN_OWNER_NOT_APPLICABLE',
  );
  requireCondition(!username || command === 'bootstrap-admin', 'ADMIN_USERNAME_NOT_APPLICABLE');
  requireCondition(!noLegacy || command === 'enable-auth', 'ADMIN_NO_LEGACY_NOT_APPLICABLE');
  requireCondition(!allowPublicAccess || command === 'disable-auth', 'ADMIN_PUBLIC_ACCESS_NOT_APPLICABLE');
  if (command === 'bootstrap-admin')
    requireCondition(username && /^[a-z0-9][a-z0-9_.-]{2,63}$/.test(username), 'ADMIN_USERNAME_INVALID');
  if (command === 'migrate-sql' || command === 'assign-legacy')
    requireCondition(owner, 'ADMIN_OWNER_REQUIRED');
  if (command === 'enable-auth')
    requireCondition(!!owner !== noLegacy, 'ADMIN_EXPLICIT_LEGACY_CHOICE_REQUIRED');
  if (command === 'disable-auth') requireCondition(allowPublicAccess, 'ADMIN_PUBLIC_ACCESS_ACK_REQUIRED');
  return {
    command,
    dataDir: path.resolve(values.get('--data-dir') ?? path.join(appRoot, 'data')),
    owner,
    username,
    noLegacy,
    allowPublicAccess,
  };
}

function safeDirectory(dir: string) {
  // Reject symlink/junction ancestors as well as the final component.
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      requireCondition(stat.isDirectory() && !stat.isSymbolicLink(), 'ADMIN_UNSAFE_DIRECTORY');
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
function readOptional(file: string): string | null {
  try {
    const stat = fs.lstatSync(file);
    requireCondition(
      stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024 * 1024,
      'ADMIN_UNSAFE_FILE',
    );
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export function readLocalAuthConfig(dir: string): LocalAuthConfig {
  const content = readOptional(path.join(dir, 'auth-enabled.json'));
  if (content === null) return { enabled: false, legacyOwnerId: null };
  try {
    return authConfigSchema.parse(JSON.parse(content));
  } catch {
    throw new AdminError('ADMIN_AUTH_CONFIG_INVALID');
  }
}
function atomicWrite(file: string, content: string) {
  readOptional(file); // Fail closed for an unsafe existing target.
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function readBusinessDocuments(dir: string): ImportDocument[] {
  return businessDocuments.flatMap((key) => {
    const content = readOptional(path.join(dir, key));
    if (content === null) return [];
    let document: unknown;
    try {
      document = JSON.parse(content);
    } catch {
      throw new AdminError('ADMIN_LEGACY_JSON_INVALID');
    }
    requireCondition(document !== null && typeof document === 'object', 'ADMIN_LEGACY_JSON_INVALID');
    return [{ key, content }];
  });
}
function hasLegacyAssets(dir: string): boolean {
  const controlFiles = new Set([
    '.instance.lock',
    '.instance.lock.recovery',
    'auth.json',
    'auth.key',
    'auth-enabled.json',
    'sqlconnect.json',
    'business-storage.json',
    'admin-backups',
    'users',
  ]);
  // Unknown root entries may be uploads, encryption keys, or browser sessions: fail closed.
  return fs.readdirSync(dir).some((name) => !controlFiles.has(name));
}
function validateMigrationDocuments(documents: ImportDocument[], destination: string) {
  const validationDir = path.join(destination, 'validation');
  fs.mkdirSync(validationDir, { mode: 0o700 });
  for (const document of documents) {
    try {
      const value: unknown = JSON.parse(document.content);
      if (document.key === 'projects.json') migrateProjects(value);
      if (document.key === 'models.json') {
        const model = z
          .object({
            id: z.string().optional(),
            name: z.string().optional(),
            baseUrl: z.string(),
            model: z.string(),
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
      if (document.key === 'platform-connections.json') {
        // Existing constructors may recover/migrate, so only run against a private copy.
        fs.writeFileSync(path.join(validationDir, document.key), document.content, {
          flag: 'wx',
          mode: 0o600,
        });
        new PlatformStore(validationDir);
      }
      if (document.key === 'publication-queue.json') {
        const file = path.join(validationDir, document.key);
        fs.writeFileSync(file, document.content, { flag: 'wx', mode: 0o600 });
        new PublicationQueue(
          file,
          {
            async validate() {},
            async execute() {
              throw new Error('ADMIN_VALIDATION_ONLY');
            },
          },
          { persist() {} },
        );
      }
    } catch {
      throw new AdminError('ADMIN_LEGACY_DOCUMENT_INVALID');
    }
  }
}
function backup(dir: string, command: Command): string {
  const root = path.join(dir, 'admin-backups');
  safeDirectory(root);
  const destination = path.join(root, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
  fs.mkdirSync(destination, { mode: 0o700 });
  const files: { name: string; sha256: string }[] = [];
  for (const name of [
    ...businessDocuments,
    'auth.json',
    'auth.key',
    'auth-enabled.json',
    'business-storage.json',
    'sqlconnect.json',
  ]) {
    const source = path.join(dir, name);
    try {
      const stat = fs.lstatSync(source);
      requireCondition(stat.isFile() && !stat.isSymbolicLink(), 'ADMIN_UNSAFE_FILE');
      const bytes = fs.readFileSync(source);
      fs.writeFileSync(path.join(destination, name), bytes, { flag: 'wx', mode: 0o600 });
      requireCondition(
        fs.readFileSync(path.join(destination, name)).equals(bytes),
        'ADMIN_BACKUP_VERIFICATION_FAILED',
      );
      files.push({ name, sha256: createHash('sha256').update(bytes).digest('hex') });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  fs.writeFileSync(
    path.join(destination, 'backup-manifest.json'),
    JSON.stringify(
      {
        version: 1,
        command,
        scope:
          'Selected root business/auth/config files only; active SQL additionally snapshots default owner documents and global auth. Not a complete database or data-directory backup.',
        warning:
          'Before proceeding, keep an independent full data-directory and PostgreSQL backup. Uploads, browser sessions, model/platform secret stores and other tenant documents are NOT included.',
        files,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  return destination;
}
function authState(dir: string): { service: AuthService; document: AuthDocument | null } {
  const persistence = createAuthPersistence(dir);
  // AuthService validates the complete state and key before we inspect identities.
  const service = new AuthService({ dataDir: dir, enabled: true, persistence });
  const raw = persistence
    ? persistence.read()
    : (JSON.parse(readOptional(path.join(dir, 'auth.json')) ?? 'null') as unknown);
  return { service, document: raw as AuthDocument | null };
}
function requireOwner(document: AuthDocument | null, owner: string) {
  requireCondition(
    document?.users.some((user) => user.id === owner && !user.disabled),
    'ADMIN_OWNER_USER_NOT_FOUND',
  );
}
function requireAdmin(document: AuthDocument | null) {
  requireCondition(
    document?.users.some((user) => user.role === 'superadmin' && !user.disabled),
    'ADMIN_BOOTSTRAP_REQUIRED',
  );
}

/** Explicit entry point; importing this module never performs network or disk operations. */
export async function runAdmin(
  options: AdminOptions,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AdminResult> {
  // Validate even programmatic calls through the same command/flag rules as the CLI.
  const args = [options.command, '--data-dir', options.dataDir, '--confirm'];
  if (options.owner) args.push('--owner', options.owner);
  if (options.username) args.push('--username', options.username);
  if (options.noLegacy) args.push('--no-legacy');
  if (options.allowPublicAccess) args.push('--allow-public-access');
  options = parseAdminArguments(args);
  safeDirectory(options.dataDir);
  const release = acquireDataLock(options.dataDir);
  try {
    const config = readLocalAuthConfig(options.dataDir);
    // Validate configuration targets before any backend activation.
    readOptional(path.join(options.dataDir, 'business-storage.json'));
    readOptional(path.join(options.dataDir, 'sqlconnect.json'));
    const manifest = readStorageManifest(options.dataDir);
    const documents = readBusinessDocuments(options.dataDir);
    const destination = backup(options.dataDir, options.command);
    if (manifest) {
      // Local JSON is stale after activation: also capture authoritative SQL documents.
      const storage = new PostgresStorage(readPostgresConfig(options.dataDir));
      try {
        const snapshots = await Promise.all([
          ...businessDocuments.map(async (key) => ({
            ownerId: manifest.ownerId,
            key,
            document: await storage.readDocument(manifest.ownerId, key),
          })),
          storage
            .readDocument(globalAuthOwner, 'auth.json')
            .then((document) => ({ ownerId: globalAuthOwner, key: 'auth.json', document })),
        ]);
        fs.writeFileSync(
          path.join(destination, 'postgres-snapshot.json'),
          JSON.stringify({ version: 1, snapshots }) + '\n',
          { flag: 'wx', mode: 0o600 },
        );
      } finally {
        await storage.close();
      }
    }
    const result: AdminResult = { command: options.command, backup: destination, restartRequired: true };
    if (options.command === 'bootstrap-admin') {
      const password = environment.NOVEL_BOOTSTRAP_PASSWORD;
      requireCondition(
        typeof password === 'string' && password.length >= 12 && Buffer.byteLength(password) <= 1024,
        'ADMIN_BOOTSTRAP_PASSWORD_REQUIRED',
      );
      const { service } = authState(options.dataDir);
      const user = service.bootstrapSuperadmin(options.username!, password);
      result.ownerId = user.id;
      return result;
    }
    if (options.command === 'migrate-sql') {
      const owner = options.owner!;
      if (!manifest) {
        const tenantRoot = path.join(options.dataDir, 'users');
        if (fs.existsSync(tenantRoot)) {
          safeDirectory(tenantRoot);
          requireCondition(
            fs.readdirSync(tenantRoot).length === 0,
            'ADMIN_LOCAL_TENANTS_REQUIRE_SEPARATE_MIGRATION',
          );
        }
        validateMigrationDocuments(documents, destination);
      }
      requireCondition(!manifest || manifest.ownerId === owner, 'ADMIN_STORAGE_OWNER_CONFLICT');
      requireCondition(
        !config.legacyOwnerId || config.legacyOwnerId === owner,
        'ADMIN_LEGACY_OWNER_CONFLICT',
      );
      // Startup requires an explicit legacy owner for enabled SQL deployments.
      // Refuse before any database writes rather than activating an unbootable manifest.
      requireCondition(
        !config.enabled || config.legacyOwnerId === owner,
        'ADMIN_SQL_AUTH_OWNER_ASSIGNMENT_REQUIRED',
      );
      // Moving an enabled auth deployment must never strand its existing users.
      const localAuth = readOptional(path.join(options.dataDir, 'auth.json'));
      requireCondition(!!manifest || localAuth !== null, 'ADMIN_BOOTSTRAP_REQUIRED');
      const state = authState(options.dataDir);
      requireAdmin(state.document);
      requireOwner(state.document, owner);
      const migrationHash = createHash('sha256').update(JSON.stringify(documents)).digest('hex');
      const storage = new PostgresStorage(readPostgresConfig(options.dataDir));
      try {
        await storage.migrate();
        // Once active, legacy files are historical snapshots, not an import source.
        requireCondition(
          !manifest || manifest.migrationHash === migrationHash,
          'ADMIN_ALREADY_MIGRATED_SOURCE_CHANGED',
        );
        if (!manifest && !documents.length) {
          for (const key of businessDocuments)
            requireCondition((await storage.readDocument(owner, key)) === null, 'ADMIN_SQL_OWNER_NOT_EMPTY');
        }
        if (!manifest && documents.length) await storage.importDocuments(owner, migrationHash, documents);
        if (!manifest)
          for (const document of documents) {
            requireCondition(
              (await storage.readDocument(owner, document.key))?.content === document.content,
              'ADMIN_IMPORT_VERIFICATION_FAILED',
            );
          }
        if (!manifest && localAuth !== null) {
          const existing = await storage.readDocument(globalAuthOwner, 'auth.json');
          requireCondition(!existing || existing.content === localAuth, 'ADMIN_SQL_AUTH_CONFLICT');
          if (!existing) await storage.writeDocument(globalAuthOwner, 'auth.json', localAuth, 0);
          requireCondition(
            (await storage.readDocument(globalAuthOwner, 'auth.json'))?.content === localAuth,
            'ADMIN_IMPORT_VERIFICATION_FAILED',
          );
        }
        atomicWrite(
          path.join(options.dataDir, 'business-storage.json'),
          JSON.stringify({ backend: 'postgresql', ownerId: owner, migrationHash, version: 1 }) + '\n',
        );
      } finally {
        await storage.close();
      }
      return { ...result, ownerId: owner };
    }
    if (options.command === 'disable-auth') {
      // Explicit acknowledgement is mandatory: this exposes the default owner's data.
      atomicWrite(
        path.join(options.dataDir, 'auth-enabled.json'),
        JSON.stringify({ enabled: false, legacyOwnerId: config.legacyOwnerId }) + '\n',
      );
      return result;
    }
    const { document } = authState(options.dataDir);
    requireAdmin(document);
    const owner = options.owner ?? null;
    if (owner) requireOwner(document, owner);
    requireCondition(!config.legacyOwnerId || config.legacyOwnerId === owner, 'ADMIN_LEGACY_OWNER_CONFLICT');
    requireCondition(!manifest || manifest.ownerId === owner, 'ADMIN_STORAGE_OWNER_CONFLICT');
    if (options.command === 'enable-auth' && options.noLegacy)
      requireCondition(!hasLegacyAssets(options.dataDir) && !manifest, 'ADMIN_LEGACY_DATA_REQUIRES_OWNER');
    atomicWrite(
      path.join(options.dataDir, 'auth-enabled.json'),
      JSON.stringify({
        enabled: options.command === 'enable-auth' ? true : config.enabled,
        legacyOwnerId: owner,
      }) + '\n',
    );
    return { ...result, ...(owner ? { ownerId: owner } : {}) };
  } finally {
    release();
  }
}

export async function adminMain(args = process.argv.slice(2)): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(adminUsage);
    return 0;
  }
  try {
    const result = await runAdmin(parseAdminArguments(args));
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    // Never print arbitrary exception messages, stack traces, arguments or credentials.
    const code = error instanceof AdminError ? error.message : 'ADMIN_OPERATION_FAILED';
    console.error(code);
    return 1;
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await adminMain();
}
