import assert from 'node:assert/strict';
import test from 'node:test';
import { NODE_PRESETS } from '../../../../../shared/node-presets.js';
import { createTranslator } from '../../locals/core.js';
import { featuresEn, featuresZhCN } from '../../locals/features.js';
import { presetDisplayLabel } from './nodeCatalog.js';

test('built-in preset display translates at call time without modifying author data or prompts', () => {
  const preset = { ...NODE_PRESETS.writer };
  const en = createTranslator('en');
  const zh = createTranslator('zh-CN');
  const labelEn = (key: string) => en(key as keyof typeof featuresZhCN);
  const labelZh = (key: string) => zh(key as keyof typeof featuresZhCN);
  assert.equal(presetDisplayLabel('writer', 'title', preset.title, labelEn), en('正文生成'));
  assert.equal(presetDisplayLabel('writer', 'title', preset.title, labelZh), preset.title);
  assert.equal(presetDisplayLabel('writer', 'title', '我的正文节点', labelEn), '我的正文节点');
  assert.equal(presetDisplayLabel('extension', 'title', preset.title, labelEn), preset.title);
  assert.deepEqual(preset, NODE_PRESETS.writer);
});

test('feature dictionaries have matching nonempty values and interpolation placeholders', () => {
  assert.deepEqual(Object.keys(featuresEn).sort(), Object.keys(featuresZhCN).sort());
  for (const key of Object.keys(featuresZhCN) as (keyof typeof featuresZhCN)[]) {
    assert.ok(featuresEn[key].trim(), key);
    const placeholders = (value: string) => [...value.matchAll(/\{([a-zA-Z_][\w]*)\}/g)].map(match => match[1]).sort();
    assert.deepEqual(placeholders(featuresEn[key]), placeholders(featuresZhCN[key]), key);
  }
});
