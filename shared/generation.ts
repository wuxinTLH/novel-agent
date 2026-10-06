import { z } from 'zod';
export type { Requirements, RunRequest, GenerationTarget, GenerationMode } from './types.js';

export const GENERATION_LIMITS = {
  maxBatchSize: 100,
  maxChapterNumber: 1_000_000,
  maxInstructionsLength: 12_000,
  maxLiteralItems: 40,
  maxLiteralLength: 1_000,
  maxChapterRequirements: 10_000,
} as const;
export const MAX_BATCH_SIZE = GENERATION_LIMITS.maxBatchSize;
export const MAX_CHAPTER_NUMBER = GENERATION_LIMITS.maxChapterNumber;
export const REQUIREMENTS_LIMITS = GENERATION_LIMITS;

export const chapterNumberSchema = z.number().int().min(1).max(MAX_CHAPTER_NUMBER);
const literalSchema = z
  .string()
  .min(1)
  .max(GENERATION_LIMITS.maxLiteralLength)
  .refine((value) => value.trim().length > 0, '原文要求不能是空白字符串；请删除该项以清除要求。');
export const requirementsSchema = z
  .object({
    instructions: z.string().max(GENERATION_LIMITS.maxInstructionsLength),
    requiredText: z.array(literalSchema).max(GENERATION_LIMITS.maxLiteralItems),
    forbiddenText: z.array(literalSchema).max(GENERATION_LIMITS.maxLiteralItems),
  })
  .strict();

export const chapterRequirementsSchema = z
  .record(
    z
      .string()
      .regex(/^[1-9]\d*$/)
      .refine((value) => Number(value) <= MAX_CHAPTER_NUMBER, '章节号超出范围。'),
    requirementsSchema,
  )
  .refine(
    (value) => Object.keys(value).length <= GENERATION_LIMITS.maxChapterRequirements,
    '按章要求数量超出限制。',
  );

export const generationTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('next'), count: z.number().int().min(1).max(MAX_BATCH_SIZE).optional() })
    .strict(),
  z.object({ kind: z.literal('single'), number: chapterNumberSchema }).strict(),
  z
    .object({ kind: z.literal('range'), from: chapterNumberSchema, to: chapterNumberSchema })
    .strict()
    .refine((value) => value.to >= value.from, '结束章号不能小于开始章号。')
    .refine((value) => value.to - value.from + 1 <= MAX_BATCH_SIZE, `每批最多生成 ${MAX_BATCH_SIZE} 章。`),
]);
export const runRequestSchema = z
  .object({
    workflowId: z.string().min(1).max(200).optional(),
    stepId: z.string().min(1).max(200).optional(),
    target: generationTargetSchema.optional(),
    mode: z.enum(['create', 'regenerate']).optional(),
    outputWriterNodeId: z.string().min(1).max(200).optional(),
    outputName: z.string().trim().max(120).optional(),
  })
  .strict()
  .refine(
    (request) =>
      request.mode !== 'regenerate' || (request.target !== undefined && request.target.kind !== 'next'),
    '重生成必须明确指定已有章节，不能使用续写目标。',
  )
  .refine(
    (request) =>
      !request.stepId ||
      !request.target ||
      request.target.kind === 'single' ||
      (request.target.kind === 'next' && (request.target.count ?? 1) === 1) ||
      (request.target.kind === 'range' && request.target.from === request.target.to),
    '单节点运行只能指定一章。',
  );
export const acceptCandidateSchema = z
  .object({
    expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    acknowledgeReviewFailure: z.boolean().optional(),
  })
  .strict();

export function emptyRequirements() {
  return { instructions: '', requiredText: [] as string[], forbiddenText: [] as string[] };
}
