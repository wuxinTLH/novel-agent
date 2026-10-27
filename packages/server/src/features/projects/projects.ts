import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { type Project } from '../../../../../shared/types.js';
import { createProject } from './defaults.js';
import type { FeatureService } from '../../core/context.js';

export const projectsService: FeatureService = {
  id: 'projects',
  register(app, context) {
    const { dir, store, platformRuntime } = context;
    app.get('/api/projects', (_req, res) => res.json(store.projects));
    app.post('/api/projects', (req, res) => {
      const v = z
        .object({
          title: z.string().trim().min(1).max(80),
          genre: z.string().max(40).default('奇幻小说'),
          description: z.string().max(2000).default(''),
        })
        .parse(req.body);
      const p = createProject(v.title, v.genre, v.description);
      store.projects.push(p);
      store.save();
      res.status(201).json(p);
    });
    app.param('projectId', (req, res, next, id) => {
      const p = store.get(id);
      if (!p) return res.status(404).json({ error: '项目不存在。' });
      res.locals.project = p;
      next();
    });
    app.get('/api/projects/:projectId', (_req, res) => res.json(res.locals.project));
    app.delete('/api/projects/:projectId', async (req, res) => {
      const p = res.locals.project as Project;
      if (store.projects.length <= 1) return res.status(400).json({ error: '至少保留一个作品。' });
      if (p.run?.status === 'running')
        return res.status(409).json({ error: '作品正在运行，请先停止工作流再删除。' });
      platformRuntime.assertProjectIdle(p.id);
      await platformRuntime.removeProject(p.id);
      const original = store.projects;
      store.projects = store.projects.filter((item) => item.id !== p.id);
      try {
        store.save();
      } catch (error) {
        store.projects = original;
        throw error;
      }
      for (const asset of p.assets) {
        if (asset.url) fs.rmSync(path.join(dir, 'uploads', path.basename(asset.url)), { force: true });
      }
      if (p.coverUrl) fs.rmSync(path.join(dir, 'uploads', path.basename(p.coverUrl)), { force: true });
      res.json(store.projects);
    });
    app.use('/api/projects/:projectId', (req, res, next) => {
      if (req.method !== 'GET' && !req.path.endsWith('/cancel')) {
        if (res.locals.project.run?.status === 'running' && !(req.method === 'POST' && req.path === '/run'))
          return res
            .status(409)
            .json({
              error: '工作流正在运行，请先停止运行再修改资料。',
              code: 'RUN_CONFLICT',
              retryable: false,
            });
        platformRuntime.assertProjectIdle(res.locals.project.id);
      }
      next();
    });
  },
};
