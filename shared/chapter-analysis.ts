import { z } from 'zod';
import { chapterNumberSchema } from './generation.js';

export const CHAPTER_ANALYSIS_LIMITS = { maxRecords: 100, maxChapters: 100, maxInputCharacters: 150_000, maxReportCharacters: 100_000 } as const;
export const chapterAnalysisSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('range'), from: chapterNumberSchema, to: chapterNumberSchema }).strict()
    .refine(v => v.to >= v.from && v.to - v.from + 1 <= CHAPTER_ANALYSIS_LIMITS.maxChapters, '章节范围必须递增且不超过100章。'),
  z.object({ kind: z.literal('recent'), count: z.number().int().min(1).max(CHAPTER_ANALYSIS_LIMITS.maxChapters) }).strict(),
]);
export const chapterAnalysisRequestSchema = z.object({
  requestId: z.string().uuid(), selection: chapterAnalysisSelectionSchema, modelId: z.string().trim().min(1).max(200),
}).strict();
export type ChapterAnalysisSelection = z.infer<typeof chapterAnalysisSelectionSchema>;
export type ChapterAnalysisRequest = z.infer<typeof chapterAnalysisRequestSchema>;
export const chapterAnalysisSchema = z.object({
  id: z.string().uuid(), requestId: z.string().uuid(), selection: chapterAnalysisSelectionSchema,
  status: z.enum(['running', 'done', 'error', 'interrupted']),
  modelId: z.string().min(1).max(200), modelName: z.string().max(500), createdAt: z.string(), completedAt: z.string().optional(),
  sourceChapters: z.array(z.object({ id: z.string(), number: chapterNumberSchema, title: z.string(), revision: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(CHAPTER_ANALYSIS_LIMITS.maxChapters),
  report: z.string().max(CHAPTER_ANALYSIS_LIMITS.maxReportCharacters).optional(), errorCode: z.string().max(100).optional(),
}).strict();
export type ChapterAnalysis = z.infer<typeof chapterAnalysisSchema>;
