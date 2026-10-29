import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateDocxZip, readDocx } from '../documents/parser.js';

export type UploadPurpose = 'asset' | 'cover' | 'document' | 'chapter' | 'avatar' | 'stored-image';
export interface SafeUpload { name: string; extension: string; mime: string; buffer: Buffer; sha256: string; text?: string; html?: string; }
const MiB = 1024 * 1024;
const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp'];
const mimes: Record<string,string> = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.txt':'text/plain', '.md':'text/markdown', '.json':'application/json', '.pdf':'application/pdf', '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
export function sandboxError(message: string, code = 'UPLOAD_UNSAFE', status = 422) { return Object.assign(new Error(message), { code, status }); }
let active = 0;
/** Admission precedes multipart buffering. No original file is ever published by this module. */
export function reserveUpload() {
  if (active >= 2) throw sandboxError('上传安全检查繁忙，请稍后重试。', 'UPLOAD_SANDBOX_BUSY', 429);
  active++;
  let released = false;
  return () => { if (!released) { released = true; active--; } };
}
function imageSignature(buffer: Buffer, extension: string) {
  if (extension === '.png') return buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (extension === '.webp') return buffer.toString('ascii',0,4) === 'RIFF' && buffer.toString('ascii',8,12) === 'WEBP' && buffer.length >= 20 && buffer.readUInt32LE(4) + 8 === buffer.length;
  return buffer.length > 4 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
}
async function cleanImage(input: Buffer, signal?: AbortSignal): Promise<Buffer> {
  if (signal?.aborted) throw sandboxError('上传已取消。', 'UPLOAD_ABORTED', 499);
  const sharpModule = import.meta.resolve('sharp');
  const script = `import sharp from ${JSON.stringify(sharpModule)};sharp.cache(false);sharp.concurrency(1);const chunks=[];let size=0;for await(const c of process.stdin){size+=c.length;if(size>16777216)process.exit(2);chunks.push(c);}const image=sharp(Buffer.concat(chunks),{limitInputPixels:24000000,failOn:'warning',animated:false});const meta=await image.metadata();if(!meta.width||!meta.height||meta.width>6000||meta.height>6000||(meta.pages||1)>1)process.exit(3);const out=await image.rotate().png({compressionLevel:9}).toBuffer();if(out.length>16777216)process.exit(4);process.stdout.write(out);`;
  return new Promise((resolve,reject) => {
    const child = spawn(process.execPath,['--max-old-space-size=96','--input-type=module','-e',script],{ cwd: path.dirname(fileURLToPath(sharpModule)), windowsHide:true, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP, NODE_OPTIONS:'' }, stdio:['pipe','pipe','ignore'] });
    const chunks: Buffer[] = []; let length=0, failure:Error|undefined;
    // Keep the lease held until close confirms the native decoder has actually stopped.
    const stop=(error:Error) => {
      if(failure)return;
      failure=error; chunks.length=0;
      child.stdin.destroy(); child.kill('SIGKILL');
    };
    const abort=()=>stop(sandboxError('上传已取消。','UPLOAD_ABORTED',499));
    const timer=setTimeout(()=>stop(sandboxError('图片检查超时。','UPLOAD_SCAN_TIMEOUT')),10000);
    child.on('error',()=>stop(sandboxError('图片安全解码器不可用，文件未放行。','UPLOAD_SCANNER_UNAVAILABLE')));
    child.stdin.on('error',()=>{});
    child.stdout.on('data',(chunk:Buffer)=>{if(failure)return;length+=chunk.length;if(length>16*MiB)stop(sandboxError('图片重编码结果超过限制。','UPLOAD_OUTPUT_LIMIT',413));else chunks.push(chunk);});
    child.on('close',code=>{
      clearTimeout(timer); signal?.removeEventListener('abort',abort);
      if(failure)reject(failure);
      else if(code!==0 || !length)reject(sandboxError('图片损坏、尺寸过大或无法安全解码。'));
      else resolve(Buffer.concat(chunks));
    });
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort(); else child.stdin.end(input);
  });
}
function decodeText(buffer: Buffer, encoding: 'utf-8'|'gb18030') {
  let text:string;
  try { text=new TextDecoder(encoding,{fatal:true}).decode(buffer).replace(/^\uFEFF/,''); }
  catch { throw sandboxError('文本编码无效，请选择正确编码。','UPLOAD_TEXT_ENCODING'); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw sandboxError('纯文本包含二进制控制字符。');
  return text;
}
/** Validate then reconstruct approved formats. The caller may only store this returned copy. */
export async function inspectUpload(file: {originalname:string;buffer:Buffer}, purpose:UploadPurpose, encoding:'utf-8'|'gb18030'='utf-8', signal?:AbortSignal):Promise<SafeUpload> {
  if(signal?.aborted)throw sandboxError('上传已取消。','UPLOAD_ABORTED',499);
  const extension=path.extname(file.originalname).toLowerCase();
  const allowed= purpose==='asset' ? ['.txt','.md','.json',...imageExtensions] : purpose==='document' ? ['.docx','.pdf'] : purpose==='chapter' ? ['.txt'] : imageExtensions;
  if(!allowed.includes(extension)) throw sandboxError('此上传入口不支持该文件格式。','UPLOAD_FORMAT_REJECTED',415);
  const max= purpose==='stored-image' ? 16*MiB : purpose==='document'||purpose==='avatar' ? 8*MiB : imageExtensions.includes(extension) ? 4*MiB : 2*MiB;
  if(!file.buffer.length || file.buffer.length>max) throw sandboxError('文件为空或超过此入口大小限制。','UPLOAD_SIZE_LIMIT',413);
  if (/\u0000/.test(file.originalname)) throw sandboxError('文件名无效。');
  let buffer=Buffer.from(file.buffer), text:string|undefined, html:string|undefined, outputExtension=extension;
  if(imageExtensions.includes(extension)) {
    if(!imageSignature(buffer,extension)) throw sandboxError('图片内容与扩展名不符。');
    buffer=Buffer.from(await cleanImage(buffer,signal)); outputExtension='.png';
  } else if(extension==='.docx') {
    await validateDocxZip(buffer);
    if(signal?.aborted)throw sandboxError('上传已取消。','UPLOAD_ABORTED',499);
    html=await readDocx(buffer,signal);
    // Original OOXML never leaves quarantine; only sanitized semantic HTML is retained.
    buffer=Buffer.from(html,'utf8');
  } else if(extension==='.pdf') {
    // PDF object/filter/encryption combinations cannot be proved safe without content disarm.
    // Refuse rather than expose original bytes through the browser PDF engine.
    throw sandboxError('安全策略暂不放行原始 PDF；请另存为 DOCX 或 TXT 后上传。','UPLOAD_PDF_DISARM_REQUIRED',415);
  } else {
    text=decodeText(buffer,encoding);
    if(extension==='.json') { try { text=JSON.stringify(JSON.parse(text),null,2); } catch { throw sandboxError('JSON 文件格式无效。'); } }
    buffer=Buffer.from(text,'utf8');
  }
  const name=path.basename(file.originalname.replace(/\\/g,'/')).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,180)||`${randomUUID()}${outputExtension}`;
  return {name,extension:outputExtension,mime:mimes[outputExtension]!,buffer,sha256:createHash('sha256').update(buffer).digest('hex'),text,html};
}
