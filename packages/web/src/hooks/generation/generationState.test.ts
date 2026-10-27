import assert from 'node:assert/strict';
import test from 'node:test';
import { previousOutputControl } from './generationState.js';

test('stale checked reuse can be disabled after an edit clears the previous output', () => {
  const stale = { reusePreviousOutput: true, output: ' \n ' };
  const state = previousOutputControl(stale, false);
  assert.equal(state.checked, true);
  assert.equal(state.disabled, false);
  assert.match(state.hint, /取消勾选/);
  const cleared = previousOutputControl({ ...stale, reusePreviousOutput: false }, false);
  assert.equal(cleared.checked, false);
  assert.equal(cleared.disabled, true);
});

test('reuse stays selectable with output, unavailable without output, and locked during mutations', () => {
  for (const reusePreviousOutput of [false, true]) {
    assert.equal(previousOutputControl({ reusePreviousOutput, output: '解析结果' }, false).disabled, false);
    for (const output of ['', '解析结果']) {
      assert.equal(previousOutputControl({ reusePreviousOutput, output }, true).disabled, true);
    }
  }
  assert.equal(previousOutputControl({ output: '' }, false).disabled, true);
});
