import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Local integrity evidence, NOT a trusted timestamp or protection from a host administrator. */
export class SecurityAuditLog {
  private previous = '0'.repeat(64);
  private sequence = 0;
  private failed = false;
  private readonly file: string;
  constructor(directory: string, private readonly maxBytes = 8 * 1024 * 1024, private readonly retained = 8) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('SECURITY_AUDIT_PATH_UNSAFE');
    this.file = path.join(directory, 'security-audit.jsonl');
    if (fs.existsSync(this.file)) {
      const fileStat = fs.lstatSync(this.file);
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1 || fileStat.size > maxBytes) throw new Error('SECURITY_AUDIT_INVALID');
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        const record = JSON.parse(line);
        const { hash, ...payload } = record;
        if (typeof hash !== 'string' || !Number.isSafeInteger(payload.sequence) || payload.sequence < 1 || (this.sequence > 0 && (payload.sequence !== this.sequence + 1 || payload.previous !== this.previous)) || this.hash(payload) !== hash) throw new Error('SECURITY_AUDIT_INTEGRITY_FAILED');
        this.previous = hash; this.sequence = payload.sequence;
      }
    }
  }
  private hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
  write(event: { event: string; requestId?: string; method?: string; status?: number; durationMs?: number; reason?: string }) {
    if (this.failed) throw new Error('SECURITY_AUDIT_UNAVAILABLE');
    try {
      // Explicit projection: never serialize arbitrary request/user data.
      const payload = { sequence: this.sequence + 1, previous: this.previous, time: new Date().toISOString(), event: event.event.slice(0, 64), requestId: event.requestId?.slice(0, 64), method: event.method?.slice(0, 16), status: event.status, durationMs: event.durationMs, reason: event.reason?.slice(0, 64) };
      const hash = this.hash(payload);
      const line = JSON.stringify({ ...payload, hash }) + '\n';
      if (fs.existsSync(this.file)) {
        const st = fs.lstatSync(this.file);
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new Error();
        if (st.size + Buffer.byteLength(line) > this.maxBytes) {
          for (let i = this.retained - 1; i >= 1; i--) {
            const old = `${this.file}.${i}`, next = `${this.file}.${i + 1}`;
            if (fs.existsSync(old)) fs.renameSync(old, next);
          }
          fs.renameSync(this.file, `${this.file}.1`);
        }
      }
      const fd = fs.openSync(this.file, 'a', 0o600);
      try {
        const bytes = Buffer.from(line);
        let offset = 0;
        while (offset < bytes.length) {
          const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
          if (!written) throw new Error('AUDIT_SHORT_WRITE');
          offset += written;
        }
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      this.previous = hash; this.sequence++;
    } catch { this.failed = true; throw new Error('SECURITY_AUDIT_UNAVAILABLE'); }
  }
}
