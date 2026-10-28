import type { Request } from 'express';

/** Explicit deployment opt-in; never infer trust from forwarded headers or account settings. */
export function trustedPublicOrigin(value = process.env.NOVEL_TRUSTED_PUBLIC_ORIGIN): string | undefined {
  if (value === undefined || value === '') return undefined;
  try {
    const url = new URL(value);
    if (
      value !== value.trim() ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.hostname.includes('*') ||
      !/^https:\/\/[^/?#]+\/?$/i.test(value)
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error('NOVEL_TRUSTED_PUBLIC_ORIGIN_INVALID');
  }
}

/** TLS terminator must preserve Host and strip untrusted forwarding headers. This does not
 * enable Express proxy trust or change local administrator authority. */
export function createOriginPolicy(port: number, trusted = trustedPublicOrigin()) {
  const privateHost = (hostname: string) =>
    ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);
  const local = (value: string) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'http:' && ['5173', String(port)].includes(url.port) && privateHost(url.hostname)
      );
    } catch {
      return false;
    }
  };
  const trustedHost = trusted ? new URL(trusted).host : undefined;
  return (req: Pick<Request, 'get'>, allowCrossSiteCallback = false): boolean => {
    const host = req.get('host') || '';
    const origin = req.get('origin');
    if (req.get('sec-fetch-site') === 'cross-site' && !allowCrossSiteCallback) return false;
    if (trustedHost && host.toLowerCase() === trustedHost) return !origin || origin === trusted;
    return local(`http://${host}`) && (!origin || local(origin));
  };
}
