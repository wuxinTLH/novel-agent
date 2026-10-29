import test from 'node:test';
import assert from 'node:assert/strict';
import { ChapterDraftStore, chapterDraftKey } from './chapterDrafts';
import { acknowledgeChapterSave, editorForChapter, editorDirty, reconcileChapterEditor } from './useChapterEditor';
import type { Chapter } from '../../../../../shared/types';

const chapter: Chapter = { id: 'same-chapter', number: 1, title: '正式', content: '正式正文', revision: 1, updatedAt: 'now', mode: 'live' };
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
test('durable drafts are isolated by account, project, workflow and chapter, and survive reload', () => {
  const disk = storage();
  const store = new ChapterDraftStore(() => disk);
  const key = chapterDraftKey('alice', 'project-a', 'workflow-a', chapter.id);
  const draft = { ...editorForChapter('project-a/workflow-a', chapter, 1), content: '本地草稿' };
  store.write(key, draft);
  const reloaded = new ChapterDraftStore(() => disk);
  assert.deepEqual(reloaded.read(key), draft);
  for (const args of [
    ['bob', 'project-a', 'workflow-a', chapter.id],
    ['alice', 'project-b', 'workflow-a', chapter.id],
    ['alice', 'project-a', 'workflow-b', chapter.id],
    ['alice', 'project-a', 'workflow-a', 'other-chapter'],
  ]) assert.equal(reloaded.read(chapterDraftKey(args[0], args[1], args[2], args[3])), undefined);
});
test('malformed stored data is ignored without blocking chapter editing', () => {
  const disk = storage();
  const store = new ChapterDraftStore(() => disk);
  disk.setItem('truncated', '{');
  disk.setItem('invalid', JSON.stringify({ chapterId: chapter.id, content: 'partial' }));
  assert.equal(store.read('truncated'), undefined);
  assert.equal(store.read('invalid'), undefined);
  const draft = { ...editorForChapter('p/w', chapter, 1), content: '继续编辑' };
  store.write('truncated', draft);
  assert.deepEqual(store.read('truncated'), draft);
});
test('quota and denied storage preserve drafts in memory and failed removal cannot resurrect them', () => {
  const store = new ChapterDraftStore(() => { throw new Error('storage denied'); });
  const draft = { ...editorForChapter('p/w', chapter, 1), content: '不能丢失' };
  assert.doesNotThrow(() => store.write('key', draft));
  assert.equal(store.failed, true);
  assert.deepEqual(store.read('key'), draft);
  store.remove('key');
  assert.equal(store.read('key'), undefined);
});
test('saving acknowledges submitted baseline while newer typing stays durable and conflicts remain explicit', () => {
  const store = new ChapterDraftStore(() => storage());
  const submitted = { ...editorForChapter('p/w', chapter, 1), content: '提交正文', editVersion: 1 };
  const typing = { ...submitted, content: '保存期间的新输入', editVersion: 2 };
  const saved = { ...chapter, revision: 2, content: submitted.content };
  const acknowledged = acknowledgeChapterSave(typing, submitted, saved);
  store.write('key', acknowledged);
  assert.equal(store.read('key')?.content, '保存期间的新输入');
  assert.equal(acknowledged.baseRevision, 2);
  assert.equal(acknowledged.savedContent, '提交正文');
  assert.equal(editorDirty(acknowledged), true);
  const newer = { ...saved, revision: 3, content: '别处修改' };
  assert.deepEqual(reconcileChapterEditor(acknowledged, 'p/w', [newer], true), acknowledged);
  assert.equal(acknowledged.baseRevision, 2);
  assert.equal(acknowledgeChapterSave({ ...typing, identity: 'other/w' }, submitted, saved).identity, 'other/w');
  const clean = acknowledgeChapterSave(submitted, submitted, saved);
  assert.equal(editorDirty(clean), false);
  assert.equal(clean.content, '提交正文');
  const switched = { ...typing, selectionVersion: 2 };
  assert.deepEqual(acknowledgeChapterSave(switched, submitted, saved), switched);
});
