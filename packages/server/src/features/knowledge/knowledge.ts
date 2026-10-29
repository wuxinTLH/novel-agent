import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { knowledgeFactTypes, type KnowledgeFact, type KnowledgeFactInput } from '../../../../../shared/knowledge.js';
import type { Project } from '../../../../../shared/types.js';
import type { FeatureService } from '../../core/context.js';
import { assetRevisions, restoreAssetRevision } from './asset-history.js';
import { createProjectOperations } from '../projects/project-operations.js';

const inputSchema = z.object({
  type: z.enum(knowledgeFactTypes),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(20_000),
  chapterIds: z.array(z.string().uuid()).max(200).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(50).optional(),
}).strict();
const expected = z.coerce.number().int().min(1);
const patchSchema = inputSchema.partial().extend({ expectedRevision: expected }).strict();
const deleteSchema = z.object({ expectedRevision: expected }).strict();

type KnowledgeProject = Project & { knowledgeFacts?: KnowledgeFact[] };
function factsOf(project: Project): KnowledgeFact[] {
  const target = project as KnowledgeProject;
  if (!target.knowledgeFacts) target.knowledgeFacts = [];
  return target.knowledgeFacts;
}
function conflict(res: any, message = '知识事实已被其他操作修改，请刷新后重试。') {
  return res.status(409).json({ code: 'KNOWLEDGE_CONFLICT', error: message });
}

export const knowledgeService: FeatureService = {
  id: 'knowledge',
  register(app, context) {
    const { store } = context;
    const { persistProject } = createProjectOperations(store);
    app.get('/api/projects/:projectId/assets/:assetId/versions', (req, res) => res.json(assetRevisions(res.locals.project as Project, req.params.assetId)));
    app.post('/api/projects/:projectId/assets/:assetId/versions/restore', (req, res) => {
      const v = z.object({ expectedRevision: z.number().int().min(1), revision: z.number().int().min(1) }).parse(req.body);
      const project = res.locals.project as Project;
      const draft = structuredClone(project);
      const asset = restoreAssetRevision(draft, req.params.assetId, v.expectedRevision, v.revision);
      persistProject(draft);
      Object.assign(project, draft);
      return res.json(asset);
    });
    app.get('/api/projects/:projectId/knowledge', (req, res) => {
      const facts = factsOf(res.locals.project as Project);
      const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
      const type = typeof req.query.type === 'string' ? req.query.type : undefined;
      const chapterId = typeof req.query.chapterId === 'string' ? req.query.chapterId : undefined;
      const result = facts.filter((fact) => (!q || [fact.title, fact.content, ...fact.tags].join(' ').toLowerCase().includes(q)) && (!type || fact.type === type) && (!chapterId || fact.chapterIds.includes(chapterId)));
      return res.json(result);
    });
    app.post('/api/projects/:projectId/knowledge', (req, res) => {
      const v = inputSchema.parse(req.body) as KnowledgeFactInput;
      const p = res.locals.project as Project;
      if (factsOf(p).length >= 500) return res.status(400).json({ code: 'KNOWLEDGE_LIMIT', error: '结构化事实最多保存 500 条。' });
      const chapterIds = [...new Set(v.chapterIds || [])];
      if (chapterIds.some((id) => !p.chapters.some((chapter) => chapter.id === id))) return res.status(400).json({ code: 'CHAPTER_NOT_FOUND', error: '关联章节不存在。' });
      const now = new Date().toISOString();
      const fact: KnowledgeFact = { id: randomUUID(), ...v, chapterIds, tags: [...new Set(v.tags || [])], revision: 1, createdAt: now, updatedAt: now };
      const draft = structuredClone(p); factsOf(draft).push(fact);
      persistProject(draft); Object.assign(p, draft);
      return res.status(201).json(fact);
    });
    app.patch('/api/projects/:projectId/knowledge/:factId', (req, res) => {
      const p = res.locals.project as Project;
      const facts = factsOf(p);
      const fact = facts.find((item) => item.id === req.params.factId);
      if (!fact) return res.status(404).json({ code: 'KNOWLEDGE_NOT_FOUND', error: '知识事实不存在。' });
      const v = patchSchema.parse(req.body);
      if (v.expectedRevision !== fact.revision) return conflict(res);
      const draft = structuredClone(p);
      const target = factsOf(draft).find((item) => item.id === fact.id)!;
      const { expectedRevision: _expected, ...changes } = v;
      const chapterIds = [...new Set(changes.chapterIds ?? target.chapterIds)];
      if (chapterIds.some((id) => !draft.chapters.some((chapter) => chapter.id === id))) return res.status(400).json({ code: 'CHAPTER_NOT_FOUND', error: '关联章节不存在。' });
      Object.assign(target, changes, { chapterIds, tags: [...new Set(changes.tags ?? target.tags)], revision: target.revision + 1, updatedAt: new Date().toISOString() });
      persistProject(draft);
      Object.assign(p, draft);
      return res.json(target);
    });
    app.delete('/api/projects/:projectId/knowledge/:factId', (req, res) => {
      const p = res.locals.project as Project;
      const facts = factsOf(p);
      const index = facts.findIndex((item) => item.id === req.params.factId);
      if (index < 0) return res.status(404).json({ code: 'KNOWLEDGE_NOT_FOUND', error: '知识事实不存在。' });
      const v = deleteSchema.parse({ expectedRevision: req.query.expectedRevision });
      if (v.expectedRevision !== facts[index].revision) return conflict(res);
      const draft = structuredClone(p);
      const [deleted] = factsOf(draft).splice(index, 1);
      persistProject(draft);
      Object.assign(p, draft);
      return res.json(deleted);
    });
  },
};
