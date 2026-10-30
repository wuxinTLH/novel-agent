import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecurityAuditLog } from './security-audit.js';

test('audit writes projected chained records, survives restart and rejects modified history', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  try {
    const log = new SecurityAuditLog(dir);
    log.write({ event: 'request.accepted', requestId: 'one', method: 'POST' });
    new SecurityAuditLog(dir).write({ event: 'request.completed', status: 200 });
    const file = path.join(dir, 'security-audit.jsonl');
    const records = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records[1].previous, records[0].hash);
    assert.equal(records[1].sequence, 2);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('POST', 'EVIL'));
    assert.throws(() => new SecurityAuditLog(dir), /SECURITY_AUDIT_INTEGRITY_FAILED/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('audit rotates bounded segments, resumes last segment and poisons after write failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  try {
    const log = new SecurityAuditLog(dir, 700, 2);
    for (let i = 0; i < 12; i++) log.write({ event: 'request.completed', status: 200 });
    assert.ok(fs.readdirSync(dir).length <= 3);
    new SecurityAuditLog(dir, 700, 2).write({ event: 'service.starting' });
    const file = path.join(dir, 'security-audit.jsonl');
    fs.unlinkSync(file); fs.mkdirSync(file);
    assert.throws(() => log.write({ event: 'request.accepted' }), /SECURITY_AUDIT_UNAVAILABLE/);
    fs.rmdirSync(file);
    assert.throws(() => log.write({ event: 'request.accepted' }), /SECURITY_AUDIT_UNAVAILABLE/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
