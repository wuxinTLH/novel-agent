import { z } from 'zod';
import { manualChapterRequestSchema } from '../../../../../shared/manual-chapters.js';
import { type Project } from '../../../../../shared/types.js';
import { addManualChapter } from './manual-chapters.js';
import { archiveChapterRevision, normalizeChapterHistory } from '../../../../../shared/chapter-history.js';
import { restoreChapterRevision } from './chapter-history.js';
import type { FeatureService } from '../../core/context.js';
import { checkWorkflow, createProjectOperations, inputError, invalidateSteps } from '../projects/project-operations.js';
export const chaptersService: FeatureService = {
  id: 'chapters',
  register(app, context) {
    const { store } = context;
    const { mutateProject } = createProjectOperations(store);
    const chapterScopeSchema = {
      expectedRevision: z.number().int().min(1),
      workflowId: z.string().min(1).optional(),
    };
    app.post('/api/projects/:projectId/chapters', (req, res) => {
      const v = manualChapterRequestSchema.parse(req.body);
      const p = res.locals.project as Project;
      checkWorkflow(p, v);
      let created = false;
      mutateProject(p, (draft) => {
        created = addManualChapter(draft, v).created;
        if (created) invalidateSteps(draft);
      });
      res.status(created ? 201 : 200).json(p);
    });
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
        archiveChapterRevision(chapter);
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
    app.get('/api/projects/:projectId/chapters/:chapterId/history', (req, res) => {
      const p = res.locals.project as Project;
      const chapter = p.chapters.find((item) => item.id === req.params.chapterId);
      if (!chapter) throw inputError(404, 'CHAPTER_NOT_FOUND', '章节不存在。');
      res.json({ chapterId: chapter.id, revision: chapter.revision, revisions: normalizeChapterHistory(chapter.revisions) });
    });
    app.post('/api/projects/:projectId/chapters/:chapterId/restore', (req, res) => {
      const v = z.object({ ...chapterScopeSchema, revision: z.number().int().min(1) }).strict().parse(req.body);
      const p = res.locals.project as Project;
      checkWorkflow(p, v);
      mutateProject(p, (draft) => {
        restoreChapterRevision(draft, req.params.chapterId, v.expectedRevision, v.revision);
        invalidateSteps(draft);
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
  },
};
