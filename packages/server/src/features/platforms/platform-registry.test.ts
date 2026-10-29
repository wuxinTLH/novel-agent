import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlatformRegistry } from './platform-registry.js';
import type { DraftBrowserAdapter } from './platforms-types.js';
test('unverified official integrations stay unavailable and return concrete onboarding requirements', async () => {
  const registry = createPlatformRegistry(undefined, { readiness: 'unavailable', reason: 'No browser available' } as DraftBrowserAdapter);
  for (const id of ['qidian', 'qimao']) {
    const adapter = registry.get(id);
    assert.equal(adapter.provider.available, false);
    assert.equal(adapter.provider.readiness, 'unavailable');
    assert.deepEqual(adapter.provider.authMethods, []);
    assert.equal(Object.values(adapter.provider.capabilities).some(Boolean), false);
    await assert.rejects(adapter.connect({ token: 'placeholder' }), error => {
      assert.ok(error instanceof Error); assert.match(error.message, /应用资质/); assert.match(error.message, /回执规范/); return true;
    });
  }
  const tomato = registry.get('tomato').provider;
  assert.equal(tomato.capabilities.extensionPairing, true);
  for (const capability of ['manualLogin', 'listWorks', 'getWork', 'saveDraft', 'publishChapter'] as const) assert.equal(tomato.capabilities[capability], false);
});
test('browser draft support never advertises formal publication and describes separate review semantics', () => {
  const tomato = createPlatformRegistry(undefined, { readiness: 'ready', reason: 'Offline fixture' } as DraftBrowserAdapter).get('tomato').provider;
  assert.equal(tomato.capabilities.saveDraft, true);
  assert.equal(tomato.capabilities.publishChapter, false);
  assert.match(tomato.description, /save_draft.*submit_review/);
  assert.match(tomato.readinessReason!, /配对不验证账号/);
});
