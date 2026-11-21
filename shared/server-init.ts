import { z } from 'zod';
import { sqlConnectConfigSchema, type SQLConnectPublicConfig } from './sqlconnect.js';
import { isSupportedInitPhone } from './init-phone.js';

/** SQL is deferred configuration only: Init never connects, creates schema or activates SQL. */
export const serverInitDatabaseSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('local-json') }).strict(),
  z.object({ mode: z.literal('sql-later'), connection: sqlConnectConfigSchema.optional() }).strict(),
]);
export type ServerInitDatabase = z.output<typeof serverInitDatabaseSchema>;
export interface ServerInitDatabaseConfig {
  mode: 'local-json' | 'sql-later';
  connection: (Partial<Omit<SQLConnectPublicConfig, 'hasPassword'>> & { hasPassword: boolean }) | null;
  environmentFields: string[];
  schemaInitialized: false;
  activeBackend: 'local-json';
}

export const SERVER_INIT_KEYS = [
  'NOVEL_TRUSTED_PUBLIC_ORIGIN', 'MODEL_SECRETS_KEY', 'PLATFORM_SECRETS_KEY', 'NOVEL_SMS_PROVIDER',
  'NOVEL_SMS_ALIYUN_ACCESS_KEY_ID', 'NOVEL_SMS_ALIYUN_ACCESS_KEY_SECRET',
  'NOVEL_SMS_ALIYUN_SIGN_NAME', 'NOVEL_SMS_ALIYUN_TEMPLATE_CODE',
  'NOVEL_SMS_TENCENT_SECRET_ID', 'NOVEL_SMS_TENCENT_SECRET_KEY', 'NOVEL_SMS_TENCENT_SDK_APP_ID',
  'NOVEL_SMS_TENCENT_SIGN_NAME', 'NOVEL_SMS_TENCENT_TEMPLATE_ID',
] as const;
export type ServerInitKey = typeof SERVER_INIT_KEYS[number];
export interface ServerInitStatus { required: boolean; restartRequired?: boolean }
export interface ServerInitField { key: ServerInitKey; label?: string; secret: boolean; configured: boolean; value?: string }
export interface ServerInitConfig { fields: ServerInitField[]; database?: ServerInitDatabaseConfig }
export const serverInitCompleteSchema = z.object({
  values: z.partialRecord(z.enum(SERVER_INIT_KEYS), z.string().max(4096)),
  username: z.string().min(3).max(64), phone: z.string().refine(isSupportedInitPhone),
  password: z.string().max(1024),
  database: serverInitDatabaseSchema.optional(),
}).strict();
export type ServerInitComplete = z.infer<typeof serverInitCompleteSchema>;
