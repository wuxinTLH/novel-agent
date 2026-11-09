import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicationDeletionBlockers } from '../../../../../shared/publication';
import { deletionCancellationBody, deletionPreservingRecordsBody } from './ProjectDeletionBlockers';

test('preserving records allows unknown results only with explicit opt-in and fresh server permission', () => {
  const diagnostic: PublicationDeletionBlockers = {
    removable: false, busy: false, canDeletePreservingRecords: true,
    batches: [{ id: 'unknown', state: 'unknown', approvalHash: 'a'.repeat(64), canCancel: false,
      items: [{ number: 7, state: 'unknown', mutationStarted: true, hasRemoteDraftId: false }] }],
    legacyOperations: [],
  };
  assert.deepEqual(deletionPreservingRecordsBody(diagnostic, true), { confirmed: true, preservePlatformRecords: true });
  assert.equal(deletionPreservingRecordsBody(diagnostic), undefined);
  assert.equal(deletionPreservingRecordsBody(diagnostic, false), undefined);
  assert.equal(deletionPreservingRecordsBody(undefined, true), undefined);
  assert.equal(deletionPreservingRecordsBody({ ...diagnostic, canDeletePreservingRecords: undefined }, true), undefined);
  assert.equal(deletionPreservingRecordsBody({ ...diagnostic, busy: true }, true), undefined);
  assert.equal(deletionCancellationBody(diagnostic.batches[0]), undefined);
});

const fixture = (): PublicationDeletionBlockers['batches'][number] => ({
  id: 'batch', state: 'paused', approvalHash: 'a'.repeat(64), canCancel: true,
  items: [{ number: 7, state: 'queued', mutationStarted: false, hasRemoteDraftId: false }],
});

test('safe cancellation binds explicit confirmation to the immutable server preview hash', () => {
  const batch = fixture();
  assert.deepEqual(deletionCancellationBody(batch), { confirmed: true, approvalHash: batch.approvalHash });
  batch.canCancel = false;
  assert.equal(deletionCancellationBody(batch), undefined);
});

test('unknown, remote IDs, mutation and verified outcomes never expose cancellation', () => {
  for (const state of ['unknown', 'cancelled'] as const) {
    assert.equal(deletionCancellationBody({ ...fixture(), state }), undefined);
  }
  for (const state of ['unknown', 'draft_verified', 'submitted'] as const) {
    const batch = fixture();
    batch.items[0].state = state;
    assert.equal(deletionCancellationBody(batch), undefined);
  }
  for (const property of ['mutationStarted', 'hasRemoteDraftId'] as const) {
    const batch = fixture();
    batch.items[0][property] = true;
    assert.equal(deletionCancellationBody(batch), undefined);
  }
});

test('missing or malformed approval hashes fail closed rather than inventing approval', () => {
  for (const approvalHash of ['', 'old-hash', 'z'.repeat(64)]) {
    assert.equal(deletionCancellationBody({ ...fixture(), approvalHash }), undefined);
  }
});
