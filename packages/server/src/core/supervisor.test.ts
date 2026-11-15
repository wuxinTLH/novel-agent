import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { supervise, supervisorPolicy, type SupervisorEvent } from './supervisor.js';

const policy = { initialDelayMs: 10, maxDelayMs: 20, restartWindowMs: 60_000, maxRestarts: 3, startupTimeoutMs: 3_000, shutdownTimeoutMs: 100 };
const fixture = [
  "import fs from 'node:fs';",
  "const [mode, record] = process.argv.slice(2);",
  "fs.appendFileSync(record, JSON.stringify({pid:process.pid,at:Date.now()})+String.fromCharCode(10));",
  "const quit = signal => { fs.appendFileSync(record+'.stop', signal); setTimeout(()=>process.exit(0),20); };",
  "process.on('SIGINT',()=>{if(mode!=='stubborn')quit('SIGINT')});",
  "process.on('SIGTERM',()=>{if(mode!=='stubborn')quit('SIGTERM')});",
  "process.on('message',m=>{if(m.type==='novel-agent:shutdown'&&mode!=='stubborn')quit(m.signal)});",
  "process.on('disconnect',()=>process.exit(0));",
  "if(mode==='startup-fail')process.exit(78);",
  "if(mode!=='no-ready'&&mode!=='stubborn')process.send({type:'novel-agent:ready'});",
  "if(mode==='normal')setTimeout(()=>process.exit(0),20);",
  "if(mode==='crash')setTimeout(()=>process.exit(9),20);",
  "if(mode==='orderly')process.send({type:'novel-agent:stopping'},()=>process.exit(1));",
  "setInterval(()=>{},1000);",
].join('\n');

async function run(mode: string, onEvent?: (event: SupervisorEvent, signals: EventEmitter) => void, overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'novel-supervisor-'));
  const entry = path.join(dir, 'fixture.mjs');
  const record = path.join(dir, 'starts');
  const signals = new EventEmitter();
  const events: SupervisorEvent[] = [];
  await writeFile(entry, fixture);
  try {
    const code = await supervise({ entry, args: [mode, record], signals, policy: { ...policy, ...overrides }, onEvent(event) { events.push(event); onEvent?.(event, signals); } });
    const starts = (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {pid:number;at:number});
    let stopped = '';
    try { stopped = await readFile(record + '.stop', 'utf8'); } catch {}
    assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
    for (const {pid} of starts) assert.throws(() => process.kill(pid, 0));
    return { code, starts, events, stopped };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('production supervisor has immutable bounded defaults and validates injected policy', () => {
  assert.equal(Object.isFrozen(supervisorPolicy), true);
  assert.equal(supervisorPolicy.shutdownTimeoutMs, 25_000);
  assert.equal(supervisorPolicy.maxRestarts, 5);
  assert.throws(() => supervise({entry:'unused', policy:{...policy,maxRestarts:0}}), /SUPERVISOR_POLICY_INVALID/);
});
for (const [mode, code] of [['normal',0],['startup-fail',78],['orderly',1]] as const) {
  test(mode + ' exits once without retry', { timeout: 10_000 }, async () => {
    const result = await run(mode);
    assert.equal(result.code, code);
    assert.equal(result.starts.length, 1);
    assert.equal(result.events.some(event=>event.type==='restart'), false);
  });
}
test('post-ready crash has capped exponential retries on POSIX and fails closed on Windows', {timeout:15_000}, async()=>{
  const result = await run('crash');
  assert.equal(result.code, process.platform==='win32' ? 9 : 1);
  assert.equal(result.starts.length, process.platform==='win32' ? 1 : 4);
  assert.deepEqual(result.events.filter(event=>event.type==='restart').map(event=>event.delayMs), process.platform==='win32' ? [] : [10,20,20]);
});
for(const signal of ['SIGINT','SIGTERM'] as const) {
  test(signal+' is gracefully forwarded and never restarts', {timeout:10_000}, async()=>{
    const result=await run('wait',(event,signals)=>{if(event.type==='ready')signals.emit(signal)});
    assert.equal(result.code,0);
    assert.equal(result.stopped,signal);
    assert.equal(result.starts.length,1);
  });
}
test('readiness timeout gracefully stops startup without retry', {timeout:10_000}, async()=>{
  const result=await run('no-ready',undefined,{startupTimeoutMs:500,shutdownTimeoutMs:1000});
  assert.equal(result.code,1);
  assert.equal(result.starts.length,1);
});
test('shutdown before readiness escalates an uncooperative child without retry', {timeout:10_000}, async()=>{
  let timer: NodeJS.Timeout | undefined;
  try {
    const result=await run('stubborn',(event,signals)=>{if(event.type==='starting')timer=setTimeout(()=>signals.emit('SIGTERM'),300)});
    assert.equal(result.code,1);
    assert.equal(result.starts.length,1);
  } finally {clearTimeout(timer)}
});
test('signal during backoff cancels pending replacement', {skip:process.platform==='win32',timeout:10_000}, async()=>{
  const result=await run('crash',(event,signals)=>{if(event.type==='restart')signals.emit('SIGTERM')});
  assert.equal(result.starts.length,1);
  assert.equal(result.code,0);
});
