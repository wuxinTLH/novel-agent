export type CoreModel = 'local' | 'server';

/** CoreModel is deliberately case-sensitive; other spellings are not aliases. */
export function readCoreModel(env: NodeJS.ProcessEnv): CoreModel {
  const value = env.CoreModel ?? 'local';
  if (value !== 'local' && value !== 'server') throw new Error('CORE_MODEL_INVALID');
  return value;
}

export function coreModelBindHost(coreModel: CoreModel): '127.0.0.1' | '0.0.0.0' {
  return coreModel === 'local' ? '127.0.0.1' : '0.0.0.0';
}

/** A loopback listener must not opt into a remote reverse-proxy authority. */
export function assertCoreModelOrigin(coreModel: CoreModel, trustedOrigin?: string): void {
  if (coreModel === 'local' && trustedOrigin &&
      !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(trustedOrigin).hostname))
    throw new Error('LOCAL_PUBLIC_ORIGIN_FORBIDDEN');
}

/** The current gateway binds loopback unconditionally. Also reject misleading host
 * overrides, and validate a host should the gateway config later expose one. */
export function assertCoreModelGateway(
  coreModel: CoreModel,
  config: { enabled: boolean; host?: string },
  env: NodeJS.ProcessEnv,
): void {
  if (coreModel !== 'local') return;
  for (const host of [config.host, env.GATEWAY_HOST]) {
    if (host !== undefined && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host))
      throw new Error('LOCAL_GATEWAY_LOOPBACK_REQUIRED');
  }
}
