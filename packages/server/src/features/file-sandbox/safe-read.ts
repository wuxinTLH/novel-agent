import fs from 'node:fs/promises';
import path from 'node:path';
import type { RequestHandler } from 'express';
import { inspectUpload, reserveUpload, sandboxError } from './sandbox.js';

const imageName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|jpeg|webp)$/i;
const maxBytes = 16 * 1024 * 1024;
/** Read-only content disarm for legacy uploads. No original bytes or cached stale verdicts are served. */
export async function readSafeImage(directory: string, name: string, signal?: AbortSignal): Promise<Buffer> {
  if (!imageName.test(name)) throw sandboxError('文件不存在。', 'UPLOAD_NOT_FOUND', 404);
  const release = reserveUpload();
  try {
    if (signal?.aborted) throw sandboxError('上传读取已取消。', 'UPLOAD_ABORTED', 499);
    const root = await fs.realpath(directory);
    const file = path.join(root, name);
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes || !before.size)
      throw sandboxError('文件不能安全读取。', 'UPLOAD_UNSAFE', 422);
    const resolved = await fs.realpath(file);
    if (path.dirname(resolved) !== root) throw sandboxError('文件不能安全读取。');
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > maxBytes)
        throw sandboxError('文件在读取期间发生变化。');
      // Allocate and read at most one bounded input, even if the file grows concurrently.
      const input = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < input.length) {
        const { bytesRead } = await handle.read(input, length, input.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > maxBytes) throw sandboxError('图片超过安全读取限制。', 'UPLOAD_SIZE_LIMIT', 413);
      return (await inspectUpload({ originalname: name, buffer: input.subarray(0, length) }, 'stored-image', undefined, signal)).buffer;
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw sandboxError('文件不存在。', 'UPLOAD_NOT_FOUND', 404);
    throw error;
  } finally { release(); }
}
export function safeUploadReader(directory: string): RequestHandler {
  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(404).json({ code: 'UPLOAD_NOT_FOUND', error: '文件不存在。' });
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once('close', abort);
    try {
      let name: string;
      try { name = decodeURIComponent(req.path.slice(1)); }
      catch { throw sandboxError('文件不存在。', 'UPLOAD_NOT_FOUND', 404); }
      const clean = await readSafeImage(directory, name, controller.signal);
      if (controller.signal.aborted) return;
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(clean);
    } catch (error) { if (!controller.signal.aborted) next(error); }
    finally { res.removeListener('close', abort); }
  };
}
