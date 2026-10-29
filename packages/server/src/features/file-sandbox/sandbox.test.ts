import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import yazl from 'yazl';
import { inspectUpload, reserveUpload } from './sandbox.js';
import { validateDocxZip } from '../documents/parser.js';

function zip(entries:Record<string,string>):Promise<Buffer> { return new Promise(resolve=>{const archive=new yazl.ZipFile();const chunks:Buffer[]=[];archive.outputStream.on('data',c=>chunks.push(c));archive.outputStream.on('end',()=>resolve(Buffer.concat(chunks)));for(const [name,value]of Object.entries(entries)) archive.addBuffer(Buffer.from(value),name);archive.end();}); }
test('sandbox rejects disguises, executables, invalid encoding and PDF without disarm',async()=>{
  await assert.rejects(inspectUpload({originalname:'image.png',buffer:Buffer.from('MZpayload')},'asset'));
  await assert.rejects(inspectUpload({originalname:'payload.exe',buffer:Buffer.from('MZpayload')},'asset'));
  await assert.rejects(inspectUpload({originalname:'body.txt',buffer:Buffer.from([255,254,0])},'chapter'));
  await assert.rejects(inspectUpload({originalname:'book.pdf',buffer:Buffer.from('%PDF-1.7\n/JavaScript %%EOF')},'document'),{code:'UPLOAD_PDF_DISARM_REQUIRED'});
});
test('sandbox fully decodes and reconstructs image, removing appended data and metadata',async()=>{
  const original=await sharp({create:{width:2,height:2,channels:3,background:'#123456'}}).jpeg().toBuffer();
  const checked=await inspectUpload({originalname:'../../picture.jpg',buffer:Buffer.concat([original,Buffer.from('<script>evil</script>')])},'cover');
  assert.equal(checked.extension,'.png');assert.equal(checked.name,'picture.jpg');assert.equal(checked.buffer.includes(Buffer.from('evil')),false);
  const meta=await sharp(checked.buffer).metadata();assert.equal(meta.width,2);assert.equal(meta.format,'png');assert.equal(meta.exif,undefined);
});
test('sandbox rejects truncated decoders and oversized image dimensions',async()=>{
  await assert.rejects(inspectUpload({originalname:'fake.jpg',buffer:Buffer.from([255,216,255,0,0])},'asset'));
  const wide=await sharp({create:{width:6001,height:1,channels:3,background:'white'}}).png().toBuffer();
  await assert.rejects(inspectUpload({originalname:'wide.png',buffer:wide},'asset'));
});
test('all text passes fatal decoding and binary control validation; JSON is reconstructed',async()=>{
  const checked=await inspectUpload({originalname:'safe.json',buffer:Buffer.from('{"a":1}')},'asset');
  assert.equal(checked.text,'{\n  "a": 1\n}');assert.equal(checked.sha256.length,64);
  await assert.rejects(inspectUpload({originalname:'fake.txt',buffer:Buffer.from('abc\u0000def')},'chapter'));
  await assert.rejects(inspectUpload({originalname:'broken.json',buffer:Buffer.from('{')},'asset'));
});
test('multipart admission is bounded and release is idempotent',()=>{
  const one=reserveUpload(),two=reserveUpload();assert.throws(()=>reserveUpload(),{code:'UPLOAD_SANDBOX_BUSY'});one();one();const next=reserveUpload();next();two();
});
test('DOCX blocks macros, external resources, embedded active content and XML entities',async()=>{
  const cases: Record<string,string>[] = [
    {'word/vbaProject.bin':'macro'},
    {'word/_rels/document.xml.rels':'<Relationship TargetMode="External" Target="http://bad"/>'},
    {'word/document.xml':'<!DOCTYPE x [<!ENTITY z SYSTEM "file:///secret">]><w:document/>'},
  ];
  for (const entries of cases) {
    const buffer=await zip({'[Content_Types].xml':'<Types/>','word/document.xml':'<w:document/>',...entries});
    await assert.rejects(validateDocxZip(buffer));
  }
});
