import yazl from 'yazl';
import type { Project } from '../../../../../shared/types.js';
import type { ManuscriptFormat } from '../../../../../shared/documents.js';

export function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
    );
}
export function safeDocumentFilename(title: string, extension: string): string {
  const base = title
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 100)
    .trim();
  return `${!base || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base) ? 'manuscript' : base}.${extension}`;
}
export function canonicalManuscript(project: Pick<Project, 'title' | 'chapters'>) {
  const chapters = [...project.chapters]
    .sort((a, b) => a.number - b.number)
    .map((chapter) => ({
      title: chapter.title,
      paragraphs: chapter.content.replace(/\r\n?/g, '\n').split('\n'),
    }));
  if (chapters.length > 2000 || Buffer.byteLength(JSON.stringify(chapters)) > 16 * 1024 * 1024)
    throw Object.assign(new Error('稿件过大，请分项目导出。'), { status: 413, code: 'MANUSCRIPT_TOO_LARGE' });
  return { title: project.title, chapters };
}
export function manuscriptHtml(project: Pick<Project, 'title' | 'chapters'>): string {
  const manuscript = canonicalManuscript(project);
  return `<h1>${escapeXml(manuscript.title)}</h1>${manuscript.chapters.map((c) => `<section><h2>${escapeXml(c.title)}</h2>${c.paragraphs.map((p) => `<p>${escapeXml(p) || '<br />'}</p>`).join('')}</section>`).join('')}`;
}
export async function zipFiles(
  files: Array<{ name: string; content: string; compress?: boolean }>,
): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
  for (const file of files)
    zip.addBuffer(Buffer.from(file.content), file.name, { compress: file.compress ?? true });
  zip.end();
  return done;
}
export async function exportManuscript(
  project: Pick<Project, 'id' | 'title' | 'chapters'>,
  format: ManuscriptFormat,
): Promise<Buffer> {
  const manuscript = canonicalManuscript(project);
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  if (format === 'docx') {
    const paragraph = (text: string, style?: string) =>
      `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
    return zipFiles([
      {
        name: '[Content_Types].xml',
        content: `${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
      },
      {
        name: '_rels/.rels',
        content: `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      },
      {
        name: 'word/_rels/document.xml.rels',
        content: `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      },
      {
        name: 'word/styles.xml',
        content: `${xml}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="Microsoft YaHei"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style></w:styles>`,
      },
      {
        name: 'word/document.xml',
        content: `${xml}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraph(manuscript.title, 'Title')}${manuscript.chapters.map((c) => paragraph(c.title, 'Heading1') + c.paragraphs.map((p) => paragraph(p)).join('')).join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
      },
    ]);
  }
  const title = escapeXml(manuscript.title);
  return zipFiles([
    { name: 'mimetype', content: 'application/epub+zip', compress: false },
    {
      name: 'META-INF/container.xml',
      content: `${xml}<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    },
    {
      name: 'EPUB/package.opf',
      content: `${xml}<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:novel:${escapeXml(project.id)}</dc:identifier><dc:title>${title}</dc:title><dc:language>zh-CN</dc:language><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}</meta></metadata><manifest><item id="book" href="manuscript.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="book"/></spine></package>`,
    },
    {
      name: 'EPUB/nav.xhtml',
      content: `${xml}<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN"><head><title>${title}</title></head><body><nav epub:type="toc"><h1>目录</h1><ol><li><a href="manuscript.xhtml">${title}</a></li></ol></nav></body></html>`,
    },
    {
      name: 'EPUB/manuscript.xhtml',
      content: `${xml}<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN"><head><title>${title}</title></head><body>${manuscriptHtml(project)}</body></html>`,
    },
  ]);
}
