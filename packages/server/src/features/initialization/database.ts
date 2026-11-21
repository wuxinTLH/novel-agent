import { sqlConnectConfigSchema, type SQLConnectConfig } from '../../../../../shared/sqlconnect.js';
import type { ServerInitDatabase, ServerInitDatabaseConfig } from '../../../../../shared/server-init.js';

// Bootstrap-only environment contract; never applies to already active SQL storage.
const keys = {
  mode: 'NOVEL_INIT_DB_MODE', driver: 'NOVEL_INIT_DB_DRIVER', host: 'NOVEL_INIT_DB_HOST',
  port: 'NOVEL_INIT_DB_PORT', database: 'NOVEL_INIT_DB_DATABASE', user: 'NOVEL_INIT_DB_USER',
  password: 'NOVEL_INIT_DB_PASSWORD', tls: 'NOVEL_INIT_DB_TLS', timeoutMs: 'NOVEL_INIT_DB_TIMEOUT_MS',
} as const;
function environment(env: NodeJS.ProcessEnv) {
  const result: Record<string, unknown> = {};
  for (const [field, key] of Object.entries(keys)) {
    const value = env[key];
    if (!value) continue;
    if (value.length > 4096) throw new Error('INIT_DATABASE_INVALID');
    if (field === 'port' || field === 'timeoutMs') {
      if (!/^[0-9]+$/.test(value)) throw new Error('INIT_DATABASE_INVALID');
      result[field] = Number(value);
    } else result[field] = value;
  }
  // Validate partial environment without inventing required connection credentials.
  const { mode, ...connection } = result;
  if (mode !== undefined && mode !== 'local-json' && mode !== 'sql-later') throw new Error('INIT_DATABASE_INVALID');
  const parsed: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(connection)) {
    const schema = sqlConnectConfigSchema.shape[field as keyof typeof sqlConnectConfigSchema.shape];
    const checked = schema.safeParse(value);
    if (!checked.success) throw new Error('INIT_DATABASE_INVALID');
    parsed[field] = checked.data;
  }
  return { mode, connection: parsed as Partial<SQLConnectConfig>, fields: Object.keys(result) };
}
export function initDatabaseConfig(env: NodeJS.ProcessEnv): ServerInitDatabaseConfig {
  const values = environment(env);
  const { password, ...connection } = values.connection;
  return { mode: values.mode === 'sql-later' ? 'sql-later' : 'local-json',
    connection: values.fields.some(field => field !== 'mode') ? { ...connection, hasPassword: !!password } : null,
    environmentFields: values.fields, schemaInitialized: false, activeBackend: 'local-json' };
}
export function resolveInitDatabase(env: NodeJS.ProcessEnv, input?: ServerInitDatabase): { mode: 'local-json' | 'sql-later'; connection?: SQLConnectConfig } {
  const values = environment(env);
  const mode = values.mode ?? input?.mode ?? 'local-json';
  if (mode === 'local-json') return { mode };
  const connection = sqlConnectConfigSchema.parse({ ...(input?.mode === 'sql-later' ? input.connection : {}), ...values.connection });
  return { mode: 'sql-later', connection };
}
