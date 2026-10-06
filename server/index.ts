import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  SYSTEM_END_NODE_ID,
  SYSTEM_START_NODE_ID,
  categories,
  modelProtocols,
  type ModelProfile,
  type Project,
} from '../shared/types.js';
import {
  createProject,
  createWorkflow,
  createWorkflowGraph,
  createWorldWorkflowGraph,
  normalizeWorkflow,
  syncActiveWorkflow,
} from './defaults.js';
import { Store } from './store.js';
import {
  Runner,
  assertPublicModelUrl,
  deriveOutputName,
  normalizeProtocol,
  type RuntimeSettings,
} from './engine.js';
import { createPlatformRouter } from './platform-routes.js';
import { ModelSecretStore } from './secrets.js';
import { IMAGE_ASSET_MAX_BYTES, TEXT_ASSET_MAX_BYTES, utf8ByteLength } from '../shared/limits.js';
import {
  runRequestSchema,
  requirementsSchema,
  chapterRequirementsSchema,
  acceptCandidateSchema,
} from '../shared/generation.js';
import { GenerationError, acceptCandidate, validateRequirements, resolveRequirements } from './generation.js';
import { validateGraph, downstreamIds } from './workflow-graph.js';
import { PlatformRuntime } from './platform-runtime.js';
import { appRoot, acquireDataLock } from './local-runtime.js';
try {
  process.loadEnvFile(path.join(appRoot, '.env'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const port = Number(process.env.PORT || 3001);
const dir = path.resolve(appRoot, process.env.DATA_DIR || 'data');
const releaseDataLock = acquireDataLock(dir);
process.once('exit', releaseDataLock);
const store = new Store(dir);
const platformRuntime = new PlatformRuntime(store);
const runner = new Runner(store);
const models = new Map<string, RuntimeSettings>();
const modelSecrets = new ModelSecretStore(dir);
const defaultModelId = 'default';
const modelsFile = path.join(dir, 'models.json');
const savedModelState = (() => {
  if (!fs.existsSync(modelsFile)) return { models: [] as RuntimeSettings[], activeModelId: '' };
  try {
    const parsed = JSON.parse(fs.readFileSync(modelsFile, 'utf8')) as
      | RuntimeSettings[]
      | { models?: RuntimeSettings[]; activeModelId?: string };
    if (Array.isArray(parsed)) return { models: parsed, activeModelId: '' };
    return { models: Array.isArray(parsed.models) ? parsed.models : [], activeModelId: parsed.activeModelId || '' };
  } catch {
    return { models: [] as RuntimeSettings[], activeModelId: '' };
  }
})();
const savedModels = savedModelState.models;
const savedDefault = savedModels.find((model) => (model.id || defaultModelId) === defaultModelId);
const settings: RuntimeSettings = {
  baseUrl: savedDefault?.baseUrl || process.env.MODEL_BASE_URL || 'https://api.openai.com/v1',
  model: savedDefault?.model || process.env.MODEL_NAME || 'gpt-4.1-mini',
  apiKey: '',
  hasKey: false,
  mode: savedDefault?.mode || (process.env.MODEL_API_KEY ? 'live' : 'demo'),
  activeModelId: savedModelState.activeModelId || savedDefault?.id || defaultModelId,
  protocol: normalizeProtocol(savedDefault?.protocol || process.env.MODEL_PROTOCOL),
};
if (!savedModels.length)
  models.set(defaultModelId, { ...settings, id: defaultModelId, name: '默认模型' });
for (const model of savedModels) {
  const id = model.id || defaultModelId;
  const restoredKey = modelSecrets.get(id) || (id === defaultModelId ? process.env.MODEL_API_KEY || '' : '');
  models.set(id, {
    ...model,
    id,
    protocol: normalizeProtocol(model.protocol),
    apiKey: restoredKey,
    hasKey: !!restoredKey,
    mode: model.mode || settings.mode,
  });
}
{
  const active = models.get(settings.activeModelId || '') || models.values().next().value;
  if (active)
    Object.assign(settings, active, {
      apiKey: active.apiKey,
      hasKey: !!active.apiKey,
      activeModelId: active.id,
    });
}
const saveModels = () => {
  const safe = {
    activeModelId: settings.activeModelId,
    models: Array.from(models.values()).map(({ apiKey: _apiKey, ...model }) => model),
  };
  fs.writeFileSync(modelsFile + '.tmp', JSON.stringify(safe, null, 2));
  fs.renameSync(modelsFile + '.tmp', modelsFile);
};
const app = express();
const localOrigins = new Set([
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
  'http://127.0.0.1:5173',
  'http://localhost:5173',
]);
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (
    !localOrigins.has(`http://${req.get('host')}`) ||
    (origin && !localOrigins.has(origin)) ||
    req.get('sec-fetch-site') === 'cross-site'
  )
    return res.status(403).json({ error: '只允许指定的本机来源访问。', code: 'LOCAL_ORIGIN_REJECTED' });
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
const publicModel = (m: RuntimeSettings): ModelProfile => ({
  id: m.id || defaultModelId,
  name: m.name || '未命名模型',
  baseUrl: m.baseUrl,
  model: m.model,
  protocol: normalizeProtocol(m.protocol),
  hasKey: !!m.apiKey,
  enabled: m.enabled !== false,
  createdAt: m.createdAt || new Date().toISOString(),
});
const publicSettings = () => ({
  baseUrl: settings.baseUrl,
  model: settings.model,
  mode: settings.mode,
  protocol: normalizeProtocol(settings.protocol),
  hasKey: !!settings.apiKey,
  activeModelId: settings.activeModelId || defaultModelId,
  models: Array.from(models.values()).map(publicModel),
});
const protocolSchema = z.enum(modelProtocols);
const nodeIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, '节点 ID 仅支持字母、数字、下划线和短横线。');
function persistProject(p: Project) {
  syncActiveWorkflow(p);
  store.touch(p);
}
function mutateProject(p: Project, change: (draft: Project) => void) {
  const snapshot = structuredClone(p);
  const draft = structuredClone(p);
  change(draft);
  syncActiveWorkflow(draft);
  Object.assign(p, draft);
  try {
    store.touch(p);
  } catch (error) {
    for (const key of Object.keys(p)) delete (p as unknown as Record<string, unknown>)[key];
    Object.assign(p, snapshot);
    throw error;
  }
}
function inputError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code });
}
function runRequestHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function projectRequestKey(req: express.Request) {
  const key = req.get('Idempotency-Key');
  return key && /^[A-Za-z0-9_-]{8,128}$/.test(key) ? key : undefined;
}
function checkWorkflow(p: Project, v: { workflowId?: string; expectedGraphRevision?: number }) {
  if (v.workflowId !== undefined && v.workflowId !== p.activeWorkflowId)
    throw inputError(409, 'WORKFLOW_CONFLICT', '活动工作流已改变，请刷新后重试。');
  if (v.expectedGraphRevision !== undefined && v.expectedGraphRevision !== (p.workflow?.graphRevision || 0))
    throw Object.assign(inputError(409, 'GRAPH_CONFLICT', '工作流已被修改，请刷新后重试。'), {
      graphRevision: p.workflow?.graphRevision || 0,
    });
}
function invalidateSteps(p: Project, ids?: Set<string>) {
  for (const step of p.steps)
    if (!ids || ids.has(step.id)) {
      step.status = 'idle';
      step.output = '';
      delete step.generationContext;
    }
}
function updateGraph(
  p: Project,
  v: { workflowId?: string; expectedGraphRevision?: number },
  change: (draft: Project) => void,
) {
  checkWorkflow(p, v);
  mutateProject(p, (draft) => {
    change(draft);
    draft.workflow ||= createWorkflow([]);
    draft.workflow.graphRevision = (p.workflow?.graphRevision || 0) + 1;
    validateGraph(draft);
  });
}
const graphScopeSchema = {
  workflowId: z.string().min(1).optional(),
  expectedGraphRevision: z.number().int().min(0).optional(),
};
const editableStepSchema = z
  .object({
    id: nodeIdSchema,
    title: z.string().trim().min(1).max(100),
    subtitle: z.string().max(300),
    prompt: z.string().max(12000),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }),
    kind: z
      .enum(['agent', 'start', 'end', 'audit', 'writer', 'custom', 'world', 'outline', 'plan', 'expand'])
      .optional(),
    outputName: z.string().trim().max(120).optional(),
    modelId: z.string().optional(),
    assetIds: z.array(z.string()).max(100).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
const edgesSchema = z
  .array(
    z.object({
      id: z.string().min(1),
      source: z.string().min(1),
      target: z.string().min(1),
      label: z.string().optional(),
    }),
  )
  .max(500);
const editableWorkflowSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    edges: edgesSchema.optional(),
    auditNodeId: z.string().optional(),
    outputWriterNodeId: z.string().optional(),
    outputName: z.string().trim().max(120).optional(),
    chapterCount: z.number().int().min(1).max(1000).optional(),
    autoGenerate: z.boolean().optional(),
  })
  .strict();
function removeWorkflowItems(p: Project, nodeIds: string[], edgeIds: string[]) {
  const nodes = [...new Set(nodeIds)];
  const edges = [...new Set(edgeIds)];
  if (!nodes.length && !edges.length)
    throw Object.assign(new Error('请选择要删除的节点或连线。'), { status: 400 });
  if (nodes.length > 200 || edges.length > 500)
    throw Object.assign(new Error('一次删除的节点或连线过多。'), { status: 400 });
  const missing = nodes.filter((id) => !p.steps.some((s) => s.id === id));
  if (missing.length) throw Object.assign(new Error(`节点不存在：${missing.join('、')}。`), { status: 404 });
  p.workflow ||= createWorkflow([]);
  normalizeWorkflow(p);
  const protectedIds = new Set([SYSTEM_START_NODE_ID, SYSTEM_END_NODE_ID]);
  const protectedNodes = nodes.filter((id) => protectedIds.has(id));
  if (protectedNodes.length) {
    const labels = protectedNodes.map((id) => (id === p.workflow?.startNodeId ? '开始节点' : '结束节点'));
    throw Object.assign(new Error(`${labels.join('、')}不可删除，请先在工作流设置中更换节点。`), {
      status: 400,
    });
  }
  const removeNodes = new Set(nodes);
  const removeEdges = new Set(edges);
  p.steps = p.steps.filter((s) => !removeNodes.has(s.id));
  p.workflow.edges = (p.workflow.edges || []).filter(
    (e) => !removeEdges.has(e.id) && !removeNodes.has(e.source) && !removeNodes.has(e.target),
  );
  normalizeWorkflow(p);
}
app.use('/api', createPlatformRouter(store, platformRuntime));
app.get('/api/health', (_req, res) => res.json({ ok: true, platform: platformRuntime.status() }));
app.get('/api/settings', (_req, res) => res.json(publicSettings()));
app.put('/api/settings', (req, res) => {
  const v = z
    .object({
      baseUrl: z
        .url()
        .refine((value) => /^https?:\/\//.test(value))
        .refine((value) => {
          assertPublicModelUrl(value);
          return true;
        }),
      model: z.string().trim().min(1).max(100),
      mode: z.enum(['demo', 'live']),
      protocol: protocolSchema.optional(),
      apiKey: z.string().max(1000).optional(),
      clearKey: z.boolean().optional(),
      activeModelId: z.string().optional(),
    })
    .parse(req.body);
  const targetId = v.activeModelId && models.has(v.activeModelId) ? v.activeModelId : settings.activeModelId;
  const target = targetId ? models.get(targetId) : undefined;
  if (!target) return res.status(404).json({ error: '当前模型不存在，请先添加模型。' });
  settings.activeModelId = target.id;
  target.baseUrl = v.baseUrl.replace(/\/$/, '');
  target.model = v.model;
  target.mode = v.mode;
  if (v.protocol) target.protocol = v.protocol;
  if (v.clearKey) {
    target.apiKey = '';
    modelSecrets.delete(target.id!);
  } else if (v.apiKey) {
    target.apiKey = v.apiKey;
    modelSecrets.set(target.id!, v.apiKey);
  }
  target.hasKey = !!target.apiKey;
  Object.assign(settings, target, { activeModelId: target.id });
  saveModels();
  res.json(publicSettings());
});
app.get('/api/models', (_req, res) => res.json(publicSettings().models));
app.post('/api/models', (req, res) => {
  const v = z
    .object({
      name: z.string().trim().min(1).max(100),
      baseUrl: z
        .url()
        .refine((value) => /^https?:\/\//.test(value))
        .refine((value) => {
          assertPublicModelUrl(value);
          return true;
        }),
      model: z.string().trim().min(1).max(100),
      protocol: protocolSchema.default('chat-completions'),
      apiKey: z.string().max(1000).optional(),
      enabled: z.boolean().default(true),
    })
    .parse(req.body);
  const id = randomUUID();
  const profile: RuntimeSettings = {
    ...v,
    id,
    createdAt: new Date().toISOString(),
    hasKey: !!v.apiKey,
    mode: 'live',
    apiKey: v.apiKey || '',
  };
  models.set(id, profile);
  if (v.apiKey) modelSecrets.set(id, v.apiKey);
  saveModels();
  res.status(201).json(publicSettings().models.find((m) => m.id === id));
});
app.patch('/api/models/:modelId', (req, res) => {
  const existing = models.get(req.params.modelId);
  if (!existing) return res.status(404).json({ error: '模型不存在。' });
  const v = z
    .object({
      name: z.string().trim().min(1).max(100).optional(),
      baseUrl: z.string().url().optional(),
      model: z.string().trim().min(1).max(100).optional(),
      protocol: protocolSchema.optional(),
      apiKey: z.string().max(1000).optional(),
      clearKey: z.boolean().optional(),
      enabled: z.boolean().optional(),
    })
    .parse(req.body);
  if (v.name !== undefined) existing.name = v.name;
  if (v.baseUrl !== undefined) existing.baseUrl = v.baseUrl.replace(/\/$/, '');
  if (v.model !== undefined) existing.model = v.model;
  if (v.protocol !== undefined) existing.protocol = v.protocol;
  if (v.enabled !== undefined) existing.enabled = v.enabled;
  if (v.clearKey) {
    existing.apiKey = '';
    modelSecrets.delete(existing.id!);
  } else if (v.apiKey) {
    existing.apiKey = v.apiKey;
    modelSecrets.set(existing.id!, v.apiKey);
  }
  existing.hasKey = !!existing.apiKey;
  if (settings.activeModelId === existing.id) Object.assign(settings, existing);
  saveModels();
  res.json(publicSettings().models.find((m) => m.id === existing.id));
});
app.delete('/api/models/:modelId', (req, res) => {
  if (!models.delete(req.params.modelId)) return res.status(404).json({ error: '模型不存在。' });
  modelSecrets.delete(req.params.modelId);
  if (settings.activeModelId === req.params.modelId) {
    const next = models.values().next().value;
    if (next) Object.assign(settings, next, { activeModelId: next.id });
    else settings.activeModelId = undefined;
  }
  saveModels();
  res.json(publicSettings().models);
});
app.post('/api/models/:modelId/select', (req, res) => {
  const model = models.get(req.params.modelId);
  if (!model) return res.status(404).json({ error: '模型不存在。' });
  Object.assign(settings, model, { activeModelId: model.id });
  saveModels();
  res.json(publicSettings());
});
app.get('/api/projects', (_req, res) => res.json(store.projects));
app.post('/api/projects', (req, res) => {
  const v = z
    .object({
      title: z.string().trim().min(1).max(80),
      genre: z.string().max(40).default('奇幻小说'),
      description: z.string().max(2000).default(''),
    })
    .parse(req.body);
  const p = createProject(v.title, v.genre, v.description);
  store.projects.push(p);
  store.save();
  res.status(201).json(p);
});
app.param('projectId', (req, res, next, id) => {
  const p = store.get(id);
  if (!p) return res.status(404).json({ error: '项目不存在。' });
  res.locals.project = p;
  next();
});
app.get('/api/projects/:projectId', (_req, res) => res.json(res.locals.project));
app.delete('/api/projects/:projectId', async (req, res) => {
  const p = res.locals.project as Project;
  if (store.projects.length <= 1) return res.status(400).json({ error: '至少保留一个作品。' });
  if (p.run?.status === 'running')
    return res.status(409).json({ error: '作品正在运行，请先停止工作流再删除。' });
  platformRuntime.assertProjectIdle(p.id);
  await platformRuntime.removeProject(p.id);
  const original = store.projects;
  store.projects = store.projects.filter((item) => item.id !== p.id);
  try {
    store.save();
  } catch (error) {
    store.projects = original;
    throw error;
  }
  for (const asset of p.assets) {
    if (asset.url) fs.rmSync(path.join(dir, 'uploads', path.basename(asset.url)), { force: true });
  }
  res.json(store.projects);
});
app.use('/api/projects/:projectId', (req, res, next) => {
  if (req.method !== 'GET' && !req.path.endsWith('/cancel')) {
    if (res.locals.project.run?.status === 'running' && !(req.method === 'POST' && req.path === '/run'))
      return res
        .status(409)
        .json({ error: '工作流正在运行，请先停止运行再修改资料。', code: 'RUN_CONFLICT', retryable: false });
    platformRuntime.assertProjectIdle(res.locals.project.id);
  }
  next();
});
app.patch('/api/projects/:projectId', (req, res) => {
  const v = z
    .object({
      ...graphScopeSchema,
      title: z.string().trim().min(1).max(80).optional(),
      description: z.string().max(2000).optional(),
      steps: z
        .array(editableStepSchema.partial().required({ id: true }))
        .max(200)
        .optional(),
      workflow: editableWorkflowSchema.optional(),
    })
    .strict()
    .parse(req.body);
  const p = res.locals.project as Project;
  updateGraph(p, v, (draft) => {
    if (v.title !== undefined) draft.title = v.title;
    if (v.description !== undefined) draft.description = v.description;
    for (const update of v.steps || []) {
      const step = draft.steps.find((s) => s.id === update.id);
      if (!step) throw inputError(404, 'NODE_NOT_FOUND', '节点不存在。');
      const boundary = step.id === SYSTEM_START_NODE_ID || step.id === SYSTEM_END_NODE_ID;
      if (boundary && Object.keys(update).some((key) => key !== 'id' && key !== 'position'))
        throw inputError(400, 'SYSTEM_NODE_IMMUTABLE', '系统起止节点仅允许修改位置。');
      const changesInput = Object.keys(update).some((key) => key !== 'id' && key !== 'position');
      if (changesInput) invalidateSteps(draft, new Set([step.id, ...downstreamIds(draft, step.id)]));
      Object.assign(step, update);
      if (step.modelId === '') delete step.modelId;
    }
    if (v.workflow) {
      Object.assign(draft.workflow!, v.workflow);
      if (v.workflow.auditNodeId === '') delete draft.workflow!.auditNodeId;
      if (v.workflow.outputWriterNodeId === '') delete draft.workflow!.outputWriterNodeId;
      invalidateSteps(draft);
    }
    if (v.title !== undefined || v.description !== undefined) invalidateSteps(draft);
  });
  res.json(p);
});
app.put('/api/projects/:projectId/graph', (req, res) => {
  const v = z
    .object({
      workflowId: z.string().min(1),
      expectedGraphRevision: z.number().int().min(0),
      steps: z.array(editableStepSchema).min(2).max(200),
      workflow: editableWorkflowSchema.required({ edges: true }),
    })
    .strict()
    .parse(req.body);
  const p = res.locals.project as Project;
  updateGraph(p, v, (draft) => {
    for (const id of [SYSTEM_START_NODE_ID, SYSTEM_END_NODE_ID]) {
      const submitted = v.steps.filter((step) => step.id === id);
      const existing = draft.steps.find((step) => step.id === id);
      if (submitted.length !== 1 || !existing || submitted[0].kind !== existing.kind)
        throw inputError(400, 'SYSTEM_NODE_IMMUTABLE', '恢复图必须保留系统开始和结束节点。');
    }
    draft.steps = v.steps.map((step) => {
      if (step.id === SYSTEM_START_NODE_ID || step.id === SYSTEM_END_NODE_ID)
        return { ...draft.steps.find((s) => s.id === step.id)!, position: step.position };
      return { ...step, modelId: step.modelId || undefined, status: 'idle', output: '' };
    });
    draft.workflow = {
      ...draft.workflow!,
      ...v.workflow,
      auditNodeId: v.workflow.auditNodeId || undefined,
      outputWriterNodeId: v.workflow.outputWriterNodeId || undefined,
      startNodeId: SYSTEM_START_NODE_ID,
      endNodeId: SYSTEM_END_NODE_ID,
      autoPublish: false,
    };
    invalidateSteps(draft);
  });
  res.json(p);
});
app.post('/api/projects/:projectId/nodes', (req, res) => {
  const v = z
    .object({
      ...graphScopeSchema,
      id: nodeIdSchema.optional(),
      title: z.string().trim().min(1).max(100),
      subtitle: z.string().max(300).default('自定义创作节点'),
      prompt: z.string().max(12000).default('根据输入上下文完成创作任务。'),
      kind: z
        .enum([
          'agent',
          'audit',
          'writer',
          'custom',
          'world',
          'outline',
          'plan',
          'expand',
          'character',
          'dialogue',
          'scene',
          'continuity',
        ])
        .default('custom'),
      outputName: z.string().trim().max(120).optional(),
      position: z.object({ x: z.number().finite(), y: z.number().finite() }).default({ x: 160, y: 160 }),
      modelId: z.string().optional(),
      assetIds: z.array(z.string()).max(100).optional(),
    })
    .strict()
    .parse(req.body);
  const p = res.locals.project as Project;
  updateGraph(p, v, (draft) => {
    const { workflowId: _workflowId, expectedGraphRevision: _revision, ...node } = v;
    const id = node.id || `node-${randomUUID().slice(0, 8)}`;
    if (draft.steps.some((s) => s.id === id)) throw inputError(409, 'NODE_EXISTS', '节点 ID 已存在。');
    if (draft.steps.length >= 200) throw inputError(400, 'NODE_LIMIT', '每条工作流最多 200 个节点。');
    draft.steps.push({ ...node, id, status: 'idle', output: '', enabled: true });
    normalizeWorkflow(draft);
    invalidateSteps(draft);
  });
  res.status(201).json(p);
});
app.delete('/api/projects/:projectId/nodes', (req, res) => {
  const v = z
    .object({
      ...graphScopeSchema,
      nodeIds: z.array(z.string().trim().min(1).max(100)).max(200).default([]),
      edgeIds: z.array(z.string().trim().min(1).max(100)).max(500).default([]),
    })
    .strict()
    .parse(req.body || {});
  const p = res.locals.project as Project;
  updateGraph(p, v, (draft) => {
    removeWorkflowItems(draft, v.nodeIds, v.edgeIds);
    invalidateSteps(draft);
  });
  res.json(p);
});
app.delete('/api/projects/:projectId/nodes/:nodeId', (req, res) => {
  const v = z
    .object(graphScopeSchema)
    .strict()
    .parse(req.body || {});
  const p = res.locals.project as Project;
  updateGraph(p, v, (draft) => {
    removeWorkflowItems(draft, [req.params.nodeId], []);
    invalidateSteps(draft);
  });
  res.json(p);
});
app.put('/api/projects/:projectId/edges', (req, res) => {
  const v = z
    .object({
      ...graphScopeSchema,
      edges: z
        .array(
          z.object({
            id: z.string().min(1).optional(),
            source: z.string().min(1),
            target: z.string().min(1),
            label: z.string().optional(),
          }),
        )
        .max(500),
    })
    .strict()
    .parse(req.body);
  const p = res.locals.project as Project;
  updateGraph(p, v, (draft) => {
    draft.workflow!.edges = v.edges.map((edge) => ({
      ...edge,
      id: edge.id || `e-${randomUUID().slice(0, 8)}`,
    }));
    invalidateSteps(draft);
  });
  res.json(p);
});
app.put('/api/projects/:projectId/workflow', (req, res) => {
  const v = editableWorkflowSchema.omit({ edges: true, name: true }).extend(graphScopeSchema).parse(req.body);
  const p = res.locals.project as Project;
  updateGraph(p, v, (draft) => {
    const { workflowId: _workflowId, expectedGraphRevision: _revision, ...config } = v;
    Object.assign(draft.workflow!, config);
    if (config.auditNodeId === '') delete draft.workflow!.auditNodeId;
    if (config.outputWriterNodeId === '') delete draft.workflow!.outputWriterNodeId;
    invalidateSteps(draft);
  });
  res.json(p);
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMAGE_ASSET_MAX_BYTES, files: 10 },
});
app.post('/api/projects/:projectId/assets/upload', upload.array('files', 10), (req, res) => {
  const category = z.enum(categories).parse(req.body.category);
  const files = req.files as Express.Multer.File[];
  if (!files?.length) return res.status(400).json({ error: '请选择上传文件。' });
  const allowed = new Map([
    ['.txt', 'text/plain'],
    ['.md', 'text/markdown'],
    ['.json', 'application/json'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.webp', 'image/webp'],
  ]);
  if (files.some((f) => !allowed.has(path.extname(f.originalname).toLowerCase())))
    return res.status(400).json({ error: '支持 TXT、Markdown、JSON、PNG、JPG、WebP 文件。' });
  const p = res.locals.project as import('../shared/types.js').Project;
  if (p.assets.length + files.length > 100)
    return res.status(400).json({ error: '每个项目最多保存 100 份资料。' });
  for (const f of files) {
    const ext = path.extname(f.originalname).toLowerCase();
    const mime = allowed.get(ext)!;
    const isImage = mime.startsWith('image/');
    if (!isImage && f.size > TEXT_ASSET_MAX_BYTES)
      return res
        .status(413)
        .json({ error: '文本资料单个文件不能超过 2 MiB。', code: 'TEXT_ASSET_TOO_LARGE' });
    if (isImage && f.size > IMAGE_ASSET_MAX_BYTES)
      return res
        .status(413)
        .json({ error: '图片资料单个文件不能超过 4 MiB。', code: 'IMAGE_ASSET_TOO_LARGE' });
    if (isImage) {
      const valid =
        ext === '.png'
          ? f.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : ext === '.webp'
            ? f.buffer.toString('ascii', 0, 4) === 'RIFF' && f.buffer.toString('ascii', 8, 12) === 'WEBP'
            : f.buffer[0] === 255 && f.buffer[1] === 216 && f.buffer[2] === 255;
      if (!valid) return res.status(400).json({ error: '图片内容与文件格式不匹配。' });
    }
  }
  for (const f of files) {
    const ext = path.extname(f.originalname).toLowerCase(),
      mime = allowed.get(ext)!,
      id = randomUUID();
    const isImage = mime.startsWith('image/');
    if (isImage) fs.writeFileSync(path.join(dir, 'uploads', id + ext), f.buffer);
    const decoded = Buffer.from(f.originalname, 'latin1').toString('utf8');
    p.assets.push({
      id,
      category,
      name: decoded.includes('\ufffd') ? f.originalname : decoded,
      content: isImage ? '' : f.buffer.toString('utf8').replace(/^\uFEFF/, ''),
      url: isImage ? `/uploads/${id}${ext}` : undefined,
      mime,
      size: f.size,
      createdAt: new Date().toISOString(),
    });
  }
  p.steps.forEach((s) => {
    s.status = 'idle';
  });
  persistProject(p);
  res.status(201).json(p);
});
app.post('/api/projects/:projectId/assets', (req, res) => {
  if (typeof req.body?.content === 'string' && utf8ByteLength(req.body.content.trim()) > TEXT_ASSET_MAX_BYTES)
    return res.status(413).json({ error: '文本资料不能超过 2 MiB。', code: 'TEXT_ASSET_TOO_LARGE' });
  const v = z
    .object({
      name: z.string().trim().min(1).max(120),
      category: z.enum(categories),
      content: z
        .string()
        .trim()
        .min(1)
        .refine((value) => utf8ByteLength(value) <= TEXT_ASSET_MAX_BYTES, '文本资料不能超过 2 MiB。'),
    })
    .parse(req.body);
  const p = res.locals.project;
  if (p.assets.length >= 100) return res.status(400).json({ error: '每个项目最多保存 100 份资料。' });
  p.assets.push({
    ...v,
    id: randomUUID(),
    size: Buffer.byteLength(v.content),
    mime: 'text/markdown',
    createdAt: new Date().toISOString(),
  });
  p.steps.forEach((s: { status: string }) => {
    s.status = 'idle';
  });
  persistProject(p);
  res.status(201).json(p);
});
app.patch('/api/projects/:projectId/assets/:assetId', (req, res) => {
  if (typeof req.body?.content === 'string' && utf8ByteLength(req.body.content) > TEXT_ASSET_MAX_BYTES)
    return res.status(413).json({ error: '文本资料不能超过 2 MiB。', code: 'TEXT_ASSET_TOO_LARGE' });
  const v = z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      category: z.enum(categories).optional(),
      content: z
        .string()
        .refine((value) => utf8ByteLength(value) <= TEXT_ASSET_MAX_BYTES, '文本资料不能超过 2 MiB。')
        .optional(),
    })
    .parse(req.body);
  const p = res.locals.project as import('../shared/types.js').Project;
  const asset = p.assets.find((a) => a.id === req.params.assetId);
  if (!asset) return res.status(404).json({ error: '资料不存在。' });
  if (asset.url && v.content !== undefined)
    return res.status(400).json({ error: '图片资料不能在线编辑，请替换文件。' });
  Object.assign(asset, v);
  if (v.content !== undefined) asset.size = Buffer.byteLength(v.content);
  p.steps.forEach((s) => (s.status = 'idle'));
  persistProject(p);
  res.json(p);
});
app.delete('/api/projects/:projectId/assets/:assetId', (req, res) => {
  const p = res.locals.project as import('../shared/types.js').Project;
  const a = p.assets.find((a) => a.id === req.params.assetId);
  if (!a) return res.status(404).json({ error: '资料不存在。' });
  if (a.url) fs.rmSync(path.join(dir, 'uploads', path.basename(a.url)), { force: true });
  p.assets = p.assets.filter((item) => item.id !== a.id);
  p.steps.forEach((s) => {
    s.status = 'idle';
  });
  persistProject(p);
  res.json(p);
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
  if (suppliedKey !== undefined && !key) throw inputError(400, 'INVALID_REQUEST_KEY', '请求标识格式不正确。');
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
app.post('/api/projects/:projectId/cancel', (req, res) => {
  runner.controllers.get(String(req.params.projectId))?.abort();
  res.json({ ok: true });
});
const chapterScopeSchema = {
  expectedRevision: z.number().int().min(1),
  workflowId: z.string().min(1).optional(),
};
app.patch('/api/projects/:projectId/chapters/:chapterId', (req, res) => {
  const v = z
    .object({
      ...chapterScopeSchema,
      title: z.string().trim().min(1).max(120),
      content: z.string().max(200000),
    })
    .strict()
    .parse(req.body);
  const p = res.locals.project as Project;
  checkWorkflow(p, v);
  mutateProject(p, (draft) => {
    const chapter = draft.chapters.find((c) => c.id === req.params.chapterId);
    if (!chapter) throw inputError(404, 'CHAPTER_NOT_FOUND', '章节不存在。');
    if (chapter.revision !== v.expectedRevision)
      throw inputError(409, 'REVISION_CONFLICT', '章节已被修改，请保留当前输入并刷新后重试。');
    let content = v.content;
    const firstLine = content.split('\n')[0];
    if (v.title !== chapter.title && firstLine.replace(/^#+\s*/, '').trim() === chapter.title)
      content = v.title + content.slice(firstLine.length);
    chapter.revisions ||= [];
    chapter.revisions.push({
      revision: chapter.revision,
      title: chapter.title,
      content: chapter.content,
      updatedAt: chapter.updatedAt,
      mode: chapter.mode,
    });
    Object.assign(chapter, {
      title: v.title,
      content,
      revision: chapter.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    for (const graph of draft.workflows || []) {
      for (const step of graph.steps)
        if (step.generationContext?.number === chapter.number) {
          step.status = 'idle';
          delete step.generationContext;
        }
    }
    for (const step of draft.steps)
      if (step.generationContext?.number === chapter.number) {
        step.status = 'idle';
        delete step.generationContext;
      }
  });
  res.json(p);
});
app.delete('/api/projects/:projectId/chapters/:chapterId', (req, res) => {
  const v = z
    .object(chapterScopeSchema)
    .strict()
    .parse(req.body || {});
  const p = res.locals.project as Project;
  checkWorkflow(p, v);
  mutateProject(p, (draft) => {
    const chapter = draft.chapters.find((c) => c.id === req.params.chapterId);
    if (!chapter) throw inputError(404, 'CHAPTER_NOT_FOUND', '章节不存在。');
    if (chapter.revision !== v.expectedRevision)
      throw inputError(409, 'REVISION_CONFLICT', '章节已被修改，请刷新后重试。');
    draft.chapterNumberHighWatermark = Math.max(draft.chapterNumberHighWatermark || 0, chapter.number);
    draft.chapters = draft.chapters.filter((c) => c.id !== chapter.id);
    invalidateSteps(draft);
  });
  res.json(p);
});
app.post('/api/projects/:projectId/workflows', (req, res) => {
  const v = z
    .object({
      name: z.string().trim().min(1).max(80).default('新工作流'),
      template: z.boolean().optional(),
      preset: z.enum(['chapter', 'world', 'blank']).default('chapter'),
    })
    .strict()
    .parse(req.body || {});
  const p = res.locals.project as Project;
  syncActiveWorkflow(p);
  const graph =
    v.preset === 'world'
      ? createWorldWorkflowGraph(v.name)
      : createWorkflowGraph(v.name, v.preset === 'blank' ? false : v.template !== false);
  p.workflows ||= [];
  p.workflows.push(graph);
  p.activeWorkflowId = graph.id;
  p.steps = graph.steps;
  p.workflow = graph.workflow;
  persistProject(p);
  res.status(201).json(p);
});
app.post('/api/projects/:projectId/workflows/:workflowId/select', (req, res) => {
  const p = res.locals.project as Project;
  syncActiveWorkflow(p);
  const graph = p.workflows?.find((g) => g.id === req.params.workflowId);
  if (!graph) return res.status(404).json({ error: '工作流不存在。' });
  p.activeWorkflowId = graph.id;
  p.steps = graph.steps;
  p.workflow = graph.workflow;
  persistProject(p);
  res.json(p);
});
app.patch('/api/projects/:projectId/workflows/:workflowId', (req, res) => {
  const v = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
  const p = res.locals.project as Project;
  syncActiveWorkflow(p);
  const graph = p.workflows?.find((g) => g.id === req.params.workflowId);
  if (!graph) return res.status(404).json({ error: '工作流不存在。' });
  graph.name = v.name;
  graph.workflow.name = v.name;
  if (p.activeWorkflowId === graph.id && p.workflow) p.workflow.name = v.name;
  persistProject(p);
  res.json(p);
});
app.post('/api/projects/:projectId/steps/:stepId/adopt-world-asset', (req, res) => {
  const p = res.locals.project as Project;
  const step = p.steps.find((item) => item.id === req.params.stepId);
  if (!step || step.status !== 'done' || !step.output.trim())
    return res
      .status(409)
      .json({ error: '请先完成该世界观节点，再采用其结果。', code: 'STEP_OUTPUT_UNAVAILABLE' });
  if (step.kind === 'writer' || step.kind === 'audit' || step.id === 'draft' || step.id === 'review')
    return res.status(400).json({ error: '只能把世界观节点结果采用为设定。', code: 'NOT_WORLD_STEP' });
  if (p.assets.length >= 100) return res.status(400).json({ error: '每个项目最多保存 100 份资料。' });
  const content = step.output.trim();
  if (utf8ByteLength(content) > TEXT_ASSET_MAX_BYTES)
    return res
      .status(413)
      .json({ error: '节点结果超过 2 MiB，不能保存为设定。', code: 'TEXT_ASSET_TOO_LARGE' });
  p.assets.push({
    id: randomUUID(),
    category: 'world',
    name: `${(step.outputName || deriveOutputName(step.output, step.title)).replace(/[\\/:*?"<>|]/g, ' ').trim() || step.title}.md`.slice(
      0,
      120,
    ),
    content,
    mime: 'text/markdown',
    size: Buffer.byteLength(content),
    createdAt: new Date().toISOString(),
  });
  persistProject(p);
  res.status(201).json(p);
});
app.delete('/api/projects/:projectId/workflows/:workflowId', (req, res) => {
  const p = res.locals.project as Project;
  syncActiveWorkflow(p);
  if ((p.workflows?.length || 0) <= 1) return res.status(400).json({ error: '至少保留一条工作流。' });
  const remaining = (p.workflows || []).filter((g) => g.id !== req.params.workflowId);
  if (remaining.length === (p.workflows || []).length)
    return res.status(404).json({ error: '工作流不存在。' });
  p.workflows = remaining;
  if (p.activeWorkflowId === req.params.workflowId) {
    const next = remaining[0];
    p.activeWorkflowId = next.id;
    p.steps = next.steps;
    p.workflow = next.workflow;
  }
  persistProject(p);
  res.json(p);
});
const staticDir = path.join(appRoot, 'dist');
app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在。', code: 'NOT_FOUND' }));
if (fs.existsSync(path.join(staticDir, 'index.html'))) {
  app.use(express.static(staticDir));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
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
const server = app.listen(port, '127.0.0.1', () => console.log(`Novel Agent API: http://127.0.0.1:${port}`));
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  for (const controller of runner.controllers.values()) controller.abort();
  server.close();
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref();
  try {
    await platformRuntime.close();
    while (runner.controllers.size) await new Promise((resolve) => setTimeout(resolve, 25));
    releaseDataLock();
    clearTimeout(deadline);
    process.exit(0);
  } catch {
    console.error('关闭未完整完成，下次启动请检查任务和数据目录锁。');
    process.exit(1);
  }
}
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
server.on('error', () => {
  console.error('本机服务无法启动，请检查端口是否被占用。');
  void shutdown();
});
