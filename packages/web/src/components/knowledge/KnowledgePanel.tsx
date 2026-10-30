import { useEffect, useRef, useState } from 'react';
import { BookOpen, FileText, LoaderCircle, Plus, Search, Tags, Trash2 } from 'lucide-react';
import { api } from '../../services/api';
import { useConfirm } from '../common/AppDialog';
import {
  knowledgeFactTypes,
  type KnowledgeFact,
  type KnowledgeFactType,
} from '../../../../../shared/knowledge';
import type { Chapter } from '../../../../../shared/types';

type Props = {
  projectId: string;
  chapters?: Pick<Chapter, 'id' | 'title' | 'number'>[];
  onProjectUpdated?: (facts: KnowledgeFact[]) => void;
  onDirtyChange?: (dirty: boolean) => void;
};
const labels: Record<KnowledgeFactType, string> = {
  character: '人物',
  relationship: '关系',
  timeline: '时间线',
  foreshadow: '伏笔',
  fact: '事实',
};
export type KnowledgeDraft = {
  title: string;
  content: string;
  kind: KnowledgeFactType;
  tags: string;
  chapterIds: string[];
};
export function isKnowledgeDraftDirty(draft: KnowledgeDraft, editing: KnowledgeFact | null): boolean {
  return (
    draft.title !== (editing?.title ?? '') ||
    draft.content !== (editing?.content ?? '') ||
    draft.kind !== (editing?.type ?? 'fact') ||
    draft.tags !== (editing?.tags.join('，') ?? '') ||
    draft.chapterIds.length !== (editing?.chapterIds.length ?? 0) ||
    draft.chapterIds.some((id) => !editing?.chapterIds.includes(id))
  );
}

export default function KnowledgePanel({ projectId, chapters = [], onProjectUpdated, onDirtyChange }: Props) {
  const confirm = useConfirm();
  const editorTitle = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState(false);
  const confirmationLock = useRef(false);
  const [facts, setFacts] = useState<KnowledgeFact[]>([]);
  const [q, setQ] = useState(''),
    [type, setType] = useState('');
  const [title, setTitle] = useState(''),
    [content, setContent] = useState('');
  const [kind, setKind] = useState<KnowledgeFactType>('fact');
  const [tags, setTags] = useState(''),
    [chapterIds, setChapterIds] = useState<string[]>([]);
  const [editing, setEditing] = useState<KnowledgeFact | null>(null);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const currentProject = useRef(projectId);
  const projectEpoch = useRef(0);
  if (currentProject.current !== projectId) projectEpoch.current++;
  currentProject.current = projectId;
  const requestVersion = useRef(0),
    mutationLock = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const dirty = isKnowledgeDraftDirty({ title, content, kind, tags, chapterIds }, editing);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const dirtyCallback = useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;
  useEffect(() => () => dirtyCallback.current?.(false), []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const resetEditor = () => {
    setEditing(null);
    setTitle('');
    setContent('');
    setKind('fact');
    setTags('');
    setChapterIds([]);
  };
  useEffect(() => {
    resetEditor();
    setFacts([]);
    setError('');
  }, [projectId]);
  useEffect(() => {
    let active = true;
    const version = ++requestVersion.current;
    const query = new URLSearchParams({ ...(q ? { q } : {}), ...(type ? { type } : {}) });
    setLoading(true);
    setError('');
    void api<KnowledgeFact[]>(`/projects/${projectId}/knowledge${query.size ? `?${query}` : ''}`)
      .then((value) => {
        if (active && version === requestVersion.current && currentProject.current === projectId)
          setFacts(value);
      })
      .catch((e: unknown) => {
        if (active && version === requestVersion.current && currentProject.current === projectId)
          setError(e instanceof Error ? e.message : '加载失败');
      })
      .finally(() => {
        if (active && version === requestVersion.current && currentProject.current === projectId)
          setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, q, type, reload]);

  const mutate = async (operation: () => Promise<unknown>, saved = false, deletedId?: string) => {
    if (mutationLock.current) return;
    mutationLock.current = true;
    setBusy(true);
    setError('');
    const origin = projectId;
    const epoch = projectEpoch.current;
    try {
      await operation();
      if (!mounted.current || currentProject.current !== origin || projectEpoch.current !== epoch) return;
      // Invalidate any in-flight filtered read before requesting the same current filter again.
      requestVersion.current++;
      if (saved || (deletedId && editing?.id === deletedId)) resetEditor();
      setReload((value) => value + 1);
      if (onProjectUpdated) {
        const all = await api<KnowledgeFact[]>(`/projects/${origin}/knowledge`);
        if (mounted.current && currentProject.current === origin && projectEpoch.current === epoch)
          onProjectUpdated(all);
      }
    } catch (e) {
      if (mounted.current && currentProject.current === origin && projectEpoch.current === epoch)
        setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      mutationLock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const save = () => {
    if (
      busy ||
      confirming ||
      mutationLock.current ||
      confirmationLock.current ||
      !title.trim() ||
      !content.trim()
    )
      return;
    const payload = {
      type: kind,
      title: title.trim(),
      content,
      tags: [
        ...new Set(
          tags
            .split(/[,，、\n]/u)
            .map((tag) => tag.trim())
            .filter(Boolean),
        ),
      ],
      chapterIds,
      ...(editing ? { expectedRevision: editing.revision } : {}),
    };
    void mutate(
      () =>
        api(`/projects/${projectId}/knowledge${editing ? `/${editing.id}` : ''}`, {
          method: editing ? 'PATCH' : 'POST',
          body: JSON.stringify(payload),
        }),
      true,
    );
  };
  const replaceDraft = async (replace: () => void) => {
    if (busy || confirming || mutationLock.current || confirmationLock.current) return;
    const epoch = projectEpoch.current;
    confirmationLock.current = true;
    setConfirming(true);
    try {
      if (
        dirty &&
        !(await confirm('当前事实有未保存的修改，确定放弃？', {
          title: '放弃未保存修改',
          confirmText: '放弃修改',
          danger: true,
        }))
      )
        return;
      if (!mounted.current || projectEpoch.current !== epoch) return;
      replace();
      editorTitle.current?.focus();
    } finally {
      confirmationLock.current = false;
      if (mounted.current) setConfirming(false);
    }
  };
  const edit = (fact: KnowledgeFact) => {
    if (editing?.id === fact.id) return;
    void replaceDraft(() => {
      setEditing(fact);
      setKind(fact.type);
      setTitle(fact.title);
      setContent(fact.content);
      setTags(fact.tags.join('，'));
      setChapterIds([...fact.chapterIds]);
      setError('');
    });
  };
  const unavailable = busy || confirming;
  const newFact = () =>
    void replaceDraft(() => {
      resetEditor();
      setError('');
    });
  const remove = async (fact: KnowledgeFact) => {
    if (unavailable || mutationLock.current || confirmationLock.current) return;
    const origin = projectId;
    const epoch = projectEpoch.current;
    confirmationLock.current = true;
    setConfirming(true);
    try {
      const approved = await confirm(
        `确定删除「${fact.title}」？删除后该事实将不再用于创作上下文，此操作无法撤销。${editing?.id === fact.id && dirty ? '该事实未保存的修改也将丢弃。' : ''}`,
        {
          title: '删除知识事实',
          confirmText: '删除事实',
          danger: true,
        },
      );
      if (
        !approved ||
        !mounted.current ||
        currentProject.current !== origin ||
        projectEpoch.current !== epoch
      )
        return;
      await mutate(
        () =>
          api(`/projects/${origin}/knowledge/${fact.id}?expectedRevision=${fact.revision}`, {
            method: 'DELETE',
          }),
        false,
        fact.id,
      );
    } finally {
      confirmationLock.current = false;
      if (mounted.current) setConfirming(false);
    }
  };
  return (
    <section className="knowledge-panel" aria-label="知识事实管理">
      <div className="knowledge-panel__intro">
        <div>
          <span className="knowledge-panel__eyebrow">
            <BookOpen size={15} aria-hidden="true" /> STORY KNOWLEDGE
          </span>
          <h2>让每个设定，有据可循</h2>
          <p>集中整理人物、关系与关键事实，为后续创作提供一致的故事上下文。</p>
        </div>
        <button type="button" className="button secondary" disabled={unavailable} onClick={newFact}>
          <Plus size={16} aria-hidden="true" />
          新建事实
        </button>
      </div>
      <div className="knowledge-panel__toolbar" role="search" aria-label="筛选知识事实">
        <label className="knowledge-panel__search">
          <Search size={17} aria-hidden="true" />
          <input
            type="search"
            aria-label="搜索事实"
            placeholder="搜索标题、内容或标签…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <label className="knowledge-panel__filter">
          事实类型
          <select aria-label="事实类型" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">全部类型</option>
            {knowledgeFactTypes.map((item) => (
              <option key={item} value={item}>
                {labels[item]}
              </option>
            ))}
          </select>
        </label>
        {(q || type) && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setQ('');
              setType('');
            }}
          >
            清除筛选
          </button>
        )}
      </div>
      {error && (
        <div className="knowledge-panel__error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="text-button"
            disabled={unavailable || loading}
            onClick={() => setReload((value) => value + 1)}
          >
            重新加载
          </button>
        </div>
      )}
      <div className="knowledge-panel__workspace">
        <section className="knowledge-panel__library" aria-label="事实列表" aria-busy={loading}>
          <header className="knowledge-panel__section-heading">
            <h3>
              事实库 <span>{facts.length}</span>
            </h3>
            <span>{q || type ? '当前筛选结果' : '你的故事设定'}</span>
          </header>
          {loading && (
            <p className="knowledge-panel__loading" role="status">
              <LoaderCircle size={16} aria-hidden="true" />
              正在加载事实…
            </p>
          )}
          <div className="knowledge-panel__list">
            {facts.map((fact) => (
              <article
                className={`knowledge-panel__card${editing?.id === fact.id ? ' is-editing' : ''}`}
                key={fact.id}
              >
                <header>
                  <span className={`knowledge-panel__type knowledge-panel__type--${fact.type}`}>
                    {labels[fact.type]}
                  </span>
                  <small>修订 {fact.revision}</small>
                </header>
                <h4>{fact.title}</h4>
                <p className="knowledge-panel__fact-content">{fact.content}</p>
                {fact.tags.length > 0 && (
                  <div className="knowledge-panel__tags" aria-label="标签">
                    {fact.tags.map((tag) => (
                      <span key={tag}>
                        <Tags size={11} aria-hidden="true" />
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                <p className="knowledge-panel__scope">
                  <BookOpen size={13} aria-hidden="true" />
                  <span>
                    {fact.chapterIds.length
                      ? fact.chapterIds
                          .map((id) => {
                            const chapter = chapters.find((item) => item.id === id);
                            return chapter ? `第 ${chapter.number} 章 · ${chapter.title}` : '章节已删除';
                          })
                          .join('；')
                      : '全书通用 · 未限定章节'}
                  </span>
                </p>
                <footer>
                  <span>{editing?.id === fact.id ? '正在编辑' : '已记录'}</span>
                  <div>
                    <button
                      type="button"
                      className="text-button"
                      aria-label={`编辑事实：${fact.title}`}
                      disabled={unavailable}
                      onClick={() => {
                        edit(fact);
                        editorTitle.current?.focus();
                      }}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="text-button knowledge-panel__delete"
                      aria-label={`删除事实：${fact.title}`}
                      disabled={unavailable}
                      onClick={() => void remove(fact)}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                      删除
                    </button>
                  </div>
                </footer>
              </article>
            ))}
          </div>
          {!loading && !facts.length && (
            <div className="knowledge-panel__empty">
              <FileText size={30} aria-hidden="true" />
              <h4>{q || type ? '没有找到匹配的事实' : '故事的事实库，从这里开始'}</h4>
              <p>
                {q || type
                  ? '试试其他关键词，或清除类型筛选。'
                  : '把重要人物、伏笔或世界设定记下来，让创作始终前后一致。'}
              </p>
              {q || type ? (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => {
                    setQ('');
                    setType('');
                  }}
                >
                  查看全部事实
                </button>
              ) : (
                <button type="button" className="button secondary" disabled={unavailable} onClick={newFact}>
                  记录第一条事实
                </button>
              )}
            </div>
          )}
        </section>
        <form
          className="knowledge-panel__editor"
          aria-label={editing ? '编辑事实' : '新建事实'}
          aria-busy={busy}
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <header className="knowledge-panel__section-heading">
            <h3>{editing ? '编辑事实' : '新建事实'}</h3>
            <span>{editing ? `修订 ${editing.revision}` : '记录一个新设定'}</span>
          </header>
          <div className="knowledge-panel__fields">
            <label className="knowledge-panel__field">
              事实类型
              <select
                aria-label="保存事实类型"
                disabled={unavailable}
                value={kind}
                onChange={(e) => setKind(e.target.value as KnowledgeFactType)}
              >
                {knowledgeFactTypes.map((item) => (
                  <option key={item} value={item}>
                    {labels[item]}
                  </option>
                ))}
              </select>
            </label>
            <label className="knowledge-panel__field">
              事实标题 <span className="knowledge-panel__required">必填</span>
              <input
                ref={editorTitle}
                aria-label="事实标题"
                required
                placeholder="例如：林舟无法使用火系法术"
                maxLength={200}
                disabled={unavailable}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label className="knowledge-panel__field">
              事实内容 <span className="knowledge-panel__required">必填</span>
              <textarea
                aria-label="事实内容"
                required
                placeholder="写下准确的设定、关系或事件，便于后续创作引用…"
                rows={6}
                disabled={unavailable}
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
            </label>
            <label className="knowledge-panel__field">
              标签
              <input
                aria-label="事实标签"
                placeholder="例如：主角，能力限制"
                disabled={unavailable}
                value={tags}
                onChange={(e) => setTags(e.target.value)}
              />
              <small>多个标签用逗号分隔，方便以后检索。</small>
            </label>
            <div className="knowledge-panel__chapters-field">
              <div className="knowledge-panel__chapter-heading">
                <span>关联章节</span>
                <small>{chapterIds.length ? `已选 ${chapterIds.length} 章` : '可选 · 默认全书通用'}</small>
              </div>
              <div className="knowledge-panel__chapters" role="group" aria-label="关联章节">
                {chapters.length ? (
                  chapters.map((chapter) => (
                    <label key={chapter.id}>
                      <input
                        type="checkbox"
                        disabled={unavailable}
                        checked={chapterIds.includes(chapter.id)}
                        onChange={(e) =>
                          setChapterIds((current) =>
                            e.target.checked
                              ? [...current, chapter.id]
                              : current.filter((id) => id !== chapter.id),
                          )
                        }
                      />
                      <span>
                        第 {chapter.number} 章 · {chapter.title}
                      </span>
                    </label>
                  ))
                ) : (
                  <p>暂无章节，当前事实将作为全书通用设定。</p>
                )}
              </div>
              <p className="knowledge-panel__hint">
                不关联章节的事实可用于所有章节；关联事实仅在引用章节之后进入创作上下文。
              </p>
            </div>
          </div>
          <footer className="knowledge-panel__editor-actions">
            <button className="button primary" disabled={unavailable || !title.trim() || !content.trim()}>
              {busy ? (
                <>
                  <LoaderCircle size={15} aria-hidden="true" />
                  处理中…
                </>
              ) : (
                '保存事实'
              )}
            </button>
            {editing && (
              <button type="button" className="text-button" disabled={unavailable} onClick={newFact}>
                取消编辑
              </button>
            )}
          </footer>
        </form>
      </div>
    </section>
  );
}
