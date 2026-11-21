import { SERVER_INIT_KEYS, serverInitCompleteSchema } from '../../../../../shared/server-init';
import { InitRequestError, initialValues, parseInitConfig, validInitDraft, type InitRequest } from './server-init';

export const INIT_TEST_TOKEN = 'init-test-dummy-token';
export function isInitTestPath(pathname: string): boolean { return pathname === '/init-test'; }

/** Fictional fixture only. Never reads environment, storage, identity or the network. */
export function createInitTestSession(): { request: InitRequest } {
  let completed = false;
  const configured = new Set(['NOVEL_TRUSTED_PUBLIC_ORIGIN', 'MODEL_SECRETS_KEY', 'NOVEL_SMS_PROVIDER', 'NOVEL_SMS_ALIYUN_ACCESS_KEY_ID']);
  const publicValues: Record<string, string> = {
    NOVEL_TRUSTED_PUBLIC_ORIGIN: 'https://init-test.invalid', NOVEL_SMS_PROVIDER: 'aliyun',
  };
  const config = parseInitConfig({ database: { mode: 'local-json', connection: null, environmentFields: [], schemaInitialized: false, activeBackend: 'local-json' }, fields: SERVER_INIT_KEYS.map((key) => ({
    key, secret: /SECRETS_KEY|ACCESS_KEY|SECRET_ID|SECRET_KEY/.test(key), configured: configured.has(key),
    ...(publicValues[key] ? { value: publicValues[key] } : {}),
  })) });
  const request: InitRequest = async (path, options = {}) => {
    options.signal?.throwIfAborted();
    if (path === 'status') return { required: !completed, restartRequired: completed };
    if (options.token !== INIT_TEST_TOKEN) throw new InitRequestError(403);
    if (path === 'config') {
      if (completed) throw new InitRequestError(409);
      return { database: config.database, fields: config.fields.map((field) => ({ ...field })) };
    }
    if (completed) throw new InitRequestError(409);
    const parsed = serverInitCompleteSchema.safeParse(options.body);
    if (!parsed.success || !validInitDraft(config, { ...initialValues(config), ...parsed.data.values }, parsed.data.username, parsed.data.phone, parsed.data.password)) {
      throw new InitRequestError(400);
    }
    // Do not retain submitted values or credentials: only the simulated phase survives.
    completed = true;
    return { required: false, restartRequired: true };
  };
  return { request };
}
