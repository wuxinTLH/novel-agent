import assert from 'node:assert/strict';
import test from 'node:test';
import { accessiblePlatformStep, platformStepAccess } from './platformSteps';

test('manual steps unlock in order and never infer approval from selection', () => {
  const empty = platformStepAccess({ connected: false, workBound: false, previewReady: false });
  assert.deepEqual(empty, { account: true, work: false, setup: false, review: false, results: true });
  assert.equal(accessiblePlatformStep('review', empty), 'account');
  const signedIn = platformStepAccess({ connected: true, workBound: false, previewReady: true });
  assert.equal(signedIn.work, true);
  assert.equal(signedIn.setup, false);
  assert.equal(signedIn.review, false);
  const bound = platformStepAccess({ connected: true, workBound: true, previewReady: false });
  assert.equal(bound.setup, true);
  assert.equal(bound.review, false);
  assert.equal(platformStepAccess({ connected: true, workBound: true, previewReady: true }).review, true);
});

test('results remain available when credentials expire or a previous upload is unknown', () => {
  const access = platformStepAccess({ connected: false, workBound: false, previewReady: false });
  assert.equal(accessiblePlatformStep('results', access), 'results');
});
