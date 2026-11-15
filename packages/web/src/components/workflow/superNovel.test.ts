import test from 'node:test';
import assert from 'node:assert/strict';
import { NODE_PRESETS } from '../../../../../shared/node-presets.js';
import { WORKFLOW_PRESETS, SUPER_NOVEL_STAGES, isLocalWorkflowStep } from '../../../../../shared/workflow-templates.js';
import { translate } from '../../locals/core.js';
import { superNovelEn, superNovelZhCN } from '../../locals/super-novel.js';
import { nodeCatalog, presetDisplayLabel } from './nodeCatalog.js';

test('super novel is opt-in and local stages are discoverable in both locales without mutating presets', () => {
  assert.equal(WORKFLOW_PRESETS[0], 'chapter'); assert.ok(WORKFLOW_PRESETS.includes('super-novel'));
  const before = structuredClone(NODE_PRESETS);
  for (const { kind } of SUPER_NOVEL_STAGES.filter(isLocalWorkflowStep)) {
    for (const locale of ['zh-CN', 'en']) {
      const label = (key: string) => translate(locale, key);
      const localized = presetDisplayLabel(kind, 'title', NODE_PRESETS[kind].title, label);
      assert.ok(localized.trim());
      const choices = nodeCatalog(NODE_PRESETS, localized, label).flatMap(c => c.groups.flatMap(g => g.kinds));
      assert.ok(choices.includes(kind));
    }
    assert.equal(presetDisplayLabel(kind, 'title', '作者命名', key => translate('en', key)), '作者命名');
  }
  assert.deepEqual(NODE_PRESETS, before);
});

test('super novel guidance has bilingual key parity and discloses local/model cost boundaries', () => {
  assert.deepEqual(Object.keys(superNovelEn).sort(), Object.keys(superNovelZhCN).sort());
  for (const [key, english] of Object.entries(superNovelEn)) {
    assert.equal(translate('en', key), english); assert.equal(translate('zh-CN', key), key);
  }
  assert.ok(Object.values(superNovelEn).some(value => value.includes('six nodes call models')));
  assert.ok(Object.values(superNovelEn).some(value => value.includes('No automatic publishing')));
});
