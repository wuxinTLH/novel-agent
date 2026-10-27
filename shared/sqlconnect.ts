import { z } from 'zod';

export const SQLCONNECT_SCHEMA_VERSION = 1;
export const sqlConnectDrivers = [
  { id: 'mysql', aliases: [], defaultPort: 3306 },
  { id: 'postgresql', aliases: [], defaultPort: 5432 },
  { id: 'sqlserver', aliases: ['mssql'], defaultPort: 1433 },
] as const;

export const sqlConnectConfigSchema = z.object({
  driver: z.enum(['mysql', 'postgresql', 'sqlserver', 'mssql']).transform(value => value === 'mssql' ? 'sqlserver' as const : value),
  host: z.string().trim().min(1).max(253).regex(/^[a-zA-Z0-9.:[\]-]+$/),
  port: z.number().int().min(1).max(65535),
  database: z.string().min(1).max(63).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  user: z.string().trim().min(1).max(128).regex(/^[^\u0000-\u001f]+$/),
  password: z.string().max(4096).optional(),
  tls: z.enum(['verify', 'off']).default('verify'),
  timeoutMs: z.number().int().min(1000).max(30000).default(10000),
}).strict().superRefine((config, ctx) => {
  if (config.tls === 'off' && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(config.host.toLowerCase()))
    ctx.addIssue({ code: 'custom', path: ['tls'], message: 'TLS off is allowed only for explicit loopback hosts.' });
});
export type SQLConnectConfig = z.output<typeof sqlConnectConfigSchema>;
export type SQLConnectPublicConfig = Omit<SQLConnectConfig, 'password'> & { hasPassword: boolean };
export interface SQLConnectStatus {
  configured: boolean;
  config: SQLConnectPublicConfig | null;
  busy: boolean;
  storage: 'local-json';
  schemaVersion: number;
  available: boolean;
  errorCode?: 'SQLCONNECT_CONFIG_UNAVAILABLE';
}
export const sqlConnectInitializeSchema = z.object({ confirmDatabase: z.string().min(1).max(63) }).strict();
