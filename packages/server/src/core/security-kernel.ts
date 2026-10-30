import type express from 'express';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

/** Application request boundary, not an OS kernel or a compliance certification. */
export interface SecurityKernelAuditEvent {
  requestId: string;
  method: string;
  status: number;
  durationMs: number;
  event: 'request.accepted' | 'request.completed' | 'request.rejected';
  reason?: string;
}
export interface SecurityKernelOptions {
  maxUrlBytes?: number;
  maxHeaderBytes?: number;
  maxHeaderCount?: number;
  maxContentLength?: number;
  /** Receives metadata only: never a URL, query, header, body or credential. */
  audit?: (event: SecurityKernelAuditEvent) => void | Promise<void>;
}
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const csp =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; frame-src 'self' https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'none'";
const controls = /[\u0000-\u001f\u007f-\u009f]/u;
function limit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError('Security kernel limits must be positive safe integers.');
  return value;
}
function validTarget(target: string, method: string): boolean {
  if (target === '*' && method === 'OPTIONS') return true;
  if (!target.startsWith('/') || controls.test(target) || target.includes('#')) return false;
  const question = target.indexOf('?');
  const pathname = question < 0 ? target : target.slice(0, question);
  const query = question < 0 ? '' : target.slice(question + 1);
  try {
    // Query separators and Unicode are data, not routing syntax. Reject invalid encoding
    // and decoded controls, but do not reject legitimate URL-valued query parameters.
    if (controls.test(decodeURIComponent(query))) return false;
    let decoded = pathname;
    for (let depth = 0; depth < 5; depth++) {
      if (controls.test(decoded) || decoded.includes('\\') || decoded.includes('//')) return false;
      if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) return false;
      if (/%(?:2f|5c)/i.test(decoded)) return false;
      const next = decodeURIComponent(decoded);
      if (next === decoded) return true;
      // A decoded literal percent is legal (e.g. /100%25); only peel actual escapes.
      if (!/%[0-9a-f]{2}/i.test(next)) {
        return (
          !controls.test(next) &&
          !next.includes('\\') &&
          !next.includes('//') &&
          !next.split('/').some((segment) => segment === '.' || segment === '..')
        );
      }
      decoded = next;
    }
    // Refuse excessive nested encoding instead of letting downstream decoders disagree.
    return false;
  } catch {
    return false;
  }
}

export function installSecurityKernel(app: express.Express, options: SecurityKernelOptions = {}): void {
  const maxUrlBytes = limit(options.maxUrlBytes, 16 * 1024);
  const maxHeaderBytes = limit(options.maxHeaderBytes, 32 * 1024);
  const maxHeaderCount = limit(options.maxHeaderCount, 100);
  // Allows existing multipart batches (10 images at 4 MiB each); body parsers retain
  // their own tighter limits. This is declared-length preflight, not stream metering.
  const maxContentLength = limit(options.maxContentLength, 64 * 1024 * 1024);
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((req, res, next) => {
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Never replace an already installed stricter CSP.
    if (!res.hasHeader('Content-Security-Policy')) res.setHeader('Content-Security-Policy', csp);
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const started = performance.now();
    let reason: string | undefined;
    let reported = false;
    const report = () => {
      if (reported) return;
      reported = true;
      if (!options.audit) return;
      try {
        const result = options.audit({
          requestId,
          method: methods.has(req.method) ? req.method : 'OTHER',
          status: res.writableFinished ? res.statusCode : 499,
          durationMs: Math.max(0, Math.round(performance.now() - started)),
          event: reason ? 'request.rejected' : 'request.completed',
          ...(reason ? { reason } : {}),
        });
        if (result) void Promise.resolve(result).catch(() => {});
      } catch {
        /* Audit sink failure must not expose details or bypass the boundary. */
      }
    };
    res.once('finish', report);
    res.once('close', report);
    const reject = (status: number, code: string) => {
      reason = code;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Connection', 'close');
      return res.status(status).json({ code, error: 'Request rejected by security policy.', requestId });
    };
    if (!methods.has(req.method)) {
      res.setHeader('Allow', [...methods].join(', '));
      return reject(405, 'HTTP_METHOD_REJECTED');
    }
    if (Buffer.byteLength(req.url, 'utf8') > maxUrlBytes) return reject(414, 'REQUEST_URL_TOO_LONG');
    if (!validTarget(req.url, req.method)) return reject(400, 'REQUEST_TARGET_REJECTED');
    const raw = req.rawHeaders;
    if (raw.length / 2 > maxHeaderCount) return reject(431, 'REQUEST_HEADERS_TOO_LARGE');
    let headerBytes = 2;
    const counts = new Map<string, number>();
    for (let i = 0; i < raw.length; i += 2) {
      const name = raw[i]!.toLowerCase();
      const value = raw[i + 1]!;
      headerBytes += Buffer.byteLength(raw[i]!, 'utf8') + Buffer.byteLength(value, 'utf8') + 4;
      counts.set(name, (counts.get(name) || 0) + 1);
      if (/[\r\n\u0000]/.test(value)) return reject(400, 'REQUEST_FRAMING_REJECTED');
    }
    if (headerBytes > maxHeaderBytes) return reject(431, 'REQUEST_HEADERS_TOO_LARGE');
    const length = req.headers['content-length'];
    const transfer = req.headers['transfer-encoding'];
    if (
      ['host', 'content-length', 'transfer-encoding'].some((name) => (counts.get(name) || 0) > 1) ||
      (length !== undefined && transfer !== undefined) ||
      (transfer !== undefined && transfer.toLowerCase() !== 'chunked')
    ) {
      return reject(400, 'REQUEST_FRAMING_REJECTED');
    }
    if (length !== undefined) {
      if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))
        return reject(400, 'REQUEST_FRAMING_REJECTED');
      if (Number(length) > maxContentLength) return reject(413, 'REQUEST_TOO_LARGE');
    }
    if (!options.audit) return next();
    // Await durable admission before entering routing. A failed sink fails closed.
    try {
      const admission = options.audit({
        requestId,
        method: req.method,
        status: 0,
        durationMs: 0,
        event: 'request.accepted',
      });
      void Promise.resolve(admission).then(
        () => {
          if (!res.destroyed && !res.writableEnded) next();
        },
        () => {
          if (!res.destroyed && !res.writableEnded) reject(503, 'SECURITY_AUDIT_UNAVAILABLE');
        },
      );
    } catch {
      return reject(503, 'SECURITY_AUDIT_UNAVAILABLE');
    }
  });
}
