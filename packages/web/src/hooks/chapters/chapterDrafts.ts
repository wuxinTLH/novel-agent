import type { ChapterEditorState } from './useChapterEditor';

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export function chapterDraftKey(actor: string, projectId: string, workflowId: string, chapterId: string) {
  return `chapter-draft:v1:${JSON.stringify([actor, projectId, workflowId, chapterId])}`;
}
function validDraft(value: unknown): value is ChapterEditorState {
  if (!value || typeof value !== 'object') return false;
  const draft = value as ChapterEditorState;
  return ['identity', 'chapterId', 'title', 'content', 'savedTitle', 'savedContent'].every(
    (field) => typeof draft[field as keyof ChapterEditorState] === 'string',
  ) && Number.isInteger(draft.baseRevision) && draft.baseRevision >= 1
    && Number.isInteger(draft.editVersion) && draft.editVersion >= 0
    && Number.isInteger(draft.selectionVersion) && draft.selectionVersion >= 0;
}

/** Memory remains authoritative if storage is denied/full, including failed removals. */
export class ChapterDraftStore {
  private memory = new Map<string, ChapterEditorState | null>();
  failed = false;
  constructor(private storage: () => DraftStorage) {}
  read(key: string): ChapterEditorState | undefined {
    if (this.memory.has(key)) return this.memory.get(key) || undefined;
    try {
      const text = this.storage().getItem(key);
      const value: unknown = text ? JSON.parse(text) : null;
      if (validDraft(value)) {
        this.memory.set(key, value);
        return value;
      }
    } catch { this.failed = true; }
    return undefined;
  }
  write(key: string, draft: ChapterEditorState) {
    this.memory.set(key, { ...draft });
    try { this.storage().setItem(key, JSON.stringify(draft)); }
    catch { this.failed = true; }
  }
  remove(key: string) {
    this.memory.set(key, null);
    try { this.storage().removeItem(key); }
    catch { this.failed = true; }
  }
}
