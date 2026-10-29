import http, { type IncomingHttpHeaders, type Server } from 'node:http';

export interface LocalGatewayConfig {
  enabled: boolean;
  ports: number[];
  target: string;
}

export interface LocalGatewayLimits {
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
  maxConcurrent?: number;
}

function port(value: string): number {
  if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) < 1024 || Number(value) > 65535)
    throw new Error('GATEWAY_PORT_INVALID');
  return Number(value);
}

function targetOrigin(value: string): string {
  // Strict textual authority prevents URL normalization accepting octal/hex IPs,
  // credentials, escaped hosts, paths, or metadata services. No DNS resolution.
  const match = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):([1-9]\d{0,4})\/?$/.exec(value);
  if (!match) throw new Error('GATEWAY_TARGET_INVALID');
  const targetPort = port(match[2]);
  return `http://${match[1] === 'localhost' ? '127.0.0.1' : match[1]}:${targetPort}`;
}

/** Disabled by default. Enabled listeners require explicit ports; backend PORT stays unchanged. */
export function readLocalGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
  mainPort = Number(env.PORT || 3001),
): LocalGatewayConfig {
  if (env.GATEWAY_ENABLED !== undefined && !['', '0', 'false', '1', 'true'].includes(env.GATEWAY_ENABLED))
    throw new Error('GATEWAY_ENABLED_INVALID');
  const enabled = env.GATEWAY_ENABLED === '1' || env.GATEWAY_ENABLED === 'true';
  if (!enabled) return { enabled: false, ports: [], target: '' };
  if (!Number.isInteger(mainPort) || mainPort < 1 || mainPort > 65535)
    throw new Error('GATEWAY_MAIN_PORT_INVALID');
  const ports = (env.GATEWAY_PORTS || '').split(',').map((value) => port(value.trim()));
  if (new Set(ports).size !== ports.length) throw new Error('GATEWAY_PORT_DUPLICATE');
  if (ports.includes(mainPort)) throw new Error('GATEWAY_MAIN_PORT_CONFLICT');
  const target = targetOrigin(env.GATEWAY_TARGET || `http://127.0.0.1:${mainPort}`);
  if (ports.includes(Number(new URL(target).port))) throw new Error('GATEWAY_TARGET_PORT_CONFLICT');
  return { enabled, ports, target };
}

const hopHeaders = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
  'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
]);
function headers(source: IncomingHttpHeaders): IncomingHttpHeaders {
  const excluded = new Set(hopHeaders);
  for (const token of (source.connection || '').split(',')) excluded.add(token.trim().toLowerCase());
  return Object.fromEntries(Object.entries(source).filter(([name]) => !excluded.has(name)));
}

export interface LocalGateway {
  addresses: { host: '127.0.0.1'; port: number }[];
  close(): Promise<void>;
}

/**
 * Call after the backend starts, then await close() before backend shutdown.
 * Every upstream exchange is single-attempt, with bounded buffering and a total
 * deadline including slow uploads/downloads. Redirects are returned, never followed.
 */
export async function startLocalGateway(
  config: LocalGatewayConfig,
  limits: LocalGatewayLimits = {},
): Promise<LocalGateway> {
  if (!config.enabled) return { addresses: [], close: async () => {} };
  // Validate again at the public API boundary, including callers not using env parsing.
  const validated = readLocalGatewayConfig({
    GATEWAY_ENABLED: 'true', GATEWAY_PORTS: config.ports.join(','), GATEWAY_TARGET: config.target,
  }, 1);
  const target = new URL(validated.target);
  const maxRequestBytes = limits.maxRequestBytes ?? 1024 * 1024;
  const maxResponseBytes = limits.maxResponseBytes ?? 16 * 1024 * 1024;
  const timeoutMs = limits.timeoutMs ?? 30_000;
  const maxConcurrent = limits.maxConcurrent ?? 32;
  for (const value of [maxRequestBytes, maxResponseBytes, timeoutMs, maxConcurrent])
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('GATEWAY_LIMIT_INVALID');
  const servers: Server[] = [];
  const cancellations = new Set<() => void>();
  let active = 0;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => closePromise ??= (async () => {
    closing = true;
    for (const cancel of cancellations) cancel();
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    })));
  })();
  try {
    for (const listenerPort of validated.ports) {
      const server = http.createServer((req, res) => {
        const reject = (status: number) => {
          res.writeHead(status, { connection: 'close', 'content-type': 'text/plain' });
          res.end(`Gateway ${status}`);
          req.resume();
        };
        // The proxy cannot be used as a forward proxy, CONNECT tunnel, or upgrade relay.
        if (!req.url?.startsWith('/') || req.url.startsWith('//')) return reject(400);
        if (closing || active >= maxConcurrent) return reject(503);
        active++;
        let finished = false;
        let upstream: http.ClientRequest | undefined;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          cancellations.delete(cancel);
          active--;
          upstream?.destroy();
        };
        const cancel = () => { finish(); res.destroy(); };
        const fail = (status: number) => {
          if (finished) return;
          finish();
          if (!res.destroyed) reject(status);
        };
        const timer = setTimeout(() => fail(504), timeoutMs);
        timer.unref();
        cancellations.add(cancel);
        res.once('close', finish);
        res.once('finish', finish);
        req.once('aborted', cancel);
        req.once('error', cancel);
        void (async () => {
          const body: Buffer[] = [];
          let size = 0;
          const declared = Number(req.headers['content-length']);
          if (declared > maxRequestBytes) return fail(413);
          for await (const chunk of req.iterator({ destroyOnReturn: false })) {
            if (finished) return;
            size += chunk.length;
            if (size > maxRequestBytes) return fail(413);
            body.push(Buffer.from(chunk));
          }
          if (finished) return;
          const outgoing = headers(req.headers);
          // Preserve Host/Origin/cookies for the application's existing origin/auth policy.
          // Ignore forwarding metadata supplied by clients; do not create proxy trust.
          for (const name of Object.keys(outgoing))
            if (name.startsWith('x-forwarded-') || name === 'forwarded') delete outgoing[name];
          delete outgoing.expect;
          delete outgoing['content-length'];
          outgoing['content-length'] = String(size);
          upstream = http.request({
            hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port,
            method: req.method, path: req.url, headers: outgoing, agent: false,
          }, (response) => {
            const chunks: Buffer[] = [];
            let received = 0;
            response.on('data', (chunk: Buffer) => {
              received += chunk.length;
              if (received > maxResponseBytes) { response.destroy(); fail(502); }
              else chunks.push(chunk);
            });
            response.once('error', () => fail(502));
            response.once('aborted', () => fail(502));
            response.once('end', () => {
              if (finished) return;
              const replyHeaders = headers(response.headers);
              res.writeHead(response.statusCode || 502, response.statusMessage, replyHeaders);
              res.end(Buffer.concat(chunks));
            });
          });
          upstream.once('error', () => fail(502));
          upstream.end(Buffer.concat(body));
        })().catch(() => fail(502));
      });
      server.headersTimeout = Math.min(timeoutMs, 60_000);
      server.requestTimeout = timeoutMs;
      server.on('connect', (_req, socket) => socket.destroy());
      server.on('upgrade', (_req, socket) => socket.destroy());
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        const error = (cause: Error) => reject(cause);
        server.once('error', error);
        server.listen(listenerPort, '127.0.0.1', () => {
          server.off('error', error);
          resolve();
        });
      });
    }
    return { addresses: validated.ports.map((value) => ({ host: '127.0.0.1', port: value })), close };
  } catch (error) {
    await close();
    throw error;
  }
}
