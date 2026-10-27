import { z } from 'zod';
import { MAX_BATCH_SIZE } from '../../../../../shared/generation.js';
import { SYSTEM_END_NODE_ID, SYSTEM_START_NODE_ID, type Project } from '../../../../../shared/types.js';
import { createWorkflow, normalizeWorkflow } from '../projects/defaults.js';
import { Store } from '../projects/store.js';
import { validateGraph } from './workflow-graph.js';
import { checkWorkflow, createProjectOperations } from '../projects/project-operations.js';
export const nodeIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, '节点 ID 仅支持字母、数字、下划线和短横线。');
export function createGraphOperations(store: Store) {
  const { mutateProject } = createProjectOperations(store);
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
  return { updateGraph };
}
export const graphScopeSchema = {
  workflowId: z.string().min(1).optional(),
  expectedGraphRevision: z.number().int().min(0).optional(),
};
export const editableStepSchema = z
  .object({
    id: nodeIdSchema,
    title: z.string().trim().min(1).max(100),
    subtitle: z.string().max(300),
    prompt: z.string().max(12000),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }),
    kind: z
      .enum([
        'agent',
        'start',
        'end',
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
      .optional(),
    outputName: z.string().trim().max(120).optional(),
    modelId: z.string().optional(),
    assetIds: z.array(z.string()).max(100).optional(),
    enabled: z.boolean().optional(),
    reusePreviousOutput: z.boolean().optional(),
    characterName: z.string().max(120).optional(),
    characterGender: z.string().max(40).optional(),
    characterPersonality: z.string().max(1000).optional(),
    characterExperience: z.string().max(4000).optional(),
    characterCount: z.number().int().min(1).max(100).optional(),
    characterTemplate: z.string().max(20000).optional(),
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
export const editableWorkflowSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    edges: edgesSchema.optional(),
    auditNodeId: z.string().optional(),
    outputWriterNodeId: z.string().optional(),
    outputName: z.string().trim().max(120).optional(),
    chapterCount: z.number().int().min(1).max(MAX_BATCH_SIZE).optional(),
    autoGenerate: z.boolean().optional(),
    automationMode: z.enum(['manual', 'automatic']).optional(),
    publication: z
      .object({
        enabled: z.boolean(),
        linkId: z.string().trim().min(1).max(200),
        volumeId: z.string().trim().min(1).max(200).optional(),
        action: z.enum(['save_draft', 'submit_review']),
        useAi: z.union([z.literal(1), z.literal(2)]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export function removeWorkflowItems(p: Project, nodeIds: string[], edgeIds: string[]) {
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
