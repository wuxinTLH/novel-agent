import multer from 'multer';
import type { RequestHandler } from 'express';
import { reserveUpload } from './sandbox.js';
import { createUploadLease } from './upload-lease.js';
/** Reserve before buffering; after parsing, handlers release in finally after scanners have stopped. */
export function quarantinedUpload(field: string, maxFiles: number, maxBytes: number, fields = 0): RequestHandler {
  const parse = multer({ storage: multer.memoryStorage(), limits: { fileSize:maxBytes, files:maxFiles, fields, parts:maxFiles+fields, fieldSize:1024, fieldNameSize:80 } }).array(field,maxFiles);
  return (req,res,next) => {
    let returnSlot:()=>void;
    try { returnSlot=reserveUpload(); } catch(error) { next(error);return; }
    let parsing = true;
    const cleanup = () => {
      req.removeListener('aborted', disconnect);
      res.removeListener('close', disconnect);
    };
    const lease = createUploadLease(() => { cleanup(); returnSlot(); });
    const disconnect = () => {
      lease.disconnect();
      // During multipart parsing no handler owns cleanup. Terminate the input,
      // returning partially buffered memory, and never hand it to a scanner.
      if (parsing && !req.destroyed) req.destroy();
    };
    res.locals.uploadLease = lease;
    req.once('aborted', disconnect);
    res.once('close', disconnect);
    parse(req,res,error=>{
      parsing = false;
      if (error) { lease.release(); if (!lease.signal.aborted) next(error); return; }
      if (lease.handoff()) next();
    });
  };
}
