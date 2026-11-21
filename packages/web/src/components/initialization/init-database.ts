import type { ServerInitDatabase, ServerInitDatabaseConfig } from '../../../../../shared/server-init';
import { sqlConnectConfigSchema } from '../../../../../shared/sqlconnect';
export const databaseFields = ['driver', 'host', 'port', 'database', 'user', 'password', 'tls', 'timeoutMs'] as const;
export type DatabaseDraft = Record<typeof databaseFields[number] | 'mode', string>;
const emptyConfig: ServerInitDatabaseConfig = { mode: 'local-json', connection: null, environmentFields: [], schemaInitialized: false, activeBackend: 'local-json' };
export function parseInitDatabase(value: unknown): ServerInitDatabaseConfig {
  if (value === undefined) return { ...emptyConfig, environmentFields: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INIT_INVALID_RESPONSE');
  const input = value as Record<string, unknown>;
  if (!['local-json', 'sql-later'].includes(String(input.mode)) || input.schemaInitialized !== false || input.activeBackend !== 'local-json' || !Array.isArray(input.environmentFields) || input.environmentFields.some(key => typeof key !== 'string' || ![...databaseFields, 'mode'].includes(key))) throw new Error('INIT_INVALID_RESPONSE');
  let connection: ServerInitDatabaseConfig['connection'] = null;
  if (input.connection !== null) {
    if (!input.connection || typeof input.connection !== 'object' || Array.isArray(input.connection)) throw new Error('INIT_INVALID_RESPONSE');
    const raw = input.connection as Record<string, unknown>;
    if (typeof raw.hasPassword !== 'boolean') throw new Error('INIT_INVALID_RESPONSE');
    connection = { hasPassword: raw.hasPassword };
    for (const key of databaseFields) {
      if (key === 'password' || raw[key] === undefined) continue;
      const parsed = sqlConnectConfigSchema.shape[key].safeParse(raw[key]);
      if (!parsed.success) throw new Error('INIT_INVALID_RESPONSE');
      Object.assign(connection, { [key]: parsed.data });
    }
  }
  return { mode: input.mode as ServerInitDatabaseConfig['mode'], connection, environmentFields: [...input.environmentFields] as string[], schemaInitialized: false, activeBackend: 'local-json' };
}
export function initialDatabaseDraft(config?: ServerInitDatabaseConfig): DatabaseDraft {
  const connection = config?.connection;
  return { mode: config?.mode ?? 'local-json', driver: connection?.driver ?? 'postgresql', host: connection?.host ?? '', port: String(connection?.port ?? 5432), database: connection?.database ?? '', user: connection?.user ?? '', password: '', tls: connection?.tls ?? 'verify', timeoutMs: String(connection?.timeoutMs ?? 10000) };
}
/** Offline syntax validation only. Masked environment passwords are never echoed. */
export function databaseSubmission(draft: DatabaseDraft, config?: ServerInitDatabaseConfig): ServerInitDatabase | null {
  const mode = config?.environmentFields.includes('mode') ? config.mode : draft.mode;
  if (mode === 'local-json') return { mode };
  if (mode !== 'sql-later') return null;
  const raw: Record<string, unknown> = {};
  for (const key of databaseFields) {
    if (key === 'password' && config?.environmentFields.includes(key)) continue;
    const value = config?.environmentFields.includes(key) ? config.connection?.[key as keyof NonNullable<ServerInitDatabaseConfig['connection']>] : draft[key];
    if (key === 'password' && !value) continue;
    raw[key] = key === 'port' || key === 'timeoutMs' ? (/^[0-9]+$/.test(String(value)) ? Number(value) : NaN) : value;
  }
  const parsed = sqlConnectConfigSchema.safeParse(raw);
  return parsed.success ? { mode, connection: parsed.data } : null;
}
