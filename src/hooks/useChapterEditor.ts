import { useCallback, useEffect, useRef, useState } from 'react';
import type { Chapter, Project } from '../../shared/types';
import { projectIdentity, sortedChapters } from './generationState';

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
  const update = useCallback((fn: (value: ChapterEditorState) => ChapterEditorState) => {
    const next = fn(stateRef.current);
    stateRef.current = next;
    setState(next);
  }, []);
  const identity = project ? projectIdentity(project) : '';
  useEffect(() => {
    update((current) => reconcileChapterEditor(current, identity, project?.chapters || [], active));
  }, [identity, project?.chapters, active, update]);
  const selectChapter = (chapter: Chapter) =>
    update((current) => editorForChapter(identity, chapter, current.selectionVersion + 1));
  const resetEditor = (chapters?: Chapter[]) =>
    update((current) => {
      const empty = emptyEditor(identity, current.selectionVersion + 1);
      return chapters ? reconcileChapterEditor(empty, identity, chapters, true) : empty;
    });
  const changeEditor = (field: 'title' | 'content', value: string) =>
    update((current) => ({ ...current, [field]: value, editVersion: current.editVersion + 1 }));
  const acknowledgeSave = (submitted: ChapterEditorState, chapter: Chapter) =>
    update((current) => acknowledgeChapterSave(current, submitted, chapter));
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
  };
}
