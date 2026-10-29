import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelSettings, Project, Step } from '../../../../../shared/types';
import { graphSnapshot } from '../generation/generationState.js';
import { nodeContextSummary, nodeModelSummary } from './nodeConfiguration.js';

const step: Step = {
  id: 'character-one', title: '人物', subtitle: '', prompt: '人物档案',
  kind: 'character', status: 'idle', output: '', position: { x: 0, y: 0 },
};
const settings: ModelSettings = {
  baseUrl: 'https://example.com', model: 'global-model', mode: 'live', hasKey: true,
  models: [{ id: 'local', name: '人物模型', baseUrl: 'https://example.com', model: 'character-model',
    protocol: 'responses', enabled: true, hasKey: true, createdAt: '' }],
};

test('node model summary follows explicit model and reports unavailable configuration without fallback', () => {
  assert.equal(nodeModelSummary(step, settings).label, 'global-model');
  assert.match(nodeModelSummary({ ...step, modelId: 'local' }, settings).label, /character-model/);
  assert.match(nodeModelSummary({ ...step, modelId: 'deleted' }, settings).label, /已删除/);
  const disabled = { ...settings, models: settings.models!.map((model) => ({ ...model, enabled: false })) };
  assert.match(nodeModelSummary({ ...step, modelId: 'local' }, disabled).label, /不可用/);
  assert.match(nodeModelSummary(step, { ...settings, mode: 'demo' }).label, /不调用模型/);
});

function projectWithSteps(): Project {
  return {
    id: 'p', title: '测试', genre: '', description: '', createdAt: '', updatedAt: '', chapters: [],
    activeWorkflowId: 'w',
    assets: [{ id: 'a', name: '资料A', category: 'world', content: '内容', size: 2, createdAt: '' },
      { id: 'b', name: '资料B', category: 'world', content: '内容', size: 2, createdAt: '' }],
    steps: [{ ...step, id: 'system-start', kind: 'start' }, { ...step, id: 'parent' }, step],
    workflow: { chapterCount: 1, autoGenerate: false, outputName: '默认档案', edges: [
      { id: 'e0', source: 'system-start', target: step.id },
      { id: 'e1', source: 'parent', target: step.id },
    ] },
  };
}

test('node context summary reflects selected assets and real connected upstream nodes', () => {
  const project = projectWithSteps();
  assert.equal(nodeContextSummary(step, project).assets.length, 2);
  const scoped = nodeContextSummary({ ...step, assetIds: ['b'] }, project);
  assert.deepEqual(scoped.assets.map((asset) => asset.id), ['b']);
  assert.deepEqual(scoped.upstream.map((node) => node.id), ['parent']);
  project.steps.splice(1, 0, { ...step, id: 'ancestor', title: '前置解析' });
  project.workflow!.edges.push({ id: 'e2', source: 'ancestor', target: 'parent' });
  assert.deepEqual(nodeContextSummary(step, project).upstream.map((node) => node.id), ['ancestor', 'parent']);
  project.workflow!.edges.push({ id: 'e3', source: 'parent', target: 'ancestor' });
  assert.deepEqual(nodeContextSummary(step, project).upstream.map((node) => node.id), ['ancestor', 'parent']);
});

test('undo graph snapshots retain every editable character, reuse and output naming setting', () => {
  const project = projectWithSteps();
  Object.assign(project.steps[2], {
    outputName: '档案', characterName: '林川', characterGender: '男', characterPersonality: '谨慎',
    characterExperience: '边境行医', characterCount: 3, characterTemplate: '# 档案', reusePreviousOutput: true,
  });
  const snapshot = graphSnapshot(project);
  assert.equal(snapshot.workflow.outputName, '默认档案');
  for (const key of ['outputName', 'characterName', 'characterGender', 'characterPersonality',
    'characterExperience', 'characterCount', 'characterTemplate', 'reusePreviousOutput'] as const) {
    assert.equal(snapshot.steps[2][key], project.steps[2][key], key);
  }
  project.steps[2].characterName = '改名';
  assert.equal(snapshot.steps[2].characterName, '林川');
});
