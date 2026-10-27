import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeChapterFile, MAX_TEXT_FILE_BYTES } from './manualChapter.js';
const bytes = (text:string) => new TextEncoder().encode(text).buffer;
test('chapter text import decodes BOM, newlines and preserves title and explicit paragraphs',()=>{
  assert.equal(decodeChapterFile(bytes('\uFEFF第1章 标题\r\n\r\n正文\r末段'),'utf-8'),'第1章 标题\n\n正文\n末段');
});
test('chapter text import rejects invalid encoding, binary, empty and oversized text',()=>{
  for(const value of [' \n','binary\0text','字'.repeat(200001)]) assert.throws(()=>decodeChapterFile(bytes(value),'utf-8'));
  assert.throws(()=>decodeChapterFile(new Uint8Array([0xff,0xfe,0xfd]).buffer,'utf-8'),/编码/);
  assert.throws(()=>decodeChapterFile(new ArrayBuffer(MAX_TEXT_FILE_BYTES+1),'utf-8'),/2 MB/);
});
test('chapter text import supports GBK-compatible GB18030 Chinese without guessing encoding',()=>{
  assert.equal(decodeChapterFile(new Uint8Array([0xd6,0xd0,0xce,0xc4]).buffer,'gb18030'),'中文');
});
