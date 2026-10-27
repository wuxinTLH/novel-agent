import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlatformWork, ProjectPlatformWorkLink } from '../../shared/platforms';
import { platformWorkChoices } from './platformWorkChoices';

const work = (id: string): PlatformWork => ({
  id, providerId: 'tomato', title: `作品 ${id}`, description: '', genre: '',
  revision: '1', chapterCount: 0, updatedAt: '',
});
const link = (id: string, remoteWorkId: string, connectionId = 'account'): ProjectPlatformWorkLink => ({
  id, connectionId, remoteWorkId, providerId: 'tomato', projectId: 'project',
  accountId: 'author', title: `作品 ${remoteWorkId}`, revision: '1', lastSyncedAt: '',
});

test('read-only remote works appear in work selection without becoming bindings', () => {
  assert.deepEqual(platformWorkChoices('account', [work('remote')], []), [
    { value: 'work:remote', label: '未绑定 · 作品 remote · remote' },
  ]);
});

test('bound works appear once and remain selectable even without a fresh remote read', () => {
  assert.deepEqual(platformWorkChoices('account', [work('remote'), work('new')], [
    link('binding', 'remote'), link('foreign', 'other', 'another-account'),
  ]), [
    { value: 'link:binding', label: '已绑定 · 作品 remote · remote' },
    { value: 'work:new', label: '未绑定 · 作品 new · new' },
  ]);
  assert.deepEqual(platformWorkChoices('account', [], [link('binding', 'remote')]), [
    { value: 'link:binding', label: '已绑定 · 作品 remote · remote' },
  ]);
  assert.deepEqual(platformWorkChoices('', [work('remote')], [link('binding', 'remote')]), []);
});
