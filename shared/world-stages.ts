import { z } from 'zod';

export const MAX_WORLD_STAGES = 50;
export const worldStageNameSchema = z.string().trim().min(1).max(80);
export const worldStageIdSchema = z.string().min(1).max(128);
export const worldStageSchema = z.object({ id: worldStageIdSchema, name: worldStageNameSchema }).strict();
export const worldStagesSchema = z.array(worldStageSchema).max(MAX_WORLD_STAGES).superRefine((stages, ctx) => {
  if (new Set(stages.map((stage) => stage.id)).size !== stages.length ||
      new Set(stages.map((stage) => stage.name)).size !== stages.length)
    ctx.addIssue({ code: 'custom', message: '世界观阶段 ID 和名称不能重复。' });
});

/** Used by both stored-document validation and route admission; no inferred/default group. */
export function validWorldStageAssignment(
  project: { worldStages?: { id: string; name: string }[] },
  category: string,
  worldStageId: string | undefined,
): boolean {
  return worldStageId === undefined ||
    (category === 'world' && !!project.worldStages?.some((stage) => stage.id === worldStageId));
}
