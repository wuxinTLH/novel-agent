import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { NODE_PRESETS } from '../../../../../shared/node-presets.js';
import { translate } from '../../locals/core.js';
import AddNodeDialog, { applyNodePreset, runNodeConfirmation } from './AddNodeDialog.js';
import { nodeCatalog } from './nodeCatalog.js';

test('confirmation locks synchronously, ignores duplicate requests and applies only after approval', async () => {
  const gate = { current: false };
  const states: boolean[] = [];
  let approve!: (value: boolean) => void;
  let applied = 0;
  const pending = runNodeConfirmation(
    gate,
    () =>
      new Promise<boolean>((resolve) => {
        approve = resolve;
      }),
    () => applied++,
    (value) => states.push(value),
  );
  assert.equal(gate.current, true);
  await runNodeConfirmation(
    gate,
    async () => {
      throw new Error('duplicate confirmation');
    },
    () => applied++,
    () => {},
  );
  assert.equal(applied, 0);
  approve(true);
  await pending;
  assert.equal(applied, 1);
  assert.equal(gate.current, false);
  assert.deepEqual(states, [true, false]);
});

test('cancelled and failed confirmations release the gate without applying a preset', async () => {
  const gate = { current: false };
  let applied = false;
  await runNodeConfirmation(
    gate,
    async () => false,
    () => {
      applied = true;
    },
    () => {},
  );
  await assert.rejects(
    runNodeConfirmation(
      gate,
      async () => {
        throw new Error('failed');
      },
      () => {
        applied = true;
      },
      () => {},
    ),
    /failed/,
  );
  assert.equal(applied, false);
  assert.equal(gate.current, false);
});

test('catalog covers each preset once and preserves unknown extension nodes', () => {
  const kinds = nodeCatalog({ ...NODE_PRESETS, plugin: { title: '扩展', subtitle: '插件' } }).flatMap(
    (category) => category.groups.flatMap((group) => group.kinds),
  );
  assert.equal(new Set(kinds).size, kinds.length);
  assert.deepEqual([...kinds].sort(), [...Object.keys(NODE_PRESETS), 'plugin'].sort());
});

test('catalog filters localized labels, categories and empty results without losing selected fields', () => {
  assert.equal(nodeCatalog(NODE_PRESETS, '不存在的分类').length, 0);
  assert.deepEqual(
    nodeCatalog(NODE_PRESETS, '  twist  ').flatMap((category) =>
      category.groups.flatMap((group) => group.kinds),
    ),
    ['twist'],
  );
  assert.deepEqual(
    nodeCatalog(NODE_PRESETS, 'suspense', (text) => (text === '悬念与回收' ? 'Suspense & payoff' : text))[0]
      .groups[0].kinds,
    ['foreshadow', 'twist'],
  );
});

test('node picker offers accessible view controls, search and collapsed optional guidance', () => {
  const html = renderToStaticMarkup(
    createElement(AddNodeDialog, { presets: NODE_PRESETS, busy: false, onClose() {}, async onAdd() {} }),
  );
  for (const label of ['列表展示', '网格展示', '分级菜单展示', '搜索节点'])
    assert.ok(html.includes(`aria-label="${label}"`));
  assert.ok(html.includes('<details>'));
  assert.ok(html.includes('role="status"'));
});

test('plot presets appear as real node choices with the optional order and cost guidance', () => {
  const html = renderToStaticMarkup(
    createElement(AddNodeDialog, {
      presets: NODE_PRESETS,
      busy: false,
      onClose() {},
      async onAdd() {},
    }),
  );
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
    assert.deepEqual(
      applyNodePreset(saved, NODE_PRESETS[kind], {
        title: true,
        subtitle: true,
        prompt: true,
      }),
      saved,
    );
    assert.deepEqual(applyNodePreset(saved, NODE_PRESETS[kind], {}), NODE_PRESETS[kind]);
  }
});
