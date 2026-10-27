import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { appRoot } from './local-runtime.js';
import {
  backupFull,
  restoreFull,
  migrateAllProfiles,
  validateBackup,
  type MaintenanceBackend,
} from './maintenance.js';
import { RelationalStorage } from './models/relational-storage.js';
import {
  readAuthMode,
  readStorageManifest,
  readStorageProfiles,
  writeStorageProfiles,
  GLOBAL_AUTH_OWNER,
} from './models/storage-config.js';
import { storageConfigSchema, profileForOwner, type StorageConfig } from '../shared/storage.js';

export const maintenanceUsage = `Offline maintenance (stop ALL runtimes sharing selected databases):
  npm run maintenance -- backup --destination PATH --confirm [--data-dir PATH]
  npm run maintenance -- restore --source PATH --confirm [--data-dir PATH] [--replace]
    SQL restore additionally requires --database-config PATH to an explicitly selected target storage-profiles file.
  npm run maintenance -- migrate-all --owner UUID --destination FULL_BACKUP_PATH --confirm [--data-dir PATH]
    Creates a mandatory full backup under the migration lock BEFORE any database writes.
    Reads target connections from data-dir/storage-profiles.json. Never enables authentication.
Backups contain credentials, keys and uploads. Keep them private. Preserve external secret keys separately.
Restore NEVER connects using connection settings found inside the backup.
`;
type Command = 'backup' | 'restore' | 'migrate-all';
export interface MaintenanceCliOptions {
  command: Command;
  dataDir: string;
  destination?: string;
  source?: string;
  databaseConfig?: string;
  owner?: string;
  replace: boolean;
}
function requireCondition(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
export function parseMaintenanceArguments(args: string[]): MaintenanceCliOptions {
  requireCondition(['backup', 'restore', 'migrate-all'].includes(args[0]), 'MAINTENANCE_COMMAND_INVALID');
  const command = args[0] as Command;
  const values = new Map<string, string>(),
    flags = new Set<string>();
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    requireCondition(!values.has(arg) && !flags.has(arg), 'MAINTENANCE_DUPLICATE_ARGUMENT');
    if (['--data-dir', '--destination', '--source', '--database-config', '--owner'].includes(arg)) {
      const value = args[++index];
      requireCondition(value && !value.startsWith('--'), 'MAINTENANCE_ARGUMENT_VALUE_REQUIRED');
      values.set(arg, value);
    } else {
      requireCondition(['--confirm', '--replace'].includes(arg), 'MAINTENANCE_ARGUMENT_INVALID');
      flags.add(arg);
    }
  }
  requireCondition(flags.has('--confirm'), 'MAINTENANCE_CONFIRM_REQUIRED');
  requireCondition(
    command === 'restore' ? !values.has('--destination') : values.has('--destination'),
    'MAINTENANCE_DESTINATION_ARGUMENT_INVALID',
  );
  requireCondition(
    command === 'restore' ? values.has('--source') : !values.has('--source'),
    'MAINTENANCE_SOURCE_ARGUMENT_INVALID',
  );
  requireCondition(
    !values.has('--database-config') || command === 'restore',
    'MAINTENANCE_DATABASE_CONFIG_NOT_APPLICABLE',
  );
  requireCondition(!flags.has('--replace') || command === 'restore', 'MAINTENANCE_REPLACE_NOT_APPLICABLE');
  const owner = values.get('--owner');
  requireCondition(!owner || command === 'migrate-all', 'MAINTENANCE_OWNER_NOT_APPLICABLE');
  if (command === 'migrate-all')
    requireCondition(
      owner && z.string().uuid().safeParse(owner).success && owner !== GLOBAL_AUTH_OWNER,
      'MAINTENANCE_OWNER_REQUIRED',
    );
  const resolve = (name: string) => (values.has(name) ? path.resolve(values.get(name)!) : undefined);
  return {
    command,
    dataDir: resolve('--data-dir') ?? path.join(appRoot, 'data'),
    destination: resolve('--destination'),
    source: resolve('--source'),
    databaseConfig: resolve('--database-config'),
    owner,
    replace: flags.has('--replace'),
  };
}

/** Explicitly selected config only; constructing pools never contacts archive endpoints. */
function backendFor(config: StorageConfig, initializeTargets: boolean) {
  const stores = new Map(
    config.profiles.map((profile) => [profile.id, new RelationalStorage(profile.connection)]),
  );
  const initialized = new Set<string>();
  const store = (id: string) => {
    const result = stores.get(id);
    requireCondition(result, 'MAINTENANCE_PROFILE_MISMATCH');
    return result;
  };
  const backend: MaintenanceBackend = {
    profileIds: [...stores.keys()],
    exportSnapshot: (id) => store(id).exportSnapshot(),
    async assertEmpty(id) {
      // Invoked by maintenance only after it acquired the offline data lock.
      // Backups do not take this path and never perform schema writes.
      if (initializeTargets && !initialized.has(id)) {
        await store(id).migrate();
        initialized.add(id);
      }
      requireCondition(
        (await store(id).exportSnapshot()).owners.length === 0,
        'MAINTENANCE_TARGET_NOT_EMPTY',
      );
    },
    importSnapshot: (id, snapshot) => store(id).importSnapshot(snapshot),
  };
  return { backend, close: () => Promise.all([...stores.values()].map((value) => value.close())) };
}
function explicitConfig(file: string): StorageConfig {
  const stat = fs.lstatSync(file);
  requireCondition(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024,
    'MAINTENANCE_DATABASE_CONFIG_INVALID',
  );
  return storageConfigSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}
function activate(dataDir: string, ownerId: string, migrationHash: string) {
  const file = path.join(dataDir, 'business-storage.json'),
    temporary = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(
      fd,
      JSON.stringify({ backend: 'relational', version: 3, ownerId, migrationHash }) + '\n',
    );
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}
export async function runMaintenance(options: MaintenanceCliOptions): Promise<unknown> {
  if (options.command === 'backup') {
    const manifest = readStorageManifest(options.dataDir);
    requireCondition(!manifest || manifest.version === 3, 'MAINTENANCE_LEGACY_SQL_BACKUP_UNSUPPORTED');
    const config = manifest ? readStorageProfiles(options.dataDir) : null;
    requireCondition(!manifest || config, 'STORAGE_PROFILES_REQUIRED');
    const selected = config ? backendFor(config, false) : undefined;
    try {
      const result = await backupFull({
        dataDir: options.dataDir,
        runtimeStopped: true,
        destination: options.destination!,
        backend: selected?.backend,
      });
      return {
        command: 'backup',
        backupId: result.backupId,
        sqlProfiles: result.sql.map((value) => value.profileId),
        complete: true,
      };
    } finally {
      await selected?.close();
    }
  }
  if (options.command === 'restore') {
    const backup = validateBackup(options.source!);
    const hasSql = backup.snapshots.size > 0;
    requireCondition(
      hasSql ? options.databaseConfig : !options.databaseConfig,
      'MAINTENANCE_EXPLICIT_TARGET_CONFIG_REQUIRED',
    );
    // Only this operator-selected external file is permitted to determine connections.
    const config = options.databaseConfig ? explicitConfig(options.databaseConfig) : undefined;
    const selected = config ? backendFor(config, true) : undefined;
    try {
      const restoreOptions = {
        dataDir: options.dataDir,
        runtimeStopped: true as const,
        backupDir: options.source!,
        replace: options.replace,
        backend: selected?.backend,
        activateStaged: config
          ? (stageDir: string) => {
              writeStorageProfiles(stageDir, config);
              // SQLconnect is the control-plane editor; it must not retain a live source endpoint.
              const target = config.profiles.find((profile) => profile.id === config.defaultProfileId)!;
              fs.writeFileSync(
                path.join(stageDir, 'sqlconnect.json'),
                JSON.stringify(target.connection) + '\n',
                { mode: 0o600 },
              );
            }
          : undefined,
      };
      return await restoreFull(restoreOptions);
    } finally {
      await selected?.close();
    }
  }
  requireCondition(!readStorageManifest(options.dataDir), 'MAINTENANCE_ALREADY_ACTIVE');
  const config = readStorageProfiles(options.dataDir);
  requireCondition(config, 'STORAGE_PROFILES_REQUIRED');
  const mode = readAuthMode(options.dataDir);
  requireCondition(!mode.legacyOwnerId || mode.legacyOwnerId === options.owner, 'MAINTENANCE_OWNER_MISMATCH');
  const selected = backendFor(config, true);
  try {
    return await migrateAllProfiles({
      dataDir: options.dataDir,
      runtimeStopped: true,
      backend: selected.backend,
      backupDestination: options.destination!,
      legacyOwnerId: options.owner!,
      profileForOwner: (ownerId) => profileForOwner(config, ownerId).id,
      activate: (plan) => activate(options.dataDir, options.owner!, plan.migrationHash),
    });
  } finally {
    await selected.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    try {
      process.loadEnvFile(path.join(appRoot, '.env'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const result = await runMaintenance(parseMaintenanceArguments(process.argv.slice(2)));
    console.log(JSON.stringify(result));
  } catch (error) {
    // Never print driver messages, configuration, stacks, credentials or archive bodies.
    const message = error instanceof Error ? error.message : '';
    console.error(/^[A-Z_]{3,80}$/.test(message) ? message : 'MAINTENANCE_FAILED');
    process.exitCode = 1;
  }
}
