import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { GenerationError } from '../generation.js';
import type { ServiceContext } from './context.js';
export function installHttpPolicy(app: express.Express, context: ServiceContext, port: number) {
  const { dir, platformRuntime } = context;
  const privateHost = (hostname: string) =>
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);
  const allowedOrigin = (value: string) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'http:' && ['5173', String(port)].includes(url.port) && privateHost(url.hostname)
      );
    } catch {
      return false;
    }
  };
  app.use((req, res, next) => {
    const origin = req.get('origin');
    const host = req.get('host') || '';
    if (
      !allowedOrigin(`http://${host}`) ||
      (origin && !allowedOrigin(origin)) ||
      req.get('sec-fetch-site') === 'cross-site'
    )
      return res.status(403).json({ error: '只允许本机或局域网来源访问。', code: 'LOCAL_ORIGIN_REJECTED' });
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      if (
        !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
        req.get('X-Platform-CSRF') !== platformRuntime.csrfToken
      )
        return res
          .status(403)
          .json({ error: '操作校验已过期，请刷新页面后重试。', code: 'PLATFORM_CSRF_REQUIRED' });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });
  const requestWindows = new Map<string, number[]>();
  app.use('/api', (req, res, next) => {
    const now = Date.now();
    const key = req.ip || 'local';
    const recent = (requestWindows.get(key) || []).filter((time) => now - time < 60_000);
    recent.push(now);
    requestWindows.set(key, recent);
    if (recent.length > 240)
      return res
        .status(429)
        .json({ error: '本机请求过于频繁，请稍后重试。', code: 'RATE_LIMITED', retryable: true });
    next();
  });
  app.use(express.json({ limit: '16mb' }));
  app.use(
    '/uploads',
    express.static(path.join(dir, 'uploads'), {
      setHeaders(res) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
      },
    }),
  );
}
export function installHttpFallbacks(app: express.Express, root: string) {
  const staticDir = path.join(root, 'dist');
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在。', code: 'NOT_FOUND' }));
  if (fs.existsSync(path.join(staticDir, 'index.html'))) {
    app.use(
      express.static(staticDir, {
        setHeaders(res, filePath) {
          const fileName = path.basename(filePath);
          if (/-[a-z0-9_-]{8,}\.(?:css|js|woff2?|png|jpe?g|svg|webp)$/i.test(fileName)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );
    app.get('/{*path}', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    if (err instanceof GenerationError)
      return res.status(err.status).json({
        error: err.message,
        code: err.code,
        retryable: err.retryable,
        conflicts: err.conflicts,
        requestId,
      });
    if (err instanceof z.ZodError)
      return res.status(400).json({
        error: '输入无效：' + err.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；'),
        code: 'INVALID_INPUT',
        retryable: false,
        requestId,
      });
    if (err instanceof multer.MulterError)
      return res.status(413).json({
        error: '上传超出限制：每批最多 10 个文件，文本不超过 2 MiB，图片不超过 4 MiB。',
        code: err.code,
      });
    if (err && typeof err === 'object' && 'type' in err && err.type === 'entity.too.large')
      return res
        .status(413)
        .json({ error: '请求内容过大：文本资料不能超过 2 MiB。', code: 'REQUEST_TOO_LARGE' });
    if (
      err instanceof Error &&
      'status' in err &&
      typeof err.status === 'number' &&
      err.status >= 400 &&
      err.status < 500
    ) {
      const detail = err as Error & {
        status: number;
        code?: string;
        conflicts?: number[];
        graphRevision?: number;
        retryable?: boolean;
        runId?: string;
      };
      return res.status(detail.status).json({
        error: detail.message,
        code: detail.code,
        conflicts: detail.conflicts,
        graphRevision: detail.graphRevision,
        retryable: detail.retryable,
        runId: detail.runId,
      });
    }
    console.error('服务操作失败，请检查数据目录可用性与配置。');
    res.status(500).json({
      error: '服务操作未完成，请先查询当前状态，再检查服务日志。',
      code: 'INTERNAL_ERROR',
      retryable: false,
      requestId,
    });
  });
}
