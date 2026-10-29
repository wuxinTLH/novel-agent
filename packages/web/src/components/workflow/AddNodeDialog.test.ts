import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { NODE_PRESETS } from '../../../../../shared/node-presets.js';
import { translate } from '../../locals/core.js';
import AddNodeDialog, { applyNodePreset } from './AddNodeDialog.js';

test('plot presets appear as real node choices with the optional order and cost guidance', () => {
  const html = renderToStaticMarkup(createElement(AddNodeDialog, {
    presets: NODE_PRESETS, busy: false, onClose() {}, async onAdd() {},
  }));
  for (const kind of ['conflict', 'foreshadow', 'twist', 'climax']) {
    assert.ok(html.includes(`value="${kind}"`));
    assert.ok(html.includes(NODE_PRESETS[kind].title));
    assert.notEqual(translate('en', NODE_PRESETS[kind].title), NODE_PRESETS[kind].title);
    assert.notEqual(translate('en', NODE_PRESETS[kind].subtitle), NODE_PRESETS[kind].subtitle);
  }
  assert.ok(html.includes('默认章节顺序'));
  assert.ok(html.includes('不必全部添加或每章运行'));
  assert.ok(html.includes('每个运行节点会增加模型调用'));
});

test('switching plot presets preserves all fields already edited by the author', () => {
  const saved = { title: '我的节点', subtitle: '我的说明', prompt: '我的提示词' };
  for (const kind of ['conflict', 'foreshadow', 'twist', 'climax']) {
    assert.deepEqual(applyNodePreset(saved, NODE_PRESETS[kind], {
      title: true, subtitle: true, prompt: true,
    }), saved);
    assert.deepEqual(applyNodePreset(saved, NODE_PRESETS[kind], {}), NODE_PRESETS[kind]);
  }
});
