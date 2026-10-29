import { quarantinedUpload } from '../file-sandbox/upload.js';
import { inspectUpload } from '../file-sandbox/sandbox.js';
import { archiveAssetRevision } from '../../../../../shared/asset-history.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { IMAGE_ASSET_MAX_BYTES, TEXT_ASSET_MAX_BYTES, utf8ByteLength } from '../../../../../shared/limits.js';
import { categories, type Project } from '../../../../../shared/types.js';
import { deriveOutputName } from '../generation/engine.js';
import type { FeatureService } from '../../core/context.js';
import { createProjectOperations } from '../projects/project-operations.js';

export const assetsService: FeatureService = {
  id: 'assets',
  register(app, context) {
    const { dir, store } = context;
    const { persistProject, mutateProject } = createProjectOperations(store);
    app.post('/api/projects/:projectId/assets/upload', quarantinedUpload('files', 10, IMAGE_ASSET_MAX_BYTES, 1), async (req, res) => {
      try {
      const category = z.enum(categories).parse(req.body.category);
      const files = req.files as Express.Multer.File[];
      if (!files?.length) return res.status(400).json({ error: '请选择上传文件。' });
      const allowed = new Map([
        ['.txt', 'text/plain'],
        ['.md', 'text/markdown'],
        ['.json', 'application/json'],
        ['.png', 'image/png'],
        ['.jpg', 'image/jpeg'],
        ['.jpeg', 'image/jpeg'],
        ['.webp', 'image/webp'],
      ]);
      if (files.some((f) => !allowed.has(path.extname(f.originalname).toLowerCase())))
        return res.status(400).json({ error: '支持 TXT、Markdown、JSON、PNG、JPG、WebP 文件。' });
      const p = res.locals.project as Project;
      if (p.assets.length + files.length > 100)
        return res.status(400).json({ error: '每个项目最多保存 100 份资料。' });
      // Scan the entire batch before publishing any file or mutating project state.
      const checked = [];
      for (const file of files) checked.push(await inspectUpload(file, 'asset', undefined, res.locals.uploadLease.signal));
      const createdPaths: string[] = [];
      const originalAssets = p.assets.slice();
      try {
      for (const f of checked) {
        const ext = f.extension, mime = f.mime, id = randomUUID();
        const isImage = mime.startsWith('image/');
        if (isImage) {
          const target = path.join(dir, 'uploads', id + ext);
          fs.writeFileSync(target, f.buffer, { flag: 'wx', mode: 0o600 });
          createdPaths.push(target);
        }
        const decoded = Buffer.from(f.name, 'latin1').toString('utf8');
        p.assets.push({
          id,
          category,
          name: decoded.includes('\ufffd') ? f.name : decoded,
          content: isImage ? '' : f.text!,
          url: isImage ? `/uploads/${id}${ext}` : undefined,
          mime,
          size: f.buffer.length,
          createdAt: new Date().toISOString(),
        });
      }
      p.steps.forEach((s) => {
        s.status = 'idle';
      });
      persistProject(p);
      res.status(201).json(p);
      } catch (error) {
        p.assets = originalAssets;
        for (const target of createdPaths) fs.rmSync(target, { force: true });
        throw error;
      }
      } finally { res.locals.uploadLease.release(); }
    });
    app.post('/api/projects/:projectId/cover', quarantinedUpload('cover', 1, IMAGE_ASSET_MAX_BYTES), async (req, res) => {
      try {
      const file = (req.files as Express.Multer.File[] | undefined)?.[0];
      if (!file) return res.status(400).json({ error: '请选择封面图片。' });
      const safe = await inspectUpload(file, 'cover', undefined, res.locals.uploadLease.signal);
      const ext = safe.extension;
      const p = res.locals.project as Project;
      const id = randomUUID();
      const url = `/uploads/${id}${ext}`;
      fs.writeFileSync(path.join(dir, 'uploads', `${id}${ext}`), safe.buffer, { flag: 'wx', mode: 0o600 });
      const previous = p.coverUrl;
      p.coverUrl = url;
      try {
        persistProject(p);
      } catch (error) {
        p.coverUrl = previous;
        fs.rmSync(path.join(dir, 'uploads', `${id}${ext}`), { force: true });
        throw error;
      }
      if (previous) fs.rmSync(path.join(dir, 'uploads', path.basename(previous)), { force: true });
      res.status(201).json(p);
      } finally { res.locals.uploadLease.release(); }
    });
    app.post('/api/projects/:projectId/assets', (req, res) => {
      if (
        typeof req.body?.content === 'string' &&
        utf8ByteLength(req.body.content.trim()) > TEXT_ASSET_MAX_BYTES
      )
        return res.status(413).json({ error: '文本资料不能超过 2 MiB。', code: 'TEXT_ASSET_TOO_LARGE' });
      const v = z
        .object({
          name: z.string().trim().min(1).max(120),
          category: z.enum(categories),
          content: z
            .string()
            .trim()
            .min(1)
            .refine((value) => utf8ByteLength(value) <= TEXT_ASSET_MAX_BYTES, '文本资料不能超过 2 MiB。'),
        })
        .parse(req.body);
      const p = res.locals.project;
      if (p.assets.length >= 100) return res.status(400).json({ error: '每个项目最多保存 100 份资料。' });
      p.assets.push({
        ...v,
        id: randomUUID(),
        size: Buffer.byteLength(v.content),
        mime: 'text/markdown',
        createdAt: new Date().toISOString(),
      });
      p.steps.forEach((s: { status: string }) => {
        s.status = 'idle';
      });
      persistProject(p);
      res.status(201).json(p);
    });
    app.patch('/api/projects/:projectId/assets/:assetId', (req, res) => {
      if (typeof req.body?.content === 'string' && utf8ByteLength(req.body.content) > TEXT_ASSET_MAX_BYTES)
        return res.status(413).json({ error: '文本资料不能超过 2 MiB。', code: 'TEXT_ASSET_TOO_LARGE' });
      const v = z
        .object({
          expectedRevision: z.number().int().positive(),
          name: z.string().trim().min(1).max(120).optional(),
          category: z.enum(categories).optional(),
          content: z
            .string()
            .refine((value) => utf8ByteLength(value) <= TEXT_ASSET_MAX_BYTES, '文本资料不能超过 2 MiB。')
            .optional(),
        })
        .parse(req.body);
      const p = res.locals.project as Project;
      const asset = p.assets.find((a) => a.id === req.params.assetId);
      if (!asset) return res.status(404).json({ error: '资料不存在。' });
      if (asset.url && v.content !== undefined)
        return res.status(400).json({ error: '图片资料不能在线编辑，请替换文件。' });
      if ((asset.revision || 1) !== v.expectedRevision)
        return res.status(409).json({ code: 'REVISION_CONFLICT', error: '资料已被修改，请刷新后重试。' });
      const { expectedRevision: _expected, ...changes } = v;
      mutateProject(p, (draft) => {
        const target = draft.assets.find((item) => item.id === asset.id)!;
        archiveAssetRevision(target);
        Object.assign(target, changes);
        if (v.content !== undefined) target.size = Buffer.byteLength(v.content);
        draft.steps.forEach((s) => (s.status = 'idle'));
      });
      res.json(p);
    });
    app.post('/api/projects/:projectId/assets/delete', (req, res) => {
      const { ids } = z
        .object({ ids: z.array(z.string().uuid()).min(1).max(100) })
        .strict()
        .parse(req.body);
      if (new Set(ids).size !== ids.length)
        return res.status(400).json({ error: '不能重复选择同一份资料。' });
      const p = res.locals.project as Project;
      const selected = p.assets.filter((asset) => ids.includes(asset.id));
      if (selected.length !== ids.length)
        return res.status(409).json({ error: '所选资料已变化，请刷新列表后重试。' });
      const selectedIds = new Set(ids);
      mutateProject(p, (draft) => {
        draft.assets = draft.assets.filter((asset) => !selectedIds.has(asset.id));
        draft.steps.forEach((step) => (step.status = 'idle'));
      });
      for (const asset of selected) {
        if (asset.url) fs.rmSync(path.join(dir, 'uploads', path.basename(asset.url)), { force: true });
      }
      res.json(p);
    });
    app.delete('/api/projects/:projectId/assets/:assetId', (req, res) => {
      const p = res.locals.project as Project;
      const a = p.assets.find((a) => a.id === req.params.assetId);
      if (!a) return res.status(404).json({ error: '资料不存在。' });
      if (a.url) fs.rmSync(path.join(dir, 'uploads', path.basename(a.url)), { force: true });
      p.assets = p.assets.filter((item) => item.id !== a.id);
      p.steps.forEach((s) => {
        s.status = 'idle';
      });
      persistProject(p);
      res.json(p);
    });
    app.post('/api/projects/:projectId/steps/:stepId/adopt-world-asset', (req, res) => {
      const p = res.locals.project as Project;
      const step = p.steps.find((item) => item.id === req.params.stepId);
      if (!step || step.status !== 'done' || !step.output.trim())
        return res
          .status(409)
          .json({ error: '请先完成该世界观节点，再采用其结果。', code: 'STEP_OUTPUT_UNAVAILABLE' });
      if (step.kind === 'writer' || step.kind === 'audit' || step.id === 'draft' || step.id === 'review')
        return res.status(400).json({ error: '只能把世界观节点结果采用为设定。', code: 'NOT_WORLD_STEP' });
      if (p.assets.length >= 100) return res.status(400).json({ error: '每个项目最多保存 100 份资料。' });
      const content = step.output.trim();
      if (utf8ByteLength(content) > TEXT_ASSET_MAX_BYTES)
        return res
          .status(413)
          .json({ error: '节点结果超过 2 MiB，不能保存为设定。', code: 'TEXT_ASSET_TOO_LARGE' });
      p.assets.push({
        id: randomUUID(),
        category: 'world',
        name: `${(step.outputName || deriveOutputName(step.output, step.title)).replace(/[\\/:*?"<>|]/g, ' ').trim() || step.title}.md`.slice(
          0,
          120,
        ),
        content,
        mime: 'text/markdown',
        size: Buffer.byteLength(content),
        createdAt: new Date().toISOString(),
      });
      persistProject(p);
      res.status(201).json(p);
    });
  },
};
