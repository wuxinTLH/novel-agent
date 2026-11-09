import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { emptyRequirements } from '../../../../../shared/generation.js';
import type { Chapter, Project } from '../../../../../shared/types.js';
import { Store } from '../projects/store.js';
import { Runner, type RuntimeSettings } from './engine.js';

const stages = ['plan', 'draft', 'review'] as const;
const taskMarker = (stage: typeof stages[number]) => `CONTINUITY_TEST_TASK_${stage}`;
const revisedEnding = 'CANONICAL_CH6_MANUALLY_REVISED_END: The red door opens into the rain.';
const staleEnding = 'ARCHIVED_CH6_END_MUST_NOT_BE_USED';
const candidateEnding = 'UNADOPTED_CH6_CANDIDATE_MUST_NOT_BE_USED';
const futureEnding = 'FUTURE_CH9_MUST_NOT_BE_USED';
const staleOutput = 'STALE_WRITER_OUTPUT_MUST_NOT_BE_USED';
const freshEnding = 'JUST_SAVED_CH7_END: She steps through the red door holding the brass key.';

function chapter(number: number, content: string): Chapter {
  return {
    id: `continuity-chapter-${number}`,
    number,
    revision: 1,
    title: `Chapter ${number}`,
    content,
    mode: 'live',
    updatedAt: '2025-01-01T00:00:00.000Z',
  };
}

async function withStore(fn: (store: Store, project: Project) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-continuity-integration-'));
  try {
    const store = new Store(dir);
    const project = store.projects[0];
    for (const stage of stages) project.steps.find((step) => step.id === stage)!.prompt = taskMarker(stage);
    project.steps.find((step) => step.id === 'draft')!.output = staleOutput;
    const previous = chapter(6, `CH6_OPENING\n${'Earlier events before the revised final scene. '.repeat(400)}\n${revisedEnding}`);
    previous.revision = 2;
    previous.updatedAt = '2025-02-01T00:00:00.000Z';
    previous.revisions = [{
      revision: 1,
      title: previous.title,
      content: staleEnding,
      mode: 'live',
      updatedAt: '2025-01-01T00:00:00.000Z',
    }];
    // Intentionally unsorted: select by chapter number, not array order or timestamp.
    project.chapters = [previous, chapter(9, futureEnding), chapter(4, 'CANONICAL_CH4'), chapter(5, 'CANONICAL_CH5')];
    project.chapterNumberHighWatermark = 9;
    project.candidates = [{
      id: 'unadopted-ch6',
      number: 6,
      chapterId: previous.id,
      baseRevision: previous.revision,
      title: 'Unadopted alternative',
      content: candidateEnding,
      issues: [],
      createdAt: '2025-03-01T00:00:00.000Z',
      mode: 'live',
      generationMode: 'regenerate',
      workflowId: project.activeWorkflowId!,
      runId: 'previous-candidate-run',
      outputWriterNodeId: 'draft',
      requirements: emptyRequirements(),
      semanticStatus: 'pending-author',
    }];
    store.touch(project);
    await fn(store, project);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withModel(
  respond: (index: number) => string,
  fn: (settings: RuntimeSettings, requests: string[]) => Promise<void>,
  onRequest?: (index: number) => void,
) {
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const data = JSON.parse(body);
    requests.push(data.messages?.[1]?.content || '');
    const index = requests.length - 1;
    onRequest?.(index);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: respond(index) } }],
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await fn({
      mode: 'live', apiKey: 'local-stub-only', hasKey: true, model: 'continuity-test',
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      protocol: 'chat-completions',
    }, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function continuityAnchor(prompt: string, stage: string): string {
  const match = prompt.match(/<前章衔接锚点>([\s\S]*?)<\/前章衔接锚点>/u);
  assert.ok(match, `${stage} request must contain the dedicated continuity anchor`);
  return match[1];
}

function assertCleanPrompt(prompt: string, stage: typeof stages[number]) {
  assert.ok(prompt.includes(taskMarker(stage)), `expected actual ${stage} model request`);
  for (const excluded of [futureEnding, candidateEnding, staleEnding, staleOutput]) {
    assert.equal(prompt.includes(excluded), false, `${stage} must not receive ${excluded}`);
  }
}

function modelResponse(index: number): string {
  if (index % 3 === 0) return `PLAN_FOR_CHAPTER_${7 + Math.floor(index / 3)}`;
  if (index % 3 === 2) return '{"status":"passed","issues":[]}';
  return index === 1 ? `Chapter 7\nA newly generated scene.\n${freshEnding}` : 'Chapter 8\nShe carries the key into the rain.\nCH8_NEW_END';
}

test('Runner supplies the latest manually revised canonical chapter ending to plan, draft and review', async () => {
  await withStore(async (store, project) => withModel(modelResponse, async (settings, requests) => {
    await new Runner(store).run(project, settings, { target: { kind: 'single', number: 7 } });
    assert.equal(project.run!.status, 'done', project.run!.error);
    assert.equal(requests.length, 3, 'execute all three real model stages');
    for (const [index, stage] of stages.entries()) {
      const prompt = requests[index];
      assertCleanPrompt(prompt, stage);
      assert.ok(continuityAnchor(prompt, stage).includes(revisedEnding), `${stage} must receive the revised tail, not only the chapter opening`);
    }
    assert.ok(project.chapters.find((item) => item.number === 7)!.content.includes(freshEnding));
    assert.equal(project.chapters.find((item) => item.number === 6)!.revision, 2);
    assert.equal(project.candidates!.find((item) => item.id === 'unadopted-ch6')!.content, candidateEnding);
  }));
});

test('Runner keeps an audit-rejected continuity jump as a candidate instead of saving chapter 7', async () => {
  await withStore(async (store, project) => {
    project.workflow!.automationMode = 'automatic';
    project.workflow!.maxAutoRepairs = 0;
    const originalChapters = structuredClone(project.chapters);
    await withModel((index) => index === 2
      ? JSON.stringify({ status: 'failed', issues: [{ message: 'Continuity jump', evidence: 'The new scene skips the open red door.' }] })
      : modelResponse(index), async (settings, requests) => {
      await new Runner(store).run(project, settings, { target: { kind: 'single', number: 7 } });
      assert.equal(requests.length, 3, 'zero automatic repairs must not issue another writer request');
      assert.equal(project.run!.status, 'error');
      assert.equal(project.run!.errorCode, 'REVIEW_VALIDATION_FAILED');
      for (const [index, stage] of stages.entries()) {
        assertCleanPrompt(requests[index], stage);
        assert.ok(continuityAnchor(requests[index], stage).includes(revisedEnding));
      }
      assert.deepEqual(project.chapters, originalChapters, 'audit rejection must leave every canonical chapter unchanged');
      const candidate = project.candidates!.find((item) => item.number === 7)!;
      assert.ok(candidate.content.includes(freshEnding));
      assert.equal(candidate.reviewResult!.status, 'failed');
      assert.equal(candidate.repairAttempts, 0);
      const persisted = new Store(store.dir).projects.find((item) => item.id === project.id)!;
      assert.equal(persisted.chapters.some((item) => item.number === 7), false);
      assert.equal(persisted.candidates!.find((item) => item.id === candidate.id)!.reviewResult!.status, 'failed');
    });
  });
});

test('Runner sequential chapters propagate the just-saved prior output into every next-chapter stage', async () => {
  await withStore(async (store, project) => {
    let savedBeforeNextPlan: Chapter | undefined;
    await withModel(modelResponse, async (settings, requests) => {
      await new Runner(store).run(project, settings, { target: { kind: 'range', from: 7, to: 8 } });
      assert.equal(project.run!.status, 'done', project.run!.error);
      assert.equal(requests.length, 6, 'run plan, draft and review separately for both chapters');
      assert.ok(savedBeforeNextPlan?.content.includes(freshEnding), 'chapter 7 must already be durably saved when chapter 8 planning starts');
      for (let chapterIndex = 0; chapterIndex < 2; chapterIndex += 1) {
        for (const [stageIndex, stage] of stages.entries()) {
          const prompt = requests[chapterIndex * stages.length + stageIndex];
          assertCleanPrompt(prompt, stage);
          const anchor = continuityAnchor(prompt, stage);
          assert.ok(anchor.includes(chapterIndex === 0 ? revisedEnding : freshEnding), `${stage} must anchor chapter ${7 + chapterIndex} to its current canonical predecessor`);
          if (chapterIndex === 1) {
            assert.equal(anchor.includes(revisedEnding), false, `${stage} chapter 8 anchor must advance beyond chapter 6`);
          }
        }
      }
      const persisted = new Store(store.dir).projects.find((item) => item.id === project.id)!;
      assert.ok(persisted.chapters.find((item) => item.number === 7)!.content.includes(freshEnding));
      assert.ok(persisted.chapters.find((item) => item.number === 8)!.content.includes('CH8_NEW_END'));
    }, (index) => {
      if (index === 3) {
        savedBeforeNextPlan = new Store(store.dir).projects.find((item) => item.id === project.id)!.chapters.find((item) => item.number === 7);
      }
    });
  });
});
