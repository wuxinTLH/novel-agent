/** Documents are temporary reading copies, never canonical chapters or project assets. */
export const DOCUMENT_MAX_BYTES = 8 * 1024 * 1024;
export const DOCUMENT_MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
export const DOCUMENT_MAX_ENTRIES = 512;
export const DOCUMENT_TTL_MS = 30 * 60 * 1000;
export type ManuscriptFormat = 'docx' | 'epub';
export interface DocumentPreview {
  id: string;
  name: string;
  kind: 'docx' | 'pdf';
  size: number;
  expiresAt: string;
  /** Sanitized semantic HTML; no images, links, styles, or active content. */
  html?: string;
  resourceUrl?: string;
  warnings: string[];
}
export const PDF_PRINT_NOTICE =
  'PDF 使用浏览器打印 / 另存为 PDF；请安装中文字体并在打印预览中核对字形。不会使用缺少中文字形的服务端默认字体。';
