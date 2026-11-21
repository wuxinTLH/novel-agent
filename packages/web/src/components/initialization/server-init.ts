import { parseInitDatabase } from './init-database';
import { isSupportedInitPhone } from '../../../../../shared/init-phone';
import { SERVER_INIT_KEYS, type ServerInitConfig, type ServerInitField, type ServerInitStatus } from '../../../../../shared/server-init';
export type InitField = ServerInitField & { readOnly?: boolean };
export interface InitConfig extends ServerInitConfig { fields: InitField[] }
export type InitStatus = ServerInitStatus;
export type InitRequest = (path: 'status' | 'config' | 'complete', options?: { token?: string; body?: unknown; signal?: AbortSignal }) => Promise<unknown>;
export class InitRequestError extends Error {
  constructor(public status: number) { super('INIT_REQUEST_FAILED'); }
}
const secretKeys = new Set(['MODEL_SECRETS_KEY', 'PLATFORM_SECRETS_KEY', 'NOVEL_SMS_ALIYUN_ACCESS_KEY_ID', 'NOVEL_SMS_ALIYUN_ACCESS_KEY_SECRET', 'NOVEL_SMS_TENCENT_SECRET_ID', 'NOVEL_SMS_TENCENT_SECRET_KEY']);
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function parseInitStatus(value: unknown): InitStatus {
  if (!record(value) || typeof value.required !== 'boolean' || (value.restartRequired !== undefined && typeof value.restartRequired !== 'boolean')) throw new Error('INIT_INVALID_RESPONSE');
  return { required: value.required, restartRequired: value.restartRequired === true };
}
export function parseInitConfig(value: unknown): InitConfig {
  if (!record(value) || !Array.isArray(value.fields) || value.fields.length > 40) throw new Error('INIT_INVALID_RESPONSE');
  const seen = new Set<string>();
  return { database: parseInitDatabase(value.database), fields: value.fields.map((field: unknown) => {
    if (!record(field) || typeof field.key !== 'string' || !SERVER_INIT_KEYS.includes(field.key as ServerInitField['key']) || seen.has(field.key) || typeof field.secret !== 'boolean' || typeof field.configured !== 'boolean') throw new Error('INIT_INVALID_RESPONSE');
    seen.add(field.key);
    const secret = field.secret || secretKeys.has(field.key);
    return { key: field.key as ServerInitField['key'], secret, configured: field.configured, readOnly: field.configured || field.readOnly === true,
      ...(!secret && typeof field.value === 'string' ? { value: field.value } : {}) };
  }) };
}
/** Dedicated bootstrap transport: no business API, session refresh or automatic mutation retry. */
export async function initRequest(path: 'status' | 'config' | 'complete', options: { token?: string; body?: unknown; signal?: AbortSignal } = {}, transport: typeof fetch = fetch): Promise<unknown> {
  const response = await transport('/api/init/' + path, {
    method: path === 'complete' ? 'POST' : 'GET', cache: 'no-store', credentials: 'same-origin', redirect: 'error',
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    headers: { ...(options.token ? { 'X-Init-Token': options.token } : {}), ...(path === 'complete' ? { 'Content-Type': 'application/json' } : {}) },
    ...(path === 'complete' ? { body: JSON.stringify(options.body) } : {}),
  });
  // Never consume or display raw error messages: they can contain sensitive configuration.
  if (!response.ok) throw new InitRequestError(response.status);
  return response.json();
}
export function relevantFields(config: InitConfig, drafts: Record<string, string>): InitField[] {
  const provider = drafts.NOVEL_SMS_PROVIDER;
  return config.fields.filter((field) => !field.key.startsWith('NOVEL_SMS_ALIYUN_') && !field.key.startsWith('NOVEL_SMS_TENCENT_') ||
    (provider === 'aliyun' && field.key.startsWith('NOVEL_SMS_ALIYUN_')) || (provider === 'tencent' && field.key.startsWith('NOVEL_SMS_TENCENT_')));
}
export function validInitDraft(config: InitConfig, drafts: Record<string, string>, username: string, phone: string, password: string): boolean {
  if (!/^[\s\S]{3,64}$/.test(username) || !isSupportedInitPhone(phone) || [...password].length < 15 || new TextEncoder().encode(password).length > 1024) return false;
  if (!['aliyun', 'tencent'].includes(drafts.NOVEL_SMS_PROVIDER)) return false;
  if (relevantFields(config, drafts).some((field) => !field.configured && !drafts[field.key]?.trim())) return false;
  try {
    const raw = drafts.NOVEL_TRUSTED_PUBLIC_ORIGIN;
    const origin = new URL(raw);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.origin !== raw) return false;
  } catch { return false; }
  for (const key of ['MODEL_SECRETS_KEY', 'PLATFORM_SECRETS_KEY']) {
    if (!config.fields.find((field) => field.key === key)?.configured && (drafts[key]?.length ?? 0) < 32) return false;
  }
  if (drafts.MODEL_SECRETS_KEY && drafts.MODEL_SECRETS_KEY === drafts.PLATFORM_SECRETS_KEY) return false;
  return true;
}
export function initialValues(config: InitConfig): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of config.fields) values[field.key] = field.secret ? '' : field.value ?? '';
  return values;
}
export function submissionValues(config: InitConfig, drafts: Record<string, string>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of relevantFields(config, drafts)) {
    const value = drafts[field.key] ?? '';
    if (!field.readOnly && value !== '') values[field.key] = value;
  }
  return values;
}
