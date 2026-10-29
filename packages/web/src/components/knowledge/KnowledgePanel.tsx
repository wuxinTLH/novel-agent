import { useEffect, useRef, useState } from 'react';
import { api } from '../../services/api';
import { knowledgeFactTypes, type KnowledgeFact, type KnowledgeFactType } from '../../../../../shared/knowledge';
import type { Chapter } from '../../../../../shared/types';

type Props = {
  projectId: string;
  chapters?: Pick<Chapter, 'id' | 'title' | 'number'>[];
  onProjectUpdated?: (facts: KnowledgeFact[]) => void;
};
const labels: Record<KnowledgeFactType, string> = { character: '人物', relationship: '关系', timeline: '时间线', foreshadow: '伏笔', fact: '事实' };
export default function KnowledgePanel({ projectId, chapters = [], onProjectUpdated }: Props) {
  const [facts, setFacts] = useState<KnowledgeFact[]>([]);
  const [q, setQ] = useState(''), [type, setType] = useState('');
  const [title, setTitle] = useState(''), [content, setContent] = useState('');
  const [kind, setKind] = useState<KnowledgeFactType>('fact');
  const [tags, setTags] = useState(''), [chapterIds, setChapterIds] = useState<string[]>([]);
  const [editing, setEditing] = useState<KnowledgeFact | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const currentProject = useRef(projectId);
  currentProject.current = projectId;
  const requestVersion = useRef(0), mutationLock = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const resetEditor = () => {
    setEditing(null); setTitle(''); setContent(''); setKind('fact'); setTags(''); setChapterIds([]);
  };
  useEffect(() => {
    resetEditor(); setFacts([]); setError('');
  }, [projectId]);
  useEffect(() => {
    let active = true;
    const version = ++requestVersion.current;
    const query = new URLSearchParams({ ...(q ? { q } : {}), ...(type ? { type } : {}) });
    setLoading(true); setError('');
    void api<KnowledgeFact[]>(`/projects/${projectId}/knowledge${query.size ? `?${query}` : ''}`)
      .then((value) => { if (active && version === requestVersion.current && currentProject.current === projectId) setFacts(value); })
      .catch((e: unknown) => { if (active && version === requestVersion.current && currentProject.current === projectId) setError(e instanceof Error ? e.message : '加载失败'); })
      .finally(() => { if (active && version === requestVersion.current && currentProject.current === projectId) setLoading(false); });
    return () => { active = false; };
  }, [projectId, q, type, reload]);

  const mutate = async (operation: () => Promise<unknown>, saved = false) => {
    if (mutationLock.current) return;
    mutationLock.current = true; setBusy(true); setError('');
    const origin = projectId;
    try {
      await operation();
      if (!mounted.current || currentProject.current !== origin) return;
      // Invalidate any in-flight filtered read before requesting the same current filter again.
      requestVersion.current++;
      if (saved) resetEditor();
      setReload((value) => value + 1);
      if (onProjectUpdated) {
        const all = await api<KnowledgeFact[]>(`/projects/${origin}/knowledge`);
        if (mounted.current && currentProject.current === origin) onProjectUpdated(all);
      }
    } catch (e) {
      if (mounted.current && currentProject.current === origin) setError(e instanceof Error ? e.message : '操作失败');
    } finally { mutationLock.current = false; if (mounted.current) setBusy(false); }
  };
  const save = () => {
    if (!title.trim() || !content.trim()) return;
    const payload = {
      type: kind, title: title.trim(), content,
      tags: [...new Set(tags.split(/[,，、\n]/u).map((tag) => tag.trim()).filter(Boolean))], chapterIds,
      ...(editing ? { expectedRevision: editing.revision } : {}),
    };
    void mutate(() => api(`/projects/${projectId}/knowledge${editing ? `/${editing.id}` : ''}`, {
      method: editing ? 'PATCH' : 'POST', body: JSON.stringify(payload),
    }), true);
  };
  const edit = (fact: KnowledgeFact) => {
    if (busy) return;
    setEditing(fact); setKind(fact.type); setTitle(fact.title); setContent(fact.content);
    setTags(fact.tags.join('，')); setChapterIds([...fact.chapterIds]); setError('');
  };
  return <section className="knowledge-panel">
    <div className="knowledge-toolbar">
      <input aria-label="搜索事实" placeholder="搜索人物、关系、事实…" value={q} onChange={(e) => setQ(e.target.value)} />
      <select aria-label="事实类型" value={type} onChange={(e) => setType(e.target.value)}><option value="">全部类型</option>{knowledgeFactTypes.map((item) => <option key={item} value={item}>{labels[item]}</option>)}</select>
    </div>
    {error && <p role="alert">{error}</p>}
    <form className="knowledge-create" aria-busy={busy} onSubmit={(e) => { e.preventDefault(); save(); }}>
      {editing && <p>编辑事实 · 修订 {editing.revision}</p>}
      <select aria-label="保存事实类型" disabled={busy} value={kind} onChange={(e) => setKind(e.target.value as KnowledgeFactType)}>{knowledgeFactTypes.map((item) => <option key={item} value={item}>{labels[item]}</option>)}</select>
      <input aria-label="事实标题" required placeholder="事实标题" maxLength={200} disabled={busy} value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea aria-label="事实内容" required placeholder="事实内容（可关联章节）" disabled={busy} value={content} onChange={(e) => setContent(e.target.value)} />
      <input aria-label="事实标签" placeholder="标签，多个用逗号分隔" disabled={busy} value={tags} onChange={(e) => setTags(e.target.value)} />
      <label>关联章节（可多选）
        <select aria-label="关联章节" multiple disabled={busy} value={chapterIds} onChange={(e) => setChapterIds(Array.from(e.target.selectedOptions, (option) => option.value))}>
          {chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>第 {chapter.number} 章 · {chapter.title}</option>)}
        </select>
      </label>
      <p className="muted">不关联章节的事实可用于所有章节；关联事实仅在引用章节之后进入创作上下文。</p>
      <button className="button primary" disabled={busy || !title.trim() || !content.trim()}>{busy ? '保存中…' : '保存事实'}</button>
      {editing && <button type="button" className="text-button" disabled={busy} onClick={resetEditor}>取消编辑</button>}
    </form>
    {loading && <p role="status">正在加载事实…</p>}
    <div className="knowledge-list">{facts.map((fact) => <article key={fact.id}>
      <header><strong>{fact.title}</strong><span>{labels[fact.type]}</span></header>
      <p>{fact.content}</p>
      {fact.tags.length > 0 && <p className="muted">标签：{fact.tags.join('、')}</p>}
      {fact.chapterIds.length > 0 && <p className="muted">关联章节：{fact.chapterIds.map((id) => { const chapter = chapters.find((item) => item.id === id); return chapter ? `第 ${chapter.number} 章 · ${chapter.title}` : '章节已删除'; }).join('；')}</p>}
      <small>修订 {fact.revision}</small>
      <button type="button" className="text-button" aria-label={`编辑事实：${fact.title}`} disabled={busy} onClick={() => edit(fact)}>编辑</button>
      <button type="button" className="text-button" aria-label={`删除事实：${fact.title}`} disabled={busy} onClick={() => void mutate(() => api(`/projects/${projectId}/knowledge/${fact.id}?expectedRevision=${fact.revision}`, { method: 'DELETE' }))}>删除</button>
    </article>)}{!loading && !facts.length && <p>暂无匹配事实，先记录一个重要设定吧。</p>}</div>
  </section>;
}
