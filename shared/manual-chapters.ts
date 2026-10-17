import { z } from 'zod';
import { chapterNumberSchema } from './generation.js';

export const MANUAL_CHAPTER_MAX_CONTENT_LENGTH = 200_000;

/** TXT files are read by the client; this endpoint accepts prose as JSON only. */
export const manualChapterRequestSchema = z
  .object({
    number: chapterNumberSchema,
    title: z.string().trim().min(1).max(120),
    content: z
      .string()
      .max(MANUAL_CHAPTER_MAX_CONTENT_LENGTH)
      .refine((value) => value.trim().length > 0, '章节正文不能为空。'),
    workflowId: z.string().min(1).max(200).optional(),
    requestId: z.uuid(),
  })
  .strict();

export type ManualChapterRequest = z.infer<typeof manualChapterRequestSchema>;
