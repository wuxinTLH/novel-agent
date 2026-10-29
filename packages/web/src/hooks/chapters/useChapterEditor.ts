import { useCallback, useEffect, useRef, useState } from 'react';
import type { Chapter, Project } from '../../../../../shared/types';
import { projectIdentity, sortedChapters, workflowIdOf } from '../generation/generationState';
import { api } from '../../services/api';
import type { AuthStatus } from '../../../../../shared/auth';
import { ChapterDraftStore, chapterDraftKey } from './chapterDrafts';

export type ChapterEditorState = {
  identity: string;
  chapterId: string;
  baseRevision: number;
  selectionVersion: number;
  editVersion: number;
  title: string;
  content: string;
  savedTitle: string;
  savedContent: string;
};
export function emptyEditor(identity = '', selectionVersion = 0): ChapterEditorState {
  return {
    identity,
    chapterId: '',
    baseRevision: 0,
    selectionVersion,
    editVersion: 0,
    title: '',
    content: '',
    savedTitle: '',
    savedContent: '',
  };
}
export function editorForChapter(
  identity: string,
  chapter: Chapter,
  selectionVersion: number,
): ChapterEditorState {
  return {
    identity,
    chapterId: chapter.id,
    baseRevision: chapter.revision,
    selectionVersion,
    editVersion: 0,
    title: chapter.title,
    content: chapter.content,
    savedTitle: chapter.title,
    savedContent: chapter.content,
  };
}
export function editorDirty(state: ChapterEditorState) {
  return state.title !== state.savedTitle || state.content !== state.savedContent;
}
/** A save may advance the baseline, but must never replace later typing or a different selection. */
export function acknowledgeChapterSave(
  current: ChapterEditorState,
  submitted: ChapterEditorState,
  saved: Chapter,
): ChapterEditorState {
  if (
    current.identity !== submitted.identity ||
    current.chapterId !== submitted.chapterId ||
    current.selectionVersion !== submitted.selectionVersion ||
    saved.id !== submitted.chapterId ||
    current.baseRevision !== submitted.baseRevision ||
    saved.revision <= submitted.baseRevision
  )
    return current;
  const editedWhileSaving = current.editVersion !== submitted.editVersion;
  return {
    ...current,
    baseRevision: saved.revision,
    savedTitle: saved.title,
    savedContent: saved.content,
    title: editedWhileSaving ? current.title : saved.title,
    content: editedWhileSaving ? current.content : saved.content,
  };
}
/** Polls refresh a clean editor only; dirty drafts keep their original concurrency baseline. */
export function reconcileChapterEditor(
  current: ChapterEditorState,
  identity: string,
  chapters: Chapter[],
  active: boolean,
) {
  if (current.identity !== identity) current = emptyEditor(identity, current.selectionVersion + 1);
  if (!active) return current;
  const chapter = chapters.find((item) => item.id === current.chapterId);
  if (!chapter) {
    if (editorDirty(current)) return current;
    const latest = sortedChapters(chapters).at(-1);
    return latest
      ? editorForChapter(identity, latest, current.selectionVersion + 1)
      : current.chapterId
        ? emptyEditor(identity, current.selectionVersion + 1)
        : current;
  }
  if (!editorDirty(current) && chapter.revision > current.baseRevision) {
    return editorForChapter(identity, chapter, current.selectionVersion);
  }
  return current;
}
export function useChapterEditor(project: Project | null, active: boolean) {
  const [state, setState] = useState(() => emptyEditor());
  const stateRef = useRef(state);
  const [actor, setActor] = useState<string | null>(null);
  const actorRef = useRef<string | null>(null);
  const draftStore = useRef(new ChapterDraftStore(() => window.localStorage));
  const scopes = useRef(new Map<string, [string, string]>());
  const pendingDrafts = useRef(new Map<string, ChapterEditorState>());
  const identity = project ? projectIdentity(project) : '';
  if (project) scopes.current.set(identity, [project.id, workflowIdOf(project)]);
  const draftKey = (value: ChapterEditorState) => {
    const scope = scopes.current.get(value.identity);
    return actorRef.current && scope && value.chapterId
      ? chapterDraftKey(actorRef.current, scope[0], scope[1], value.chapterId) : undefined;
  };
  const persist = (value: ChapterEditorState) => {
    const key = draftKey(value);
    if (!key) {
      if (value.chapterId) pendingDrafts.current.set(JSON.stringify([value.identity, value.chapterId]), { ...value });
      return;
    }
    if (editorDirty(value)) draftStore.current.write(key, value);
    else draftStore.current.remove(key);
  };
  const recover = (value: ChapterEditorState) => {
    const key = draftKey(value);
    const draft = key ? draftStore.current.read(key)
      : pendingDrafts.current.get(JSON.stringify([value.identity, value.chapterId]));
    return draft && draft.identity === value.identity && draft.chapterId === value.chapterId
      ? { ...draft, selectionVersion: value.selectionVersion, editVersion: 0 } : value;
  };
  const update = useCallback((fn: (value: ChapterEditorState) => ChapterEditorState, keepPrevious = true) => {
    const previous = stateRef.current;
    const next = fn(previous);
    // Persist before selection changes so storage failure never drops the in-memory copy.
    if (keepPrevious && (previous.identity !== next.identity || previous.chapterId !== next.chapterId)) persist(previous);
    persist(next);
    stateRef.current = next;
    setState(next);
  }, []);
  useEffect(() => {
    let disposed = false;
    void api<AuthStatus>('/auth/session').then((session) => {
      if (disposed) return;
      const value = !session.enabled ? 'auth-disabled' : session.authenticated ? session.user?.id : undefined;
      if (value) {
        actorRef.current = value;
        for (const draft of pendingDrafts.current.values()) if (editorDirty(draft)) persist(draft);
        pendingDrafts.current.clear();
        setActor(value);
      }
    }).catch(() => { /* Editing remains available; do not guess an account storage scope. */ });
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    update((current) => {
      const next = reconcileChapterEditor(current, identity, project?.chapters || [], active);
      return !editorDirty(next) ? recover(next) : next;
    });
  }, [identity, project?.chapters, active, actor, update]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      persist(stateRef.current);
      if (editorDirty(stateRef.current)) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  const selectChapter = (chapter: Chapter) =>
    update((current) => recover(editorForChapter(identity, chapter, current.selectionVersion + 1)));
  const discardDraft = () => {
    const key = draftKey(stateRef.current);
    if (key) draftStore.current.remove(key);
    update((current) => {
      const chapter = project?.chapters.find((item) => item.id === current.chapterId);
      return chapter ? editorForChapter(identity, chapter, current.selectionVersion + 1)
        : emptyEditor(identity, current.selectionVersion + 1);
    }, false);
  };
  const resetEditor = (chapters?: Chapter[]) =>
    update((current) => {
      const empty = emptyEditor(identity, current.selectionVersion + 1);
      return chapters ? recover(reconcileChapterEditor(empty, identity, chapters, true)) : empty;
    });
  const changeEditor = (field: 'title' | 'content', value: string) =>
    update((current) => ({ ...current, [field]: value, editVersion: current.editVersion + 1 }));
  const acknowledgeSave = (submitted: ChapterEditorState, chapter: Chapter) => {
    const key = draftKey(submitted);
    const stored = key ? draftStore.current.read(key)
      : pendingDrafts.current.get(JSON.stringify([submitted.identity, submitted.chapterId]));
    if (stored) persist(acknowledgeChapterSave(stored, submitted, chapter));
    update((current) => acknowledgeChapterSave(current, submitted, chapter));
  };
  const currentChapter = project?.chapters.find((chapter) => chapter.id === state.chapterId);
  const conflict =
    state.chapterId !== '' && (!currentChapter || currentChapter.revision !== state.baseRevision);
  return {
    state,
    stateRef,
    chapterId: state.chapterId,
    editor: { title: state.title, content: state.content },
    dirty: editorDirty(state),
    conflict,
    currentChapter,
    selectChapter,
    resetEditor,
    changeEditor,
    acknowledgeSave,
    discardDraft,
    draftWarning: draftStore.current.failed
      ? '浏览器草稿存储不可用，文字仍保留在本次会话中；离开前请保存或导出。'
      : !actor ? '正在确认草稿身份；请在离开前保存或导出。' : '',
  };
}
