export const MAX_TEXT_FILE_BYTES = 2_000_000;
export function decodeChapterFile(bytes: ArrayBuffer, encoding: 'utf-8' | 'gb18030'): string {
  if (bytes.byteLength > MAX_TEXT_FILE_BYTES) throw new Error('文件不能超过 2 MB。');
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new Error('文件编码无法读取，请选择正确的 UTF-8 或 GB18030 编码后重新上传。'); }
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (text.includes('\0')) throw new Error('该文件不是纯文本正文，请上传 TXT 文件。');
  if (!text.trim()) throw new Error('文件正文不能为空。');
  if (text.length > 200_000) throw new Error('单章正文最多 200000 个字符，请拆分后添加。');
  return text;
}
