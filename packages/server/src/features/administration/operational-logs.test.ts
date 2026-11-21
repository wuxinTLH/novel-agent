import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { OperationalLogsStore, MAX_OPERATIONAL_LOGS, MAX_LOG_STORE_BYTES, MAX_ALERT_QUEUE } from './operational-logs.js';
import { defaultLogAlertConfig, OPERATIONAL_EVENT_CATALOG, type OperationalEventCode } from '../../../../../shared/operational-logs.js';
function fixture() {const dir=fs.mkdtempSync(path.join(os.tmpdir(),'novel-logs-'));return {dir,file:path.join(dir,'operational-logs.json'),clean:()=>fs.rmSync(dir,{recursive:true,force:true})};}
function enabled(store:OperationalLogsStore) {const {revision,...config}=store.alerts().config;store.updateAlerts({...config,expectedRevision:revision,enabled:true,providers:{wechat:true,feishu:false,dingtalk:false,wecom:false}});}
test('safe catalog only, defaults, persistence, detached responses and strict filter pagination',()=>{
 const f=fixture();try {
 const s=new OperationalLogsStore(f.dir);assert.equal(fs.existsSync(f.file),false);assert.equal(s.alerts().config.enabled,false);assert.ok(s.alerts().providers.every(p=>!p.available));
 for(const value of ['secret token','constructor','__proto__',{},null])assert.throws(()=>s.record(value as OperationalEventCode),/INVALID/);
 for(const code of Object.keys(OPERATIONAL_EVENT_CATALOG))s.record(code as OperationalEventCode);
 const result=s.query({level:'warning',search:'origin',limit:'1',offset:'0'});assert.equal(result.total,1);assert.equal(result.items[0].message,'Request origin rejected.');
 result.items[0].message='mutated';assert.equal(new OperationalLogsStore(f.dir).query({search:'origin'}).items[0].message,'Request origin rejected.');
 for(const query of [{limit:'201'},{limit:'0'},{offset:'10001'},{limit:2},{level:['error']},{foo:'x'},{search:'x'.repeat(101)},{search:'\n'},{from:'2026-02-30T00:00:00.000Z'},{from:'2026-01-02T00:00:00.000Z',to:'2026-01-01T00:00:00.000Z'}]) assert.throws(()=>s.query(query),/INVALID/);
 }finally{f.clean();}
});
test('revision CAS validates unknown fields and secret/URL config; reloads committed revision',()=>{
 const f=fixture();try{const s=new OperationalLogsStore(f.dir);const {revision,...config}=defaultLogAlertConfig();
 for(const extra of [{url:'https://example.com'},{secret:'secret'},{cooldownSeconds:0},{providers:{wechat:{url:'https://example.com'}}},{categories:['error','error']}])assert.throws(()=>s.updateAlerts({...config,expectedRevision:revision,...extra}),/INVALID/);
 const result=s.updateAlerts({...config,expectedRevision:0});assert.equal(result.config.revision,1);assert.throws(()=>s.updateAlerts({...config,expectedRevision:0}),/CONFLICT/);assert.equal(new OperationalLogsStore(f.dir).alerts().config.revision,1);
 }finally{f.clean();}
});
test('corrupt, replaced, oversized and unexpectedly missing store fails closed, never resets',()=>{
 for(const corrupt of ['{bad',JSON.stringify({version:1}), ' '.repeat(MAX_LOG_STORE_BYTES+1)]){const f=fixture();try{fs.writeFileSync(f.file,corrupt);const s=new OperationalLogsStore(f.dir);assert.throws(()=>s.record('SERVICE_STARTED'),/UNAVAILABLE/);assert.equal(fs.readFileSync(f.file,'utf8'),corrupt);}finally{f.clean();}}
 const f=fixture();try{const s=new OperationalLogsStore(f.dir);s.record('SERVICE_STARTED');fs.unlinkSync(f.file);assert.throws(()=>s.query(),/UNAVAILABLE/);assert.throws(()=>s.record('SERVICE_STARTED'),/UNAVAILABLE/);assert.equal(fs.existsSync(f.file),false);}finally{f.clean();}
});
test('write/rename failure preserves committed bytes and poisons process store',()=>{
 const f=fixture();const original=fs.renameSync;try{const s=new OperationalLogsStore(f.dir);s.record('SERVICE_STARTED');const before=fs.readFileSync(f.file,'utf8');fs.renameSync=()=>{throw new Error('private path or secret');};assert.throws(()=>s.record('HTTP_INTERNAL_ERROR'),/^Error: OPERATIONAL_LOGS_UNAVAILABLE$/);assert.equal(fs.readFileSync(f.file,'utf8'),before);assert.throws(()=>s.query(),/UNAVAILABLE/);}finally{fs.renameSync=original;f.clean();}
});
test('retention bounds count and age while rejecting forged catalog messages',()=>{
 const f=fixture();try{let now=Date.parse('2026-01-01T00:00:00.000Z');const s=new OperationalLogsStore(f.dir,{now:()=>now});s.record('SERVICE_STARTED');const doc=JSON.parse(fs.readFileSync(f.file,'utf8'));const event=doc.items[0];doc.items=Array.from({length:MAX_OPERATIONAL_LOGS},()=>({...event,id:randomUUID()}));fs.writeFileSync(f.file,JSON.stringify(doc));s.record('HTTP_INTERNAL_ERROR');assert.equal(s.query().total,MAX_OPERATIONAL_LOGS);now+=32*86400000;assert.equal(s.query().total,0);s.record('SERVICE_STARTED');assert.equal(JSON.parse(fs.readFileSync(f.file,'utf8')).items.length,1);
 const forged=JSON.parse(fs.readFileSync(f.file,'utf8'));forged.items[0].message='private raw message';fs.writeFileSync(f.file,JSON.stringify(forged));assert.throws(()=>s.query(),/UNAVAILABLE/);
 }finally{f.clean();}
});
test('reserved unavailable providers report unsupported without network; injected statuses dedup and restart never replay',async()=>{
 const f=fixture();try{const reserved=new OperationalLogsStore(f.dir);enabled(reserved);reserved.record('HTTP_INTERNAL_ERROR');await reserved.waitForIdle();assert.equal(reserved.deliveries()[0].status,'unsupported');
 let calls=0;let now=Date.now()+400000;const s=new OperationalLogsStore(f.dir,{now:()=>now,transports:{wechat:{send:async()=>{calls++;return 'sent';}}}});s.record('HTTP_INTERNAL_ERROR');s.record('HTTP_INTERNAL_ERROR');await s.waitForIdle();assert.equal(calls,1);assert.equal(s.deliveries().at(-1)?.status,'sent');assert.equal(new OperationalLogsStore(f.dir).deliveries().length,2);
 const restarted=new OperationalLogsStore(f.dir,{now:()=>now,transports:{wechat:{send:async()=>{calls++;return 'failed';}}}});await restarted.waitForIdle();restarted.record('HTTP_INTERNAL_ERROR');await restarted.waitForIdle();assert.equal(calls,1);now+=400000;restarted.record('HTTP_INTERNAL_ERROR');await restarted.waitForIdle();assert.equal(calls,2);assert.equal(restarted.deliveries().at(-1)?.status,'failed');
 }finally{f.clean();}
});
test('timeout/exception are unknown, no retry; queue stays bounded and unresolved close fails',async()=>{
 const f=fixture();try{let calls=0;let now=Date.now();const s=new OperationalLogsStore(f.dir,{now:()=>now,deliveryTimeoutMs:5,transports:{wechat:{send:async()=>{calls++;return await new Promise(()=>{});}}}});enabled(s);
 for(let i=0;i<MAX_ALERT_QUEUE+5;i++){now+=400000;s.record('HTTP_INTERNAL_ERROR');}
 await assert.rejects(s.waitForIdle(),/UNAVAILABLE/);assert.equal(calls,1);assert.ok(s.deliveries().every(d=>d.status==='unknown'));await assert.rejects(s.close(),/UNAVAILABLE/);
 }finally{f.clean();}
 const g=fixture();try{const s=new OperationalLogsStore(g.dir,{transports:{wechat:{send:async()=>{throw new Error('secret');}}}});enabled(s);s.record('HTTP_INTERNAL_ERROR');await s.waitForIdle();assert.equal(s.deliveries()[0].status,'unknown');assert.ok(!fs.readFileSync(g.file,'utf8').includes('secret'));}finally{g.clean();}
});
test('disabled config invalidates queued delivery before side effects',async()=>{
 const f=fixture();try{let calls=0;const s=new OperationalLogsStore(f.dir,{transports:{wechat:{send:async()=>{calls++;return 'sent';}}}});enabled(s);s.record('HTTP_INTERNAL_ERROR');const {revision,...config}=s.alerts().config;s.updateAlerts({...config,expectedRevision:revision,enabled:false});await s.waitForIdle();assert.equal(calls,0);assert.equal(s.deliveries()[0].status,'unknown');}finally{f.clean();}
});

test('timed-out transport must settle before quiescence or close can succeed',async()=>{
 const f=fixture();let release!:()=>void;let aborted!:()=>void;
 const timeoutObserved=new Promise<void>(resolve=>{aborted=resolve;});
 const pending=new Promise<void>(resolve=>{release=resolve;});
 const s=new OperationalLogsStore(f.dir,{deliveryTimeoutMs:5,transports:{wechat:{send:async(_event,signal)=>{signal.addEventListener('abort',aborted,{once:true});await pending;return 'sent';}}}});
 try {
  enabled(s);s.record('HTTP_INTERNAL_ERROR');await timeoutObserved;
  await assert.rejects(s.waitForIdle(),/OPERATIONAL_LOGS_UNAVAILABLE/);
  await assert.rejects(s.close(),/OPERATIONAL_LOGS_UNAVAILABLE/);
  assert.equal(s.deliveries()[0].status,'unknown');
  release();await pending;await new Promise<void>(resolve=>setImmediate(resolve));
  await s.waitForIdle();await s.close();
  assert.equal(s.deliveries()[0].status,'unknown');
 }finally{release();f.clean();}
});

test('directory and hard-linked files cannot become the control-plane store',()=>{
 const f=fixture();try{fs.mkdirSync(f.file);assert.throws(()=>new OperationalLogsStore(f.dir).query(),/UNAVAILABLE/);}finally{f.clean();}
 const g=fixture();try{const target=path.join(g.dir,'target');fs.writeFileSync(target,'{}');fs.linkSync(target,g.file);assert.throws(()=>new OperationalLogsStore(g.dir).query(),/UNAVAILABLE/);assert.equal(fs.readFileSync(target,'utf8'),'{}');}finally{g.clean();}
});
