import assert from 'node:assert/strict';
import test from 'node:test';
import { platformFromPath, platformPath } from './platformNavigation';

test('platform overview stays at level one and each known platform has its own level-two URL', () => {
  assert.equal(platformFromPath('/platforms'), null);
  for (const id of ['tomato', 'mock', 'qidian', 'qimao'] as const) {
    assert.equal(platformFromPath(platformPath(id)), id);
  }
});

test('unknown or deeper platform paths cannot select a different platform', () => {
  for (const pathname of ['/platforms/unknown', '/platforms/tomato/books', '/platforms/mock/', '/platforms/tomato%2Fmock', '/chapters']) {
    assert.equal(platformFromPath(pathname), null);
  }
});
