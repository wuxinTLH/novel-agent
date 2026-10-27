import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { NODE_PRESETS } from '../../shared/node-presets.js';
import { SYSTEM_END_NODE_ID, SYSTEM_START_NODE_ID, type Project } from '../../shared/types.js';
import {
  createCharacterWorkflowGraph,
  createWorkflowGraph,
  createWorldWorkflowGraph,
  normalizeWorkflow,
  syncActiveWorkflow,
} from '../defaults.js';
import { downstreamIds } from '../workflow-graph.js';
import type { FeatureService } from './context.js';
import { createProjectOperations, inputError, invalidateSteps } from './project-operations.js';
import {
  createGraphOperations,
  editableStepSchema,
  editableWorkflowSchema,
  graphScopeSchema,
  nodeIdSchema,
  removeWorkflowItems,
} from './workflow-support.js';
export const workflowService: FeatureService = {
  id: 'workflow',
  register(app, context) {
    const { store } = context;
    const { persistProject } = createProjectOperations(store);
    const { updateGraph } = createGraphOperations(store);
    app.patch('/api/projects/:projectId', (req, res) => {
      const v = z
        .object({
          ...graphScopeSchema,
          title: z.string().trim().min(1).max(80).optional(),
          genre: z.string().trim().max(40).optional(),
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
        if (v.genre !== undefined) draft.genre = v.genre;
        if (v.description !== undefined) draft.description = v.description;
        for (const update of v.steps || []) {
          const step = draft.steps.find((s) => s.id === update.id);
          if (!step) throw inputError(404, 'NODE_NOT_FOUND', '节点不存在。');
          const boundary = step.id === SYSTEM_START_NODE_ID || step.id === SYSTEM_END_NODE_ID;
          if (boundary && Object.keys(update).some((key) => key !== 'id' && key !== 'position'))
            throw inputError(400, 'SYSTEM_NODE_IMMUTABLE', '系统起止节点仅允许修改位置。');
          const changesInput = Object.keys(update).some(
            (key) => key !== 'id' && key !== 'position' && key !== 'reusePreviousOutput',
          );
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
        if (v.title !== undefined || v.genre !== undefined || v.description !== undefined)
          invalidateSteps(draft);
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
          prompt: z.string().max(12000).optional(),
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
          characterName: z.string().max(120).optional(),
          characterGender: z.string().max(40).optional(),
          characterPersonality: z.string().max(1000).optional(),
          characterExperience: z.string().max(4000).optional(),
          characterCount: z.number().int().min(1).max(100).optional(),
          characterTemplate: z.string().max(20000).optional(),
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
        draft.steps.push({
          ...node,
          prompt: node.prompt ?? (NODE_PRESETS[node.kind] || NODE_PRESETS.custom).prompt,
          id,
          status: 'idle',
          output: '',
          enabled: true,
        });
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
      const v = editableWorkflowSchema
        .omit({ edges: true, name: true })
        .extend(graphScopeSchema)
        .parse(req.body);
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
    app.post('/api/projects/:projectId/workflows', (req, res) => {
      const v = z
        .object({
          name: z.string().trim().min(1).max(80).default('新工作流'),
          template: z.boolean().optional(),
          preset: z.enum(['chapter', 'world', 'character', 'blank']).default('chapter'),
        })
        .strict()
        .parse(req.body || {});
      const p = res.locals.project as Project;
      syncActiveWorkflow(p);
      const graph =
        v.preset === 'world'
          ? createWorldWorkflowGraph(v.name)
          : v.preset === 'character'
            ? createCharacterWorkflowGraph(v.name)
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
  },
};
