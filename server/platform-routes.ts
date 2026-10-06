import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ProjectPlatformWorkLink, PlatformWork } from '../shared/platforms.js';
import type { Store } from './store.js';
import type { ConnectionRecord } from './platform-store.js';
import { PlatformRuntime, publicOperation } from './platform-runtime.js';
import { PlatformError, unsupported } from './platforms-types.js';

export function createPlatformRouter(store: Store, runtime: PlatformRuntime) {
  const router = Router();
  const fingerprintKey = randomBytes(32);
  const localOrigins = new Set([
    `http://127.0.0.1:${process.env.PORT || '3001'}`,
    `http://localhost:${process.env.PORT || '3001'}`,
    'http://127.0.0.1:5173',
    'http://localhost:5173',
  ]);
  const guarded = (req: Request, res: Response, next: NextFunction) => {
    const host = req.get('host'),
      origin = req.get('origin');
    if (
      !host ||
      !localOrigins.has(`http://${host}`) ||
      (origin && !localOrigins.has(origin)) ||
      req.get('sec-fetch-site') === 'cross-site'
    )
      throw new PlatformError(403, 'PLATFORM_ORIGIN_REJECTED', '平台接口仅允许指定的本机来源。');
    res.setHeader('Cache-Control', 'no-store');
    res.locals.requestId = randomUUID();
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.get('X-Platform-CSRF') !== runtime.csrfToken)
        throw new PlatformError(403, 'PLATFORM_CSRF_REQUIRED', '平台操作校验已过期，请刷新页面。');
      if (!req.is('application/json') && Number(req.get('content-length') || 0) > 0)
        throw new PlatformError(415, 'PLATFORM_JSON_REQUIRED', '平台操作仅接受 JSON 请求。');
    }
    // Session stays available even when platform storage is degraded: other local mutations use its CSRF token.
    if (req.path !== '/session' && req.path !== '/providers' && !runtime.status().available)
      throw new PlatformError(
        503,
        'PLATFORM_STORAGE_UNAVAILABLE',
        runtime.status().reason || '平台服务正在关闭。',
      );
    next();
  };
  router.use('/platforms', guarded);
  const base = '/projects/:projectId';
  for (const suffix of [
    'platform-connections',
    'platform-login',
    'platform-works',
    'platform-links',
    'platform-publications',
    'platform-drafts',
    'platform-operations',
    'platform-draft-receipts',
    'platform-chapters',
  ])
    router.use(`${base}/${suffix}`, guarded);
  router.param('projectId', (req, _res, next, id) => {
    const project = store.get(id);
    if (!project) throw new PlatformError(404, 'PROJECT_NOT_FOUND', '项目不存在。');
    if (req.method !== 'GET' && project.run?.status === 'running')
      throw new PlatformError(409, 'PROJECT_RUNNING', '请先停止工作流再进行平台操作。');
    next();
  });
  const pid = (req: Request) => String(req.params.projectId);
  const identifier = z.string().min(1).max(512);
  const operationKey = (req: Request) => {
    const key = req.get('Idempotency-Key');
    if (!key || !/^[\w-]{8,128}$/.test(key))
      throw new PlatformError(400, 'IDEMPOTENCY_KEY_REQUIRED', '请提供 8–128 位 Idempotency-Key。');
    return key;
  };
  const mutation =
    (fn: (req: Request) => Promise<unknown>, status = 200, idempotent = false) =>
    async (req: Request, res: Response) => {
      const projectId = pid(req);
      runtime.assertProjectIdle(projectId);
      const key = idempotent
        ? createHash('sha256')
            .update(`${projectId}:${req.method}:${req.path}:${operationKey(req)}`)
            .digest('hex')
        : undefined;
      const fingerprintBody = { ...req.body };
      if (typeof fingerprintBody.token === 'string')
        fingerprintBody.token = createHmac('sha256', fingerprintKey)
          .update(fingerprintBody.token)
          .digest('hex');
      const hash = createHash('sha256').update(JSON.stringify(fingerprintBody)).digest('hex');
      if (key) {
        const previous = runtime.platforms.operation(key);
        if (previous) {
          if (previous.hash !== hash)
            throw new PlatformError(
              409,
              'IDEMPOTENCY_CONFLICT',
              '该幂等键已用于不同参数或上次服务会话，请先检查现有结果。',
            );
          if (['pending', 'unknown'].includes(previous.state))
            throw new PlatformError(
              409,
              'PLATFORM_OPERATION_UNKNOWN',
              '上次操作结果未知，请先刷新现有记录，不要重复创建。',
            );
          res.status(previous.status || 200).json(previous.body);
          return;
        }
      }
      await runtime.withLock(projectId, undefined, async () => {
        if (key) runtime.platforms.putOperation(key, { projectId, hash, state: 'pending' });
        try {
          const body = await fn(req);
          if (key) runtime.platforms.putOperation(key, { projectId, hash, state: 'succeeded', status, body });
          res.status(status).json(body);
        } catch (error) {
          if (key)
            runtime.platforms.putOperation(
              key,
              error instanceof PlatformError || error instanceof z.ZodError
                ? {
                    projectId,
                    hash,
                    state: 'failed',
                    status: error instanceof PlatformError ? error.status : 400,
                    body: {
                      error: error instanceof PlatformError ? error.message : '平台请求参数无效。',
                      code: error instanceof PlatformError ? error.code : 'PLATFORM_VALIDATION_ERROR',
                      retryable: false,
                    },
                  }
                : { projectId, hash, state: 'unknown' },
            );
          throw error;
        }
      });
    };
  const recordFor = (req: Request) => runtime.connection(pid(req), String(req.params.connectionId));
  const linkFor = (projectId: string, id: string) => {
    const link = runtime.platforms.links(projectId).find((item) => item.id === id);
    if (!link) throw new PlatformError(404, 'PLATFORM_LINK_NOT_FOUND', '作品绑定不存在。');
    return link;
  };
  const updateLink = (link: ProjectPlatformWorkLink, work: PlatformWork) => {
    const next = {
      ...link,
      title: work.title,
      revision: work.revision,
      lastSyncedAt: new Date().toISOString(),
    };
    runtime.platforms.putLink(next);
    return next;
  };
  const workInput = z.object({
    title: z.string().trim().min(1).max(120),
    description: z.string().max(2000).default(''),
    genre: z.string().max(80).default(''),
  });

  router.get('/platforms/providers', (_req, res) => res.json(runtime.registry.providers()));
  router.get('/platforms/session', (_req, res) => res.json(runtime.status()));
  router.get(`${base}/platform-connections`, (req, res) =>
    res.json(runtime.platforms.connections(pid(req)).map((record) => runtime.publicConnection(record))),
  );
  router.post(
    `${base}/platform-connections/:providerId/token`,
    mutation(
      async (req) => {
        const adapter = runtime.registry.get(String(req.params.providerId));
        if (!adapter.provider.capabilities.connectToken) unsupported(adapter.provider, 'connectToken');
        const { token } = z
          .object({ token: z.string().trim().min(1).max(4000) })
          .strict()
          .parse(req.body);
        const account = await adapter.connect({ token });
        const record: ConnectionRecord = {
          id: randomUUID(),
          projectId: pid(req),
          providerId: adapter.provider.id,
          ...account,
          capabilities: { paired: true, accountVerified: true, listWorks: true, saveDraft: false },
          credentialRef: randomUUID(),
          createdAt: new Date().toISOString(),
          authKind: 'mock_token',
        };
        runtime.secrets.set(record.credentialRef, token);
        try {
          runtime.platforms.putConnection(record);
        } catch (error) {
          runtime.secrets.delete(record.credentialRef);
          throw error;
        }
        return runtime.publicConnection(record);
      },
      201,
      true,
    ),
  );
  router.put(
    `${base}/platform-connections/:connectionId/credential`,
    mutation(
      async (req) => {
        const record = recordFor(req),
          adapter = runtime.registry.get(record.providerId);
        if (!adapter.provider.capabilities.connectToken) unsupported(adapter.provider, 'connectToken');
        const { token } = z
          .object({ token: z.string().trim().min(1).max(4000) })
          .strict()
          .parse(req.body);
        const account = await adapter.connect({ token });
        // Legacy mock account IDs are local scoped IDs; a mock token never represents a real identity.
        if (record.providerId !== 'mock' && account.accountId !== record.accountId)
          throw new PlatformError(409, 'PLATFORM_ACCOUNT_MISMATCH', '重新授权的账号与原连接不同。');
        const credentialRef = randomUUID();
        runtime.secrets.set(credentialRef, token);
        const next = {
          ...record,
          credentialRef,
          needsReauth: false,
          lastCheckedAt: new Date().toISOString(),
        };
        try {
          runtime.platforms.putConnection(next);
        } catch (error) {
          runtime.secrets.delete(credentialRef);
          throw error;
        }
        runtime.secrets.delete(record.credentialRef);
        return runtime.publicConnection(next);
      },
      200,
      true,
    ),
  );
  router.post(
    `${base}/platform-connections/:providerId/oauth/start`,
    mutation(async (req) =>
      unsupported(runtime.registry.get(String(req.params.providerId)).provider, 'oauth'),
    ),
  );
  router.post(`${base}/platform-connections/tomato/login/start`, async (req, res) => {
    const input = z
      .object({ connectionId: identifier.optional() })
      .strict()
      .parse(req.body ?? {});
    res.status(201).json(await runtime.startLogin(pid(req), input.connectionId));
  });
  router.get(`${base}/platform-login/:loginId`, (req, res) =>
    res.json(runtime.login(pid(req), String(req.params.loginId))),
  );
  router.post(`${base}/platform-login/:loginId/complete`, async (req, res) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    res.json(await runtime.completeLogin(pid(req), String(req.params.loginId)));
  });
  router.delete(`${base}/platform-login/:loginId`, async (req, res) => {
    await runtime.cancelLogin(pid(req), String(req.params.loginId));
    res.json({ ok: true });
  });
  router.post(`${base}/platform-connections/:connectionId/test`, async (req, res) => {
    const record = recordFor(req);
    runtime.assertProjectIdle(pid(req));
    res.json(await runtime.withLock(pid(req), record, () => runtime.testConnection(record)));
  });
  router.delete(`${base}/platform-connections/:connectionId`, async (req, res) => {
    await runtime.removeConnection(pid(req), String(req.params.connectionId));
    res.json({ ok: true });
  });
  router.get(`${base}/platform-works`, async (req, res) => {
    const record = runtime.connection(pid(req), identifier.parse(req.query.connectionId));
    runtime.assertProjectIdle(pid(req));
    res.json(await runtime.withLock(pid(req), record, () => runtime.listWorks(record)));
  });
  router.get(`${base}/platform-works/:workId`, async (req, res) => {
    const record = runtime.connection(pid(req), identifier.parse(req.query.connectionId));
    runtime.assertProjectIdle(pid(req));
    res.json(await runtime.withLock(pid(req), record, () => runtime.work(record, String(req.params.workId))));
  });
  router.post(
    `${base}/platform-works`,
    mutation(
      async (req) => {
        const input = workInput.extend({ connectionId: identifier }).strict().parse(req.body);
        const record = runtime.connection(pid(req), input.connectionId),
          adapter = runtime.registry.get(record.providerId);
        if (!adapter.createWork) return unsupported(adapter.provider, 'createWork');
        const { connectionId: _id, ...values } = input;
        return adapter.createWork(runtime.credential(record), values, record.id);
      },
      201,
      true,
    ),
  );
  router.patch(
    `${base}/platform-works/:workId`,
    mutation(
      async (req) => {
        const input = workInput
          .partial()
          .extend({ connectionId: identifier, expectedRevision: identifier })
          .strict()
          .parse(req.body);
        const record = runtime.connection(pid(req), input.connectionId),
          adapter = runtime.registry.get(record.providerId);
        if (!adapter.updateWork) return unsupported(adapter.provider, 'updateWork');
        const work = await runtime.work(record, String(req.params.workId));
        if (work.revision !== input.expectedRevision)
          throw new PlatformError(412, 'PLATFORM_REVISION_CONFLICT', '作品版本已变化，请刷新后再编辑。');
        const { connectionId: _id, expectedRevision: _revision, ...values } = input;
        const updated = await adapter.updateWork(runtime.credential(record), work, values);
        runtime.platforms.putWork(record.id, updated);
        return updated;
      },
      200,
      true,
    ),
  );
  router.get(`${base}/platform-links`, (req, res) => res.json(runtime.platforms.links(pid(req))));
  router.post(`${base}/platform-links`, async (req, res) => {
    const input = z.object({ connectionId: identifier, remoteWorkId: identifier }).strict().parse(req.body);
    const record = runtime.connection(pid(req), input.connectionId);
    runtime.assertProjectIdle(pid(req));
    res.status(201).json(
      await runtime.withLock(pid(req), record, async () => {
        const work = await runtime.work(record, input.remoteWorkId);
        const existing = runtime.platforms
          .links(pid(req))
          .find((link) => link.connectionId === record.id && link.remoteWorkId === work.id);
        if (existing) return existing;
        return updateLink(
          {
            id: randomUUID(),
            projectId: pid(req),
            connectionId: record.id,
            providerId: record.providerId,
            accountId: record.accountId,
            remoteWorkId: work.id,
            title: work.title,
            revision: work.revision,
            lastSyncedAt: '',
          },
          work,
        );
      }),
    );
  });
  router.post(`${base}/platform-links/:linkId/sync`, async (req, res) => {
    const link = linkFor(pid(req), String(req.params.linkId)),
      record = runtime.connection(pid(req), link.connectionId);
    runtime.assertProjectIdle(pid(req));
    res.json(
      await runtime.withLock(pid(req), record, async () =>
        updateLink(link, await runtime.work(record, link.remoteWorkId)),
      ),
    );
  });
  router.delete(
    `${base}/platform-links/:linkId`,
    mutation(async (req) => {
      const link = linkFor(pid(req), String(req.params.linkId));
      if (
        runtime.platforms
          .draftOperations(pid(req))
          .some(
            (operation) =>
              operation.connectionId === link.connectionId &&
              operation.remoteWorkId === link.remoteWorkId &&
              ['unknown', 'queued', 'running'].includes(operation.state),
          )
      )
        throw new PlatformError(
          409,
          'PLATFORM_OPERATION_UNKNOWN',
          '该作品有未知或在途草稿，请先核对再解绑。',
        );
      runtime.platforms.deleteLink(link.id);
      return { ok: true };
    }),
  );
  router.get(`${base}/platform-chapters`, (req, res) => res.json(runtime.chapterChoices(pid(req))));
  router.post(`${base}/platform-drafts/prepare`, async (req, res) => {
    const input = z.object({ linkId: identifier, chapterId: identifier }).strict().parse(req.body);
    runtime.assertProjectIdle(pid(req));
    res.status(201).json(await runtime.prepare(pid(req), input.linkId, input.chapterId));
  });
  router.post(`${base}/platform-drafts/execute`, (req, res) => {
    const input = z
      .object({
        preparationId: identifier,
        contentHash: z.string().regex(/^[a-f0-9]{64}$/),
        approved: z.literal(true),
      })
      .strict()
      .parse(req.body);
    const operation = runtime.execute(pid(req), input.preparationId, input.contentHash, operationKey(req));
    res.status(['queued', 'running'].includes(operation.state) ? 202 : 200).json(operation);
  });
  router.get(`${base}/platform-operations`, (req, res) =>
    res.json(runtime.platforms.draftOperations(pid(req)).map(publicOperation)),
  );
  router.get(`${base}/platform-operations/:operationId`, (req, res) => {
    const operation = runtime.platforms.draftOperation(pid(req), String(req.params.operationId));
    if (!operation) throw new PlatformError(404, 'PLATFORM_OPERATION_NOT_FOUND', '草稿操作不存在。');
    res.json(publicOperation(operation));
  });
  router.post(`${base}/platform-operations/:operationId/reconcile`, async (req, res) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    runtime.assertProjectIdle(pid(req));
    res.json(await runtime.reconcile(pid(req), String(req.params.operationId)));
  });
  router.get(`${base}/platform-draft-receipts`, (req, res) => res.json(runtime.platforms.receipts(pid(req))));
  // Old clients cannot revive simulated publications or an implicit bulk-upload endpoint.
  router.post(`${base}/platform-publications`, (_req, _res) => {
    throw new PlatformError(
      410,
      'PLATFORM_PUBLICATION_DISABLED',
      '正式发布不在本工具范围内。请选择单章草稿预览并明确确认；旧本地发布记录已归档。',
      'publishChapter',
    );
  });
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof PlatformError ? error.status : error instanceof z.ZodError ? 400 : 500;
    res.status(status).json({
      error:
        error instanceof PlatformError
          ? error.message
          : status === 400
            ? '平台请求参数无效。'
            : '平台操作失败，请检查本机配置；不要盲目重发草稿。',
      code:
        error instanceof PlatformError
          ? error.code
          : status === 400
            ? 'PLATFORM_VALIDATION_ERROR'
            : 'PLATFORM_INTERNAL_ERROR',
      capability: error instanceof PlatformError ? error.capability : undefined,
      requestId: res.locals.requestId,
      retryable: false,
    });
  });
  return router;
}
