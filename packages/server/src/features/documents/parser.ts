import yauzl from 'yauzl';
import sanitizeHtml from 'sanitize-html';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DOCUMENT_MAX_BYTES,
  DOCUMENT_MAX_ENTRIES,
  DOCUMENT_MAX_EXPANDED_BYTES,
} from '../../../../../shared/documents.js';

export function documentError(message: string, code = 'INVALID_DOCUMENT', status = 400) {
  return Object.assign(new Error(message), { status, code });
}
/** Consume every ZIP member, not just metadata: catches forged sizes and deflate bombs. Never extracts paths. */
export function validateDocxZip(buffer: Buffer): Promise<void> {
  if (buffer.length > DOCUMENT_MAX_BYTES)
    return Promise.reject(documentError('文件不能超过 8 MiB。', 'DOCUMENT_TOO_LARGE', 413));
  return new Promise((resolve, reject) => {
    let zip: yauzl.ZipFile | undefined;
    let activeStream: import('node:stream').Readable | undefined;
    let finished = false;
    const timer = setTimeout(() => finish(documentError('ZIP 验证超时。', 'DOCUMENT_TIMEOUT', 422)), 5000);
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      activeStream?.destroy();
      zip?.close();
      if (error) reject(error);
      else resolve();
    };
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, archive) => {
      if (error || !archive) return finish(documentError('不是有效的 DOCX ZIP 文件。'));
      if (finished) {
        archive.close();
        return;
      }
      zip = archive;
      let count = 0,
        total = 0;
      const names = new Set<string>();
      archive.on('error', () => finish(documentError('ZIP 文件损坏或解压长度不符。')));
      archive.on('end', () =>
        finish(
          names.has('[Content_Types].xml') && names.has('word/document.xml')
            ? undefined
            : documentError('缺少 DOCX 必需的文档结构。'),
        ),
      );
      archive.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName;
        if (
          ++count > DOCUMENT_MAX_ENTRIES ||
          names.has(name) ||
          name.includes('\\') ||
          name.startsWith('/') ||
          name.split('/').includes('..') ||
          /^(?:[a-z]:)/i.test(name) ||
          entry.generalPurposeBitFlag & 1 ||
          ![0, 8].includes(entry.compressionMethod) ||
          /(?:^|\/)(?:vbaProject\.bin|embeddings|activeX|customUI)(?:\/|$)/i.test(name) ||
          /\.(?:exe|dll|com|js|vbs|ps1|bat|cmd|ole)$/i.test(name) ||
          ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
        )
          return finish(documentError('ZIP 包含不安全路径、重复、加密或过多条目。'));
        names.add(name);
        if (
          entry.uncompressedSize > DOCUMENT_MAX_EXPANDED_BYTES ||
          (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > 200)
        )
          return finish(documentError('ZIP 解压比例或大小超过限制。', 'DOCUMENT_EXPANSION_LIMIT', 413));
        archive.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return finish(documentError('无法读取 ZIP 条目。'));
          activeStream = stream;
          const xmlChunks: Buffer[] = [];
          stream.on('error', () => finish(documentError('ZIP 解压失败。')));
          stream.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (/\.(?:xml|rels)$/i.test(name)) xmlChunks.push(chunk);
            if (total > DOCUMENT_MAX_EXPANDED_BYTES) {
              stream.destroy();
              finish(documentError('解压内容不能超过 32 MiB。', 'DOCUMENT_EXPANSION_LIMIT', 413));
            }
          });
          stream.on('end', () => {
            if (xmlChunks.length) {
              const xml = Buffer.concat(xmlChunks).toString('utf8');
              if (/<!DOCTYPE|<!ENTITY|TargetMode\s*=\s*["']External["']|vbaProject|macroEnabled|<\s*(?:\w+:)?(?:altChunk|object|oleObject)\b/i.test(xml))
                return finish(documentError('DOCX 包含外部资源、宏、实体或嵌入活动内容。', 'UPLOAD_ACTIVE_CONTENT'));
            }
            if (!finished) archive.readEntry();
          });
        });
      });
      archive.readEntry();
    });
  });
}
export function sanitizeDocumentHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'p',
      'br',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'strong',
      'em',
      'b',
      'i',
      'u',
      's',
      'sup',
      'sub',
      'ul',
      'ol',
      'li',
      'blockquote',
      'table',
      'thead',
      'tbody',
      'tr',
      'td',
      'th',
    ],
    allowedAttributes: {},
    allowedSchemes: [],
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'style', 'textarea', 'option', 'iframe', 'object', 'svg', 'math'],
  });
}
/** Mammoth runs out of process, with a V8 heap ceiling, deadline, and bounded output. */
export async function readDocx(buffer: Buffer, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  await validateDocxZip(buffer);
  signal?.throwIfAborted();
  const moduleUrl = import.meta.resolve('mammoth');
  const script = `import mammoth from ${JSON.stringify(moduleUrl)}; const chunks=[]; for await (const c of process.stdin) chunks.push(c); const result=await mammoth.convertToHtml({buffer:Buffer.concat(chunks)}, {externalFileAccess:false, includeDefaultStyleMap:true, convertImage:mammoth.images.imgElement(async()=>({src:''}))}); process.stdout.write(result.value);`;
  const html = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=128', '--input-type=module', '-e', script], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      cwd: path.dirname(fileURLToPath(moduleUrl)),
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP, NODE_OPTIONS: '' },
    });
    const chunks: Buffer[] = [];
    let size = 0, settled = false, failure: Error | undefined;
    const stop = (error: Error) => {
      if (settled || failure) return;
      failure = error;
      child.kill();
    };
    const abort = () => stop(documentError('上传已取消。', 'UPLOAD_CANCELLED', 422));
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure || error) reject(failure || error);
      else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(
      () => stop(documentError('Word 解析超时，请简化文档。', 'DOCUMENT_TIMEOUT', 422)),
      10000,
    );
    child.on('error', () =>
      stop(documentError('无法启动 Word 解析器。', 'DOCUMENT_PARSER_UNAVAILABLE', 422)),
    );
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) stop(documentError('Word 预览内容过大。', 'DOCUMENT_OUTPUT_LIMIT', 413));
      else chunks.push(chunk);
    });
    child.on('close', (code) =>
      finish(
        code === 0
          ? undefined
          : documentError('Word 文档无法解析，可能加密、损坏或超出内存限制。', 'DOCUMENT_PARSE_FAILED', 422),
      ),
    );
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (!failure) child.stdin.end(buffer);
  });
  return sanitizeDocumentHtml(html);
}
