import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { installWebHosting, type WebHostingOptions } from './web-hosting.js';
import path from 'node:path';
import { z } from 'zod';
import { GenerationError } from '../features/generation/generation.js';
import type { ServiceContext } from './context.js';
import { createOriginPolicy } from './trusted-origin.js';
import { safeUploadReader } from '../features/file-sandbox/safe-read.js';
import { createRequestLimiter } from './request-limiter.js';
import { installSecurityKernel, type SecurityKernelOptions } from './security-kernel.js';
export function installHttpPolicy(app: express.Express, context: ServiceContext | undefined, port: number, aliasPorts: readonly number[] = [], securityKernel: SecurityKernelOptions = {}) {
  installSecurityKernel(app, securityKernel);
  const originAllowed = createOriginPolicy(port, undefined, aliasPorts);
  app.use((req, res, next) => {
    if (!originAllowed(req))
      return res.status(403).json({ error: '只允许本机或局域网来源访问。', code: 'LOCAL_ORIGIN_REJECTED' });
    const requestPath = req.path.toLowerCase();
    if (requestPath === '/api' || requestPath.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      if (
        context &&
        !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
        req.get('X-Platform-CSRF') !== context.platformRuntime.csrfToken
      )
        return res
          .status(403)
          .json({ error: '操作校验已过期，请刷新页面后重试。', code: 'PLATFORM_CSRF_REQUIRED' });
    }
    next();
  });
  const requestLimiter = createRequestLimiter();
  app.use('/api', (req, res, next) => {
    const result = requestLimiter.check(req.ip || 'local');
    if (!result.allowed)
      return res
        .status(429)
        .setHeader('Retry-After', String(result.retryAfter))
        .json({ error: '请求过于频繁，请稍后重试。', code: 'RATE_LIMITED', retryable: true });
    next();
  });
  app.use(express.json({ limit: '16mb' }));
  if (context)
    app.use(
      '/uploads',
      safeUploadReader(path.join(context.dir, 'uploads')),
      (_req, res) => res.status(404).json({ code: 'UPLOAD_NOT_FOUND', error: '文件不存在。' }),
    );
}
export function installHttpFallbacks(app: express.Express, root: string, options: WebHostingOptions = {}) {
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在。', code: 'NOT_FOUND' }));
  installWebHosting(app, root, options);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : randomUUID();
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
