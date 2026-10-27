import type { Project } from '../../../../../shared/types.js';
import type { Store } from './store.js';
import { syncActiveWorkflow } from './defaults.js';
export function createProjectOperations(store: Store) {
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
  return { persistProject, mutateProject };
}
export function inputError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code });
}
export function checkWorkflow(p: Project, v: { workflowId?: string; expectedGraphRevision?: number }) {
  if (v.workflowId !== undefined && v.workflowId !== p.activeWorkflowId)
    throw inputError(409, 'WORKFLOW_CONFLICT', '活动工作流已改变，请刷新后重试。');
  if (v.expectedGraphRevision !== undefined && v.expectedGraphRevision !== (p.workflow?.graphRevision || 0))
    throw Object.assign(inputError(409, 'GRAPH_CONFLICT', '工作流已被修改，请刷新后重试。'), {
      graphRevision: p.workflow?.graphRevision || 0,
    });
}
export function invalidateSteps(p: Project, ids?: Set<string>) {
  for (const step of p.steps)
    if (!ids || ids.has(step.id)) {
      step.status = 'idle';
      step.output = '';
      delete step.generationContext;
    }
}
