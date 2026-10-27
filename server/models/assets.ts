import multer from 'multer';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { IMAGE_ASSET_MAX_BYTES, TEXT_ASSET_MAX_BYTES, utf8ByteLength } from '../../shared/limits.js';
import { categories, type Project } from '../../shared/types.js';
import { deriveOutputName } from '../engine.js';
import type { FeatureService } from './context.js';
import { createProjectOperations } from './project-operations.js';

export const assetsService: FeatureService = {
  id: 'assets',
  register(app, context) {
    const { dir, store } = context;
    const { persistProject, mutateProject } = createProjectOperations(store);
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: IMAGE_ASSET_MAX_BYTES, files: 10 },
    });
    app.post('/api/projects/:projectId/assets/upload', upload.array('files', 10), (req, res) => {
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
      for (const f of files) {
        const ext = path.extname(f.originalname).toLowerCase();
        const mime = allowed.get(ext)!;
        const isImage = mime.startsWith('image/');
        if (!isImage && f.size > TEXT_ASSET_MAX_BYTES)
          return res
            .status(413)
            .json({ error: '文本资料单个文件不能超过 2 MiB。', code: 'TEXT_ASSET_TOO_LARGE' });
        if (isImage && f.size > IMAGE_ASSET_MAX_BYTES)
          return res
            .status(413)
            .json({ error: '图片资料单个文件不能超过 4 MiB。', code: 'IMAGE_ASSET_TOO_LARGE' });
        if (isImage) {
          const valid =
            ext === '.png'
              ? f.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
              : ext === '.webp'
                ? f.buffer.toString('ascii', 0, 4) === 'RIFF' && f.buffer.toString('ascii', 8, 12) === 'WEBP'
                : f.buffer[0] === 255 && f.buffer[1] === 216 && f.buffer[2] === 255;
          if (!valid) return res.status(400).json({ error: '图片内容与文件格式不匹配。' });
        }
      }
      for (const f of files) {
        const ext = path.extname(f.originalname).toLowerCase(),
          mime = allowed.get(ext)!,
          id = randomUUID();
        const isImage = mime.startsWith('image/');
        if (isImage) fs.writeFileSync(path.join(dir, 'uploads', id + ext), f.buffer);
        const decoded = Buffer.from(f.originalname, 'latin1').toString('utf8');
        p.assets.push({
          id,
          category,
          name: decoded.includes('\ufffd') ? f.originalname : decoded,
          content: isImage ? '' : f.buffer.toString('utf8').replace(/^\uFEFF/, ''),
          url: isImage ? `/uploads/${id}${ext}` : undefined,
          mime,
          size: f.size,
          createdAt: new Date().toISOString(),
        });
      }
      p.steps.forEach((s) => {
        s.status = 'idle';
      });
      persistProject(p);
      res.status(201).json(p);
    });
    app.post('/api/projects/:projectId/cover', upload.single('cover'), (req, res) => {
      const file = req.file;
      if (!file) return res.status(400).json({ error: '请选择封面图片。' });
      const ext = path.extname(file.originalname).toLowerCase();
      const valid =
        ext === '.png'
          ? file.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : ext === '.webp'
            ? file.buffer.toString('ascii', 0, 4) === 'RIFF' &&
              file.buffer.toString('ascii', 8, 12) === 'WEBP'
            : ['.jpg', '.jpeg'].includes(ext) &&
              file.buffer[0] === 255 &&
              file.buffer[1] === 216 &&
              file.buffer[2] === 255;
      if (!valid) return res.status(400).json({ error: '封面仅支持有效的 PNG、JPG 或 WebP 图片。' });
      const p = res.locals.project as Project;
      const id = randomUUID();
      const url = `/uploads/${id}${ext}`;
      fs.writeFileSync(path.join(dir, 'uploads', `${id}${ext}`), file.buffer);
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
      Object.assign(asset, v);
      if (v.content !== undefined) asset.size = Buffer.byteLength(v.content);
      p.steps.forEach((s) => (s.status = 'idle'));
      persistProject(p);
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
