import express from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  acceptCandidateSchema,
  chapterRequirementsSchema,
  requirementsSchema,
  runRequestSchema,
} from '../../../../../../shared/generation.js';
import { type Project } from '../../../../../../shared/types.js';
import { acceptCandidate, resolveRequirements, validateRequirements } from '../generation.js';
import { streamProgress } from '../stream-progress.js';
import type { FeatureService } from '../../../core/context.js';
import { createProjectOperations, inputError, invalidateSteps } from '../../projects/project-operations.js';
function runRequestHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function projectRequestKey(req: express.Request) {
  const key = req.get('Idempotency-Key');
  return key && /^[A-Za-z0-9_-]{8,128}$/.test(key) ? key : undefined;
}
export const generationService: FeatureService = {
  id: 'generation',
  register(app, context) {
    const { store, runner, modelProvider } = context;
    const { models, settings } = modelProvider;
    const { mutateProject } = createProjectOperations(store);
    app.get('/api/projects/:projectId/generation-progress', (_req, res) => {
      const project = res.locals.project as Project;
      res.setHeader('Cache-Control', 'no-store');
      res.json(streamProgress.snapshot({ scopeId: store.dir, projectId: project.id, runId: project.run?.status === 'running' ? project.run.id : '' }));
    });
    app.put('/api/projects/:projectId/requirements', (req, res) => {
      const v = z
        .object({
          requirements: requirementsSchema.optional(),
          chapterRequirements: chapterRequirementsSchema.optional(),
        })
        .strict()
        .refine((value) => value.requirements !== undefined || value.chapterRequirements !== undefined)
        .parse(req.body);
      const p = res.locals.project as Project;
      mutateProject(p, (draft) => {
        if (v.requirements !== undefined) draft.requirements = validateRequirements(v.requirements);
        if (v.chapterRequirements !== undefined) draft.chapterRequirements = v.chapterRequirements;
        for (const number of Object.keys(draft.chapterRequirements || {}))
          resolveRequirements(draft, Number(number));
        invalidateSteps(draft);
      });
      res.json(p);
    });
    app.post('/api/projects/:projectId/candidates/:candidateId/accept', (req, res) => {
      const v = acceptCandidateSchema.parse(req.body || {});
      const p = res.locals.project as Project;
      mutateProject(p, (draft) => {
        acceptCandidate(draft, req.params.candidateId, v.expectedRevision, v.acknowledgeReviewFailure);
        invalidateSteps(draft);
      });
      res.json(p);
    });
    app.delete('/api/projects/:projectId/candidates/:candidateId', (req, res) => {
      const p = res.locals.project as Project;
      if (!p.candidates?.some((candidate) => candidate.id === req.params.candidateId))
        throw inputError(404, 'CANDIDATE_NOT_FOUND', '候选版本不存在。');
      mutateProject(p, (draft) => {
        draft.candidates = draft.candidates!.filter((candidate) => candidate.id !== req.params.candidateId);
      });
      res.json(p);
    });
    app.get('/api/projects/:projectId/run-requests/:key', (req, res) => {
      const key = z
        .string()
        .regex(/^[A-Za-z0-9_-]{8,128}$/)
        .parse(req.params.key);
      const p = res.locals.project as Project;
      const admission = Object.hasOwn(p.runAdmissions || {}, key) ? p.runAdmissions![key] : undefined;
      if (!admission) throw inputError(404, 'RUN_REQUEST_NOT_FOUND', '未找到该请求的已接收记录。');
      const run = [p.run, ...(p.runHistory || [])].find((item) => item?.id === admission.runId);
      if (!run)
        throw Object.assign(
          inputError(
            410,
            'RUN_HISTORY_EXPIRED',
            '该请求曾被接收，详细记录已归档；不会重复执行。请检查已保存章节和恢复稿。',
          ),
          { runId: admission.runId },
        );
      res.json({ run, project: p });
    });
    app.post('/api/projects/:projectId/run', (req, res) => {
      const request = runRequestSchema.parse(req.body || {});
      const p = res.locals.project as Project;
      const suppliedKey = req.get('Idempotency-Key');
      const key = projectRequestKey(req);
      if (suppliedKey !== undefined && !key)
        throw inputError(400, 'INVALID_REQUEST_KEY', '请求标识格式不正确。');
      const requestHash = runRequestHash(request);
      const admission = key && Object.hasOwn(p.runAdmissions || {}, key) ? p.runAdmissions![key] : undefined;
      if (admission) {
        if (admission.requestHash !== requestHash)
          throw inputError(409, 'IDEMPOTENCY_CONFLICT', '该请求标识已用于不同的生成参数。');
        res.setHeader('X-Run-Id', admission.runId);
        return res.status(p.run?.id === admission.runId && p.run.status === 'running' ? 202 : 200).json(p);
      }
      const active = settings.activeModelId ? models.get(settings.activeModelId) : undefined;
      if (settings.mode === 'live' && (!active?.apiKey || !active.model || !active.baseUrl))
        return res.status(400).json({ error: '请先在模型库选择并配置当前模型。', code: 'MODEL_UNAVAILABLE' });
      const runtime = {
        ...settings,
        ...(active || {}),
        mode: settings.mode,
        modelProfiles: Array.from(models.values()),
      };
      const handle = runner.start(p, runtime, request, key ? { key, requestHash } : undefined);
      void handle.promise.catch(() => {
        console.error('工作流执行或持久化失败；请检查数据目录和任务状态。');
      });
      res.setHeader('X-Run-Id', handle.run.id);
      res.status(202).json(p);
    });
    app.post('/api/projects/:projectId/runs/:runId/resume', (req, res) => {
      const body = z.object({ snapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.body);
      const p = res.locals.project as Project;
      const active = settings.activeModelId ? models.get(settings.activeModelId) : undefined;
      const runtime = { ...settings, ...(active || {}), mode: settings.mode, modelProfiles: Array.from(models.values()) };
      const handle = runner.start(p, runtime, {}, undefined, { runId: String(req.params.runId), fingerprint: body.snapshotFingerprint });
      void handle.promise.catch(() => console.error('恢复任务执行或持久化失败；请检查任务状态。'));
      res.setHeader('X-Run-Id', handle.run.id);
      res.status(202).json(p);
    });
    app.post('/api/projects/:projectId/cancel', (req, res) => {
      runner.controllers.get(String(req.params.projectId))?.abort();
      res.json({ ok: true });
    });
  },
};
