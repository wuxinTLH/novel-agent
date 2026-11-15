import { z } from 'zod';

export const LOG_LEVELS = ['info', 'warning', 'error'] as const;
export const LOG_CATEGORIES = ['runtime', 'error', 'medium-risk', 'high-risk', 'system-error', 'system-failure'] as const;
export const ALERT_PROVIDERS = ['wechat', 'feishu', 'dingtalk', 'wecom'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogCategory = (typeof LOG_CATEGORIES)[number];
export type AlertProvider = (typeof ALERT_PROVIDERS)[number];
export interface OperationalLog { id: string; at: string; level: LogLevel; category: LogCategory; code: string; message: string }
export interface LogsResponse { items: OperationalLog[]; total: number; limit: number; offset: number }
const revision = z.number().int().nonnegative().safe();
const configFields = {
  enabled: z.boolean(), minimumLevel: z.enum(['warning', 'error']),
  categories: z.array(z.enum(LOG_CATEGORIES)).min(1).max(LOG_CATEGORIES.length).refine(a => new Set(a).size === a.length),
  cooldownSeconds: z.number().int().min(1).max(86400),
  providers: z.object({ wechat: z.boolean(), feishu: z.boolean(), dingtalk: z.boolean(), wecom: z.boolean() }).strict(),
};
export const logAlertConfigSchema = z.object({ revision, ...configFields }).strict();
export const updateLogAlertConfigSchema = z.object({ expectedRevision: revision, ...configFields }).strict();
export type LogAlertConfig = z.infer<typeof logAlertConfigSchema>;
export type UpdateLogAlertConfig = z.infer<typeof updateLogAlertConfigSchema>;
export interface LogAlertsResponse { config: LogAlertConfig; providers: { id: AlertProvider; available: boolean }[] }
export function defaultLogAlertConfig(): LogAlertConfig {
  return { revision: 0, enabled: false, minimumLevel: 'warning', categories: ['error', 'medium-risk', 'high-risk', 'system-error', 'system-failure'], cooldownSeconds: 300, providers: { wechat: false, feishu: false, dingtalk: false, wecom: false } };
}
/** A closed catalog: never pass runtime messages, error text, identifiers or request data. */
export const OPERATIONAL_EVENT_CATALOG = {
  SERVICE_STARTED: { level: 'info', category: 'runtime', message: 'Service started.' },
  GATEWAY_STARTED: { level: 'info', category: 'runtime', message: 'Local gateway started.' },
  GATEWAY_FAILED: { level: 'error', category: 'system-error', message: 'Local gateway failed.' },
  SERVICE_LISTEN_FAILED: { level: 'error', category: 'system-failure', message: 'Service could not listen.' },
  SERVICE_SHUTDOWN_FAILED: { level: 'error', category: 'system-error', message: 'Service shutdown failed.' },
  DATA_LOCK_RELEASE_FAILED: { level: 'error', category: 'system-error', message: 'Data lock release failed.' },
  HTTP_INTERNAL_ERROR: { level: 'error', category: 'error', message: 'An internal request failed.' },
  WORKFLOW_EXECUTION_FAILED: { level: 'error', category: 'error', message: 'Workflow execution failed.' },
  WORKFLOW_RECOVERY_FAILED: { level: 'error', category: 'system-error', message: 'Workflow recovery failed.' },
  TENANT_RUNTIME_FAILED: { level: 'error', category: 'system-failure', message: 'Tenant runtime failed.' },
  ORIGIN_REJECTED: { level: 'warning', category: 'high-risk', message: 'Request origin rejected.' },
  REQUEST_RATE_LIMITED: { level: 'warning', category: 'medium-risk', message: 'Request rate limit reached.' },
} as const satisfies Record<string, {level: LogLevel; category: LogCategory; message: string}>;
export type OperationalEventCode = keyof typeof OPERATIONAL_EVENT_CATALOG;
export const OPERATIONAL_EVENT_CODES = Object.keys(OPERATIONAL_EVENT_CATALOG) as OperationalEventCode[];
export function isOperationalEventCode(value: unknown): value is OperationalEventCode {
  return typeof value === 'string' && Object.hasOwn(OPERATIONAL_EVENT_CATALOG, value);
}
const timestamp = z.string().datetime({ offset: false }).refine(s => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s);
const integerQuery = (fallback: number, max: number, min = 0) => z.string().regex(/^(0|[1-9][0-9]*)$/).transform(Number).pipe(z.number().int().min(min).max(max)).optional().transform(v => v ?? fallback);
export const logsQuerySchema = z.object({
  level: z.enum(LOG_LEVELS).optional(), category: z.enum(LOG_CATEGORIES).optional(),
  from: timestamp.optional(), to: timestamp.optional(),
  search: z.string().max(100).refine(s => !/[\u0000-\u001f\u007f-\u009f]/.test(s)).optional(),
  limit: integerQuery(50, 200, 1), offset: integerQuery(0, 10000),
}).strict().refine(q => !q.from || !q.to || q.from <= q.to);
export type LogsQuery = z.infer<typeof logsQuerySchema>;
