import type { FeatureService } from '../../core/context.js';
import { quarantinedUpload } from './upload.js';
import { inspectUpload } from './sandbox.js';
export const fileSandboxService: FeatureService = {
  id:'file-sandbox',
  register(app) {
    app.get('/api/file-sandbox/policy',(_req,res)=>res.json({version:1,mode:'quarantine-and-reconstruct',images:'decode-and-reencode-png',documents:'docx-semantic-html-only',pdf:'rejected-until-disarm',maxConcurrent:2}));
    app.post('/api/file-sandbox/chapter',quarantinedUpload('file',1,2*1024*1024,1),async(req,res)=>{
      try {
      const file=(req.files as Express.Multer.File[]|undefined)?.[0];
      if(!file)return res.status(400).json({code:'UPLOAD_REQUIRED',error:'请选择正文文件。'});
      const encoding=req.body?.encoding;
      if(encoding!==undefined && !['utf-8','gb18030'].includes(encoding))return res.status(400).json({code:'UPLOAD_TEXT_ENCODING',error:'不支持的文本编码。'});
      const safe=await inspectUpload(file,'chapter',encoding||'utf-8',res.locals.uploadLease.signal);
      res.json({name:safe.name,text:safe.text,sha256:safe.sha256});
      } finally { res.locals.uploadLease.release(); }
    });
    app.post('/api/file-sandbox/avatar',quarantinedUpload('file',1,8*1024*1024),async(req,res)=>{
      try {
      const file=(req.files as Express.Multer.File[]|undefined)?.[0];
      if(!file)return res.status(400).json({code:'UPLOAD_REQUIRED',error:'请选择头像文件。'});
      const safe=await inspectUpload(file,'avatar',undefined,res.locals.uploadLease.signal);
      res.json({dataUrl:`data:image/png;base64,${safe.buffer.toString('base64')}`,sha256:safe.sha256});
      } finally { res.locals.uploadLease.release(); }
    });
  },
};
