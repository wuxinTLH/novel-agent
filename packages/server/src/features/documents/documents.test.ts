import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import yauzl from 'yauzl';
import { documentsService } from './documents.js';
import { exportManuscript, manuscriptHtml, safeDocumentFilename, zipFiles } from './exports.js';
import { readDocx, sanitizeDocumentHtml, validateDocxZip } from './parser.js';
import { installHttpFallbacks, installHttpPolicy } from '../../core/http.js';
import type { Project } from '../../../../../shared/types.js';
import { DOCUMENT_MAX_BYTES } from '../../../../../shared/documents.js';

const project = {
  id: 'project-one',
  title: '中文 <书> & "稿件" / ..\r\n',
  chapters: [
    { id: 'second', number: 2, title: '第二章', content: '次章正文', revision: 1 },
    {
      id: 'first',
      number: 1,
      title: '第一章 <script>',
      content: '中文正文 & <script>alert(1)</script>\n第二段',
      revision: 1,
    },
  ],
  assets: [{ content: 'ASSET_NOT_CANONICAL' }],
  candidates: [{ content: 'CANDIDATE_NOT_CANONICAL' }],
} as unknown as Project;
async function unzip(data: Buffer): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(data, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      const files = new Map<string, string>();
      zip.on('error', reject);
      zip.on('end', () => resolve(files));
      zip.on('entry', (entry) =>
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) return reject(error);
          const chunks: Buffer[] = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => {
            files.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
            zip.readEntry();
          });
        }),
      );
      zip.readEntry();
    });
  });
}
test('DOCX export has actual OOXML relationships, canonical ordered text, CJK font hint and round-trips through mammoth', async () => {
  const data = await exportManuscript(project, 'docx');
  assert.equal(data.subarray(0, 2).toString(), 'PK');
  const files = await unzip(data);
  assert.ok(files.has('[Content_Types].xml'));
  assert.match(files.get('_rels/.rels')!, /Target="word\/document.xml"/);
  assert.match(files.get('word/styles.xml')!, /w:eastAsia="Microsoft YaHei"/);
  const xml = files.get('word/document.xml')!;
  assert.ok(xml.indexOf('第一章') < xml.indexOf('第二章'));
  assert.match(xml, /&lt;script&gt;/);
  assert.doesNotMatch(xml, /ASSET_NOT_CANONICAL|CANDIDATE_NOT_CANONICAL/);
  const html = await readDocx(data);
  assert.match(html, /<h1>第一章 &lt;script&gt;<\/h1>/);
  assert.match(html, /中文正文 &amp; &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
test('EPUB package contains uncompressed first mimetype, manifest, spine, nav and escaped XHTML', async () => {
  const data = await exportManuscript(project, 'epub');
  assert.equal(data.readUInt16LE(8), 0);
  assert.equal(data.subarray(30, 38).toString(), 'mimetype');
  const files = await unzip(data);
  assert.equal(files.get('mimetype'), 'application/epub+zip');
  assert.match(files.get('META-INF/container.xml')!, /EPUB\/package.opf/);
  assert.match(files.get('EPUB/package.opf')!, /<spine><itemref idref="book"/);
  assert.match(files.get('EPUB/nav.xhtml')!, /epub:type="toc"/);
  assert.match(files.get('EPUB/manuscript.xhtml')!, /中文 &lt;书&gt; &amp; &quot;稿件&quot;/);
});
test('sanitizer removes active markup, event handlers, styles, remote links and images', () => {
  const html = sanitizeDocumentHtml(
    '<h2 onclick="x()">标题</h2><script>alert(1)</script><a href="https://attacker.invalid">链接</a><img src="file:///secret"><iframe src="http://x"></iframe><svg><a>bad</a></svg><p style="background:url(http://x)">正文</p>',
  );
  assert.equal(html, '<h2>标题</h2>链接<p>正文</p>');
  assert.doesNotMatch(manuscriptHtml(project), /<script>/);
  for (const title of ['../../CON\r\n\"<>', 'NUL', '...', '汉字/稿件']) {
    assert.doesNotMatch(safeDocumentFilename(title, 'docx'), /[\r\n<>:"/\\|?*]/);
  }
});
test('ZIP validation rejects invalid structure, duplicate names, oversized input and expansion bombs', async () => {
  await assert.rejects(validateDocxZip(Buffer.from('not a zip')), /有效/);
  await assert.rejects(validateDocxZip(Buffer.alloc(DOCUMENT_MAX_BYTES + 1)), /8 MiB/);
  await assert.rejects(
    validateDocxZip(await zipFiles([{ name: 'word/document.xml', content: 'x' }])),
    /必需/,
  );
  await assert.rejects(
    validateDocxZip(
      await zipFiles([
        { name: '[Content_Types].xml', content: 'x' },
        { name: 'word/document.xml', content: 'x' },
        { name: 'word/document.xml', content: 'y' },
      ]),
    ),
    /重复/,
  );
  await assert.rejects(
    validateDocxZip(
      await zipFiles([
        { name: '[Content_Types].xml', content: 'x' },
        { name: 'word/document.xml', content: 'x'.repeat(1024 * 1024) },
      ]),
    ),
    /解压比例/,
  );
});
test('document API preserves CSRF and project isolation, rejects legacy/mismatched formats, serves only PDF with restrictive headers', async () => {
  const app = express();
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  installHttpPolicy(
    app,
    { dir: process.cwd(), platformRuntime: { csrfToken: 'token' } } as never,
    address.port,
  );
  app.param('projectId', (_req, res, next, id) => {
    res.locals.project = { ...project, id };
    next();
  });
  documentsService.register(app, {} as never);
  installHttpFallbacks(app, '.');
  const root = `http://127.0.0.1:${address.port}`;
  const localHost = `127.0.0.1:${address.port}`;
  async function upload(name: string, bytes: string | Buffer, csrf = true) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(Buffer.from(bytes))]), name);
    return fetch(root + '/api/projects/project-one/documents', {
      method: 'POST',
      body: form,
      headers: { host: localHost, ...(csrf ? { 'X-Platform-CSRF': 'token' } : {}) },
    });
  }
  try {
    assert.equal((await upload('test.pdf', '%PDF-1.4\n%%EOF', false)).status, 403);
    const legacy = await upload('test.doc', 'old');
    assert.equal(legacy.status, 415);
    assert.equal((await legacy.json()).code, 'LEGACY_DOC_UNSUPPORTED');
    assert.equal((await upload('test.pdf', '<script>fake</script>')).status, 400);
    assert.equal((await upload('test.html', '<html>')).status, 415);
    assert.equal((await upload('test.pdf', Buffer.alloc(DOCUMENT_MAX_BYTES + 1))).status, 413);
    const response = await upload('test.pdf', '%PDF-1.4\n%%EOF');
    assert.equal(response.status, 201);
    const preview = await response.json();
    const resource = await fetch(root + preview.resourceUrl, {
      headers: { host: `127.0.0.1:${address.port}` },
    });
    assert.equal(resource.status, 200);
    assert.equal(resource.headers.get('content-type'), 'application/pdf');
    assert.equal(resource.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.match(resource.headers.get('content-security-policy')!, /sandbox/);
    assert.match(resource.headers.get('cache-control')!, /no-store/);
    const foreign = await fetch(root + preview.resourceUrl.replace('project-one', 'project-two'), {
      headers: { host: `127.0.0.1:${address.port}` },
    });
    assert.equal(foreign.status, 404);
    const exported = await fetch(root + '/api/projects/project-one/documents/export/docx', {
      headers: { host: `127.0.0.1:${address.port}` },
    });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-disposition')!, /filename\*=UTF-8''/);
    assert.equal((await unzip(Buffer.from(await exported.arrayBuffer()))).has('word/document.xml'), true);
    const printed = await fetch(root + '/api/projects/project-one/documents/print', {
      headers: { host: `127.0.0.1:${address.port}` },
    });
    assert.match((await printed.json()).html, /<h2>第一章/);
    const removed = await fetch(root + preview.resourceUrl.replace('/resource', ''), {
      method: 'DELETE',
      headers: { host: `127.0.0.1:${address.port}`, 'X-Platform-CSRF': 'token' },
    });
    assert.equal(removed.status, 200);
    assert.equal(
      (await fetch(root + preview.resourceUrl, { headers: { host: `127.0.0.1:${address.port}` } })).status,
      404,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
