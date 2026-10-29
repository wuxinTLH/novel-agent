import { quarantinedUpload } from '../file-sandbox/upload.js';
import { inspectUpload } from '../file-sandbox/sandbox.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FeatureService } from '../../core/context.js';
import type { Project } from '../../../../../shared/types.js';
import {
  DOCUMENT_MAX_BYTES,
  DOCUMENT_TTL_MS,
  type DocumentPreview,
} from '../../../../../shared/documents.js';
import { documentError } from './parser.js';
import { exportManuscript, manuscriptHtml, safeDocumentFilename } from './exports.js';

/** Register after core project/auth middleware; documents never enter project.assets. */
export const documentsService: FeatureService = {
  id: 'documents',
  register(app) {
    const copies = new Map<
      string,
      { projectId: string; preview: DocumentPreview; data?: Buffer; expires: number }
    >();
    const sweep = () => {
      for (const [id, copy] of copies) if (copy.expires <= Date.now()) copies.delete(id);
    };
    const upload = quarantinedUpload('file', 1, DOCUMENT_MAX_BYTES);
    const base = '/api/projects/:projectId/documents';
    app.get(`${base}/export/:format`, async (req, res) => {
      const format = req.params.format;
      if (format !== 'docx' && format !== 'epub')
        throw documentError('支持 DOCX、EPUB；PDF 请使用打印 / 另存为 PDF。', 'UNSUPPORTED_DOCUMENT_FORMAT');
      const project = res.locals.project as Project;
      const data = await exportManuscript(project, format);
      res.setHeader(
        'Content-Type',
        format === 'docx'
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'application/epub+zip',
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="manuscript.${format}"; filename*=UTF-8''${encodeURIComponent(safeDocumentFilename(project.title, format)).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))}`,
      );
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(data);
    });
    app.get(`${base}/print`, (_req, res) => {
      const project = res.locals.project as Project;
      res.json({ title: project.title, html: manuscriptHtml(project) });
    });
    app.post(base, (req, res, next) => {
      // The shared lease bounds buffering and parsing until the worker has actually exited.
      upload(req, res, (error) => {
        if (error) return next(error);
        void (async () => {
          sweep();
          const file = (req.files as Express.Multer.File[] | undefined)?.[0];
          if (!file) throw documentError('请选择 DOCX 或 PDF 文件。');
          const extension = path.extname(file.originalname).toLowerCase();
          if (extension === '.doc')
            throw documentError(
              '旧版 .doc 不支持；请先在 Word / LibreOffice 中另存为 .docx 或 PDF。',
              'LEGACY_DOC_UNSUPPORTED',
              415,
            );
          if (!['.docx', '.pdf'].includes(extension))
            throw documentError('只支持 DOCX 和 PDF。', 'UNSUPPORTED_DOCUMENT_FORMAT', 415);
          const safe = await inspectUpload(file, 'document', undefined, res.locals.uploadLease.signal);
          const project = res.locals.project as Project;
          const own = [...copies.values()].filter((copy) => copy.projectId === project.id);
          const total = [...copies.values()].reduce(
            (sum, copy) => sum + (copy.data?.length || 0) + Buffer.byteLength(copy.preview.html || ''),
            0,
          );
          if (copies.size >= 64 || own.length >= 10 || total + file.size + 4 * 1024 * 1024 > 64 * 1024 * 1024)
            throw documentError(
              '临时阅读空间已满，请删除文档或等待 30 分钟过期。',
              'DOCUMENT_STORAGE_LIMIT',
              413,
            );
          const id = randomUUID(),
            expires = Date.now() + DOCUMENT_TTL_MS;
          const kind = extension === '.pdf' ? 'pdf' : 'docx';
          const preview: DocumentPreview = {
            id,
            kind,
            name: file.originalname.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180),
            size: file.size,
            expiresAt: new Date(expires).toISOString(),
            warnings: [],
          };
          if (kind === 'pdf') {
            if (
              file.buffer.toString('ascii', 0, 5) !== '%PDF-' ||
              !file.buffer.subarray(Math.max(0, file.size - 2048)).includes(Buffer.from('%%EOF'))
            )
              throw documentError('PDF 文件签名或结束标记无效。');
            preview.resourceUrl = `/api/projects/${encodeURIComponent(project.id)}/documents/${id}/resource`;
            preview.warnings.push(
              '使用浏览器内置 PDF 阅读器；不提取文本、不执行服务端 PDF 解析。加密或损坏文件可能无法预览。',
            );
          } else {
            preview.html = safe.html!;
            preview.warnings.push('仅保留语义正文；图片、外部链接、样式和嵌入对象已移除。');
          }
          // Parsing yields; recheck retained-memory and per-project quotas against concurrent uploads.
          sweep();
          const retained = [...copies.values()].reduce(
            (sum, copy) => sum + (copy.data?.length || 0) + Buffer.byteLength(copy.preview.html || ''),
            0,
          );
          const incoming = kind === 'pdf' ? file.buffer.length : Buffer.byteLength(preview.html || '');
          if (
            copies.size >= 64 ||
            [...copies.values()].filter((copy) => copy.projectId === project.id).length >= 10 ||
            retained + incoming > 64 * 1024 * 1024
          )
            throw documentError('临时阅读空间已满，请删除文档后重试。', 'DOCUMENT_STORAGE_LIMIT', 413);
          copies.set(id, {
            projectId: project.id,
            preview,
            expires,
            data: kind === 'pdf' ? file.buffer : undefined,
          });
          res.status(201).json(preview);
        })()
          .catch(next)
          .finally(() => {
            res.locals.uploadLease.release();
          });
      });
    });
    app.get(`${base}/:documentId/resource`, (req, res) => {
      sweep();
      const copy = copies.get(req.params.documentId);
      if (!copy || copy.projectId !== (res.locals.project as Project).id || !copy.data)
        throw documentError('文档不存在或已过期，请重新上传。', 'DOCUMENT_NOT_FOUND', 404);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="document.pdf"');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox",
      );
      res.send(copy.data);
    });
    app.delete(`${base}/:documentId`, (req, res) => {
      const copy = copies.get(req.params.documentId);
      if (!copy || copy.projectId !== (res.locals.project as Project).id)
        throw documentError('文档不存在。', 'DOCUMENT_NOT_FOUND', 404);
      copies.delete(req.params.documentId);
      res.json({ ok: true });
    });
  },
};
