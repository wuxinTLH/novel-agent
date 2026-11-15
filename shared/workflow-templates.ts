import type { Step } from './types.js';

/** Optional templates never migrate or expand an existing graph. */
export const WORKFLOW_PRESETS = ['chapter', 'super-novel', 'world', 'character', 'blank'] as const;
export type WorkflowPreset = (typeof WORKFLOW_PRESETS)[number];
export const SUPER_NOVEL_STAGES = [
  { id: 'world-import', kind: 'world-import' },
  { id: 'context-retrieval', kind: 'context-retrieval' },
  { id: 'outline', kind: 'outline' },
  { id: 'conflict', kind: 'conflict' },
  { id: 'foreshadow', kind: 'foreshadow' },
  { id: 'plan', kind: 'plan' },
  { id: 'draft', kind: 'writer' },
  { id: 'review', kind: 'audit' },
] as const satisfies readonly { id: string; kind: NonNullable<Step['kind']> }[];

/** Local stages never resolve model credentials or call a provider. */
export function isLocalWorkflowStep(step: Pick<Step, 'kind'>): boolean {
  return step.kind === 'world-import' || step.kind === 'context-retrieval';
}
