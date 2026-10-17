import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project, Run, WorkflowSettings } from '../shared/types.js';
import type { Store } from './store.js';
import type { PlatformRuntime } from './platform-runtime.js';
import { completeWorkflowPublication } from './workflow-publication.js';

function fixture() {
  const run: Run = { id: 'run', status: 'done', mode: 'live', startedAt: '', generatedChapterIds: ['chapter'], chapters: [{number: 1, status: 'done', validationStatus: 'passed', reviewStatus: 'done', requirements: {instructions:'',requiredText:[],forbiddenText:[]}, issues: []}] };
  const project: Project = {id:'project', title:'Title', genre:'', description:'', createdAt:'',updatedAt:'', assets:[],steps:[],chapters:[{id:'chapter',number:1,revision:1,title:'第1章 标题',content:'Body',updatedAt:'',mode:'live',runId:'run'}],run};
  const workflow: WorkflowSettings = {id:'workflow',edges:[],chapterCount:1,autoGenerate:true,automationMode:'automatic',publication:{enabled:true,linkId:'binding',volumeId:'volume',action:'submit_review',useAi:1}};
  const writes: string[] = [];
  const calls: unknown[][] = [];
  const store = {touch: () => {writes.push(run.publication?.state ?? 'none');}} as unknown as Store;
  const runtime = {preparePublication: async (...args: unknown[]) => {calls.push(args); assert.equal(run.publication?.state,'pending'); return {id:'batch'};}} as unknown as Pick<PlatformRuntime,'preparePublication'>;
  return {run,project,workflow,writes,calls,store,runtime};
}
test('automatic workflow durably admits explicit exact run chapters then server automatically approves queue', async () => {
  const f=fixture();
  await completeWorkflowPublication(f.store,f.runtime,f.project,f.run,f.workflow);
  assert.deepEqual(f.writes,['pending','queued']);
  assert.deepEqual(f.calls,[['project','binding',['chapter'],'submit_review',1,'volume',true]]);
  assert.deepEqual(f.run.publication,{state:'queued',batchId:'batch'});
  await completeWorkflowPublication(f.store,f.runtime,f.project,f.run,f.workflow);
  assert.equal(f.calls.length,1);
});
test('manual, demo, failure, partial, stale and unconfigured workflows never upload', async t => {
  for (const variant of ['manual','demo','error','partial','stale','unconfigured','single-step','foreign-chapter'] as const) await t.test(variant,async()=>{
    const f=fixture();
    if(variant==='manual')f.workflow.automationMode='manual';
    if(variant==='demo')f.run.mode='demo';
    if(variant==='error')f.run.status='error';
    if(variant==='partial')f.run.chapters![0].status='candidate';
    if(variant==='stale')f.project.run={...f.run,id:'new'};
    if(variant==='unconfigured')f.workflow.publication!.enabled=false;
    if(variant==='single-step')f.run.stepId='writer';
    if(variant==='foreign-chapter')f.project.chapters[0].runId='prior';
    await completeWorkflowPublication(f.store,f.runtime,f.project,f.run,f.workflow);
    assert.deepEqual(f.calls,[]); assert.deepEqual(f.writes,[]);
  });
});
test('handoff failure remains durable and never automatically retries or exposes browser messages', async()=>{
  const f=fixture();
  f.runtime.preparePublication=async()=>{throw new Error('secret-cookie');};
  await completeWorkflowPublication(f.store,f.runtime,f.project,f.run,f.workflow);
  assert.deepEqual(f.writes,['pending','failed']);
  assert.equal(f.run.publication?.state,'failed');
  assert.ok(!f.run.publication?.error?.includes('secret-cookie'));
  await completeWorkflowPublication(f.store,f.runtime,f.project,f.run,f.workflow);
  assert.deepEqual(f.writes,['pending','failed']);
});
test('admission persistence failure prevents remote preparation',async()=>{
  const f=fixture(); f.store.touch=()=>{throw new Error('disk');};
  await assert.rejects(completeWorkflowPublication(f.store,f.runtime,f.project,f.run,f.workflow),/disk/);
  assert.deepEqual(f.calls,[]);
});
