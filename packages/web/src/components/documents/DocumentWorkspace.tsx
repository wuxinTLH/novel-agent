import { useEffect, useRef, useState } from 'react';
import { api } from '../../services/api.js';
import {
  DOCUMENT_MAX_BYTES,
  PDF_PRINT_NOTICE,
  type DocumentPreview,
} from '../../../../../shared/documents.js';

const printStyles = `body{font-family:"Noto Serif CJK SC","Source Han Serif SC","Microsoft YaHei","PingFang SC",serif;line-height:1.8;margin:2cm;color:#111}h1,h2{break-after:avoid}p{white-space:pre-wrap;overflow-wrap:anywhere}section{break-before:page}@page{size:A4;margin:18mm}`;
function printDocument(html: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; base-uri 'none'"><title>稿件打印</title><style>${printStyles}</style></head><body>${html}</body></html>`;
}
/** Parent mounts with a key={project.id}, or projectId changes automatically reset reader state. */
export function DocumentWorkspace({ projectId }: { projectId: string }) {
  const [preview, setPreview] = useState<DocumentPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [printHtml, setPrintHtml] = useState('');
  const [printReady, setPrintReady] = useState(false);
  const printFrame = useRef<HTMLIFrameElement>(null);
  const generation = useRef(0);
  const base = `/projects/${encodeURIComponent(projectId)}/documents`;
  useEffect(() => {
    generation.current++;
    setPreview(undefined);
    setError('');
    setPrintHtml('');
    setPrintReady(false);
    setBusy(false);
    return () => {
      generation.current++;
    };
  }, [projectId]);
  async function upload(file?: File) {
    if (!file || busy) return;
    const epoch = generation.current;
    setError('');
    if (/\.doc$/i.test(file.name)) {
      setError('旧版 .doc 不支持；请先在 Word / LibreOffice 中另存为 DOCX。');
      return;
    }
    if (file.size > DOCUMENT_MAX_BYTES) {
      setError('文件不能超过 8 MiB。');
      return;
    }
    setBusy(true);
    const data = new FormData();
    data.append('file', file);
    try {
      const result = await api<DocumentPreview>(base, { method: 'POST', body: data, timeoutMs: 25000 });
      if (epoch !== generation.current) return;
      const previous = preview;
      setPreview(result);
      if (previous) void api(`${base}/${previous.id}`, { method: 'DELETE' }).catch(() => {});
    } catch (e) {
      if (epoch === generation.current) setError(e instanceof Error ? e.message : '无法读取文档。');
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  }
  async function preparePrint() {
    const epoch = generation.current;
    setError('');
    setBusy(true);
    setPrintReady(false);
    try {
      const result = await api<{ title: string; html: string }>(`${base}/print`);
      if (epoch === generation.current) setPrintHtml(printDocument(result.html));
    } catch (e) {
      if (epoch === generation.current) setError(e instanceof Error ? e.message : '无法准备打印。');
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  }
  return (
    <section aria-label="文档阅读与稿件导出" className="document-workspace">
      <h3>文档阅读与稿件导出</h3>
      <p>文档只在本机临时阅读，30 分钟过期；不会自动写入章节或资料，不上传到第三方。每份 ≤ 8 MiB。</p>
      <label>
        打开 DOCX{' '}
        <input
          aria-label="打开 DOCX"
          type="file"
          accept=".docx"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            void upload(file);
          }}
        />
      </label>
      <div>
        <a href={`/api${base}/export/docx`} download>
          导出 DOCX
        </a>
        {' · '}
        <a href={`/api${base}/export/epub`} download>
          导出 EPUB
        </a>
        {' · '}
        <button type="button" onClick={() => void preparePrint()} disabled={busy}>
          准备 PDF 打印
        </button>
      </div>
      <p>{PDF_PRINT_NOTICE}</p>
      {busy && <p role="status">正在处理文档…</p>}
      {error && <p role="alert">{error}</p>}
      {preview && (
        <section aria-label="文档预览">
          <h4>{preview.name}</h4>
          {preview.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
          <p>临时文档到期：{new Date(preview.expiresAt).toLocaleString()}</p>
          {preview.kind === 'pdf' && preview.resourceUrl && (
            <>
              <iframe
                title={`PDF：${preview.name}`}
                src={preview.resourceUrl}
                sandbox="allow-same-origin"
                referrerPolicy="no-referrer"
                style={{ width: '100%', height: '65vh', border: '1px solid #aaa' }}
              />
              <a href={preview.resourceUrl} target="_blank" rel="noopener noreferrer">
                用浏览器打开 PDF（内嵌阅读器不可用时）
              </a>
            </>
          )}
          {preview.kind === 'docx' && (
            <iframe
              title={`Word：${preview.name}`}
              srcDoc={printDocument(preview.html || '')}
              sandbox=""
              referrerPolicy="no-referrer"
              style={{ width: '100%', height: '65vh', border: '1px solid #aaa' }}
            />
          )}
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const epoch = generation.current;
              try {
                await api(`${base}/${preview.id}`, { method: 'DELETE' });
                if (epoch === generation.current) setPreview(undefined);
              } catch (e) {
                if (epoch === generation.current) setError(e instanceof Error ? e.message : '删除失败。');
              } finally {
                if (epoch === generation.current) setBusy(false);
              }
            }}
          >
            关闭并删除临时文档
          </button>
        </section>
      )}
      {printHtml && (
        <section aria-label="稿件打印预览">
          <p>仅打印下方稿件，不含应用界面。请确认字体与分页后点击打印，并选择“另存为 PDF”。</p>
          <button
            type="button"
            disabled={!printReady}
            onClick={() => printFrame.current?.contentWindow?.print()}
          >
            打印稿件 / 另存为 PDF
          </button>
          <iframe
            ref={printFrame}
            title="稿件专用打印预览"
            srcDoc={printHtml}
            sandbox="allow-same-origin allow-modals"
            onLoad={() => setPrintReady(true)}
            style={{ width: '100%', height: '55vh', border: '1px solid #aaa' }}
          />
        </section>
      )}
    </section>
  );
}
