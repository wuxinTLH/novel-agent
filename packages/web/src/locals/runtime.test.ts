import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeEn, runtimeZhCN } from './runtime';
import { createTranslator } from './core';
import { platformSystemText } from '../hooks/platforms/localizedPlatformText';
import { runtimeT } from './runtimeTranslate';
import { setLocale } from './store';
import { nodeModelSummary } from '../hooks/workflow/nodeConfiguration';
import { decodeChapterFile } from '../hooks/chapters/manualChapter';
import type { ModelSettings, Step } from '../../../../shared/types';

test('retained orphan unknown guard uses localized system copy without changing unknown user text', () => {
  const message = '此账号作品有已删除作品保留的未知平台记录，禁止新增远端写入。';
  assert.equal(platformSystemText(createTranslator('en'), message, 'PLATFORM_ORPHAN_UNKNOWN'), 'Unknown platform records retained from a deleted project exist for this account and work. New remote writes are blocked.');
  assert.equal(platformSystemText(createTranslator('zh-CN'), message, 'PLATFORM_ORPHAN_UNKNOWN'), message);
  assert.equal(platformSystemText(createTranslator('en'), 'My project title'), 'My project title');
});

test('runtime dictionaries preserve source keys, CJK-free English, and ordered placeholders', () => {
  assert.deepEqual(Object.keys(runtimeEn), Object.keys(runtimeZhCN));
  for (const key of Object.keys(runtimeZhCN) as Array<keyof typeof runtimeZhCN>) {
    assert.equal(runtimeZhCN[key], key);
    assert.ok(!/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u.test(runtimeEn[key]), key);
    const slots = (text: string) => (text.match(/\{x\d+\}/g) || []).sort();
    assert.deepEqual(slots(runtimeEn[key]), slots(key), key);
  }
});

test('runtime errors resolve the current locale while legacy node summaries remain Chinese', () => {
  try {
    setLocale('en');
    assert.throws(() => decodeChapterFile(new ArrayBuffer(0), 'utf-8'), /Manuscript text must not be empty/);
    assert.equal(runtimeT('已绑定 · {x0} · {x1}', { x0: 'My work', x1: 'remote-1' }), 'Bound · My work · remote-1');
    const step = { modelId: 'deleted' } as Step;
    const settings = { models: [], mode: 'demo' } as unknown as ModelSettings;
    assert.equal(nodeModelSummary(step, settings).label, '指定模型已删除');
    assert.equal(nodeModelSummary(step, settings, runtimeT as Parameters<typeof nodeModelSummary>[2]).label, 'Assigned model deleted');
    setLocale('zh-CN');
    assert.throws(() => decodeChapterFile(new ArrayBuffer(0), 'utf-8'), /文件正文不能为空/);
  } finally {
    setLocale('zh-CN');
  }
});
