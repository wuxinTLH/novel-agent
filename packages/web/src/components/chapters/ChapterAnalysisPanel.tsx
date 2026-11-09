import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { Chapter, ModelSettings } from '../../../../../shared/types';
import { chapterAnalysisSelectionSchema, type ChapterAnalysis, type ChapterAnalysisSelection } from '../../../../../shared/chapter-analysis';
import { api, ApiError } from '../../services/api';
import { useLocale } from '../../locals/useLocale';
import { formatDateTime } from '../../lib/dateTime';
import Modal from '../common/Modal';

export function analysisSelection(chapters: Pick<Chapter, 'number'>[], kind: 'range' | 'recent', from: string, to: string, count: string): { selection?: ChapterAnalysisSelection; count: number; error?: 'invalid' | 'missing' } {
  const integer = (value: string) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
  if (kind === 'recent') {
    if (!integer(count) || Number(count) > 100) return { count: 0, error: 'invalid' };
    const actual = Math.min(chapters.length, Number(count));
    return { count: actual, ...(actual < Number(count) ? { error: 'missing' as const } : { selection: { kind, count: Number(count) } }) };
  }
  if (!integer(from) || !integer(to) || !chapterAnalysisSelectionSchema.safeParse({ kind, from: Number(from), to: Number(to) }).success) return { count: 0, error: 'invalid' };
  const selected = chapters.filter((chapter) => chapter.number >= Number(from) && chapter.number <= Number(to));
  if (selected.length > 100) return { count: selected.length, error: 'invalid' };
  if (!selected.some((chapter) => chapter.number === Number(from)) || !selected.some((chapter) => chapter.number === Number(to))) return { count: selected.length, error: 'missing' };
  return { count: selected.length, selection: { kind, from: Number(from), to: Number(to) } };
}

export function analysisSubmissionUnknown(error: unknown) {
  return !(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.status < 400;
}

const statusKeys = { running: '解析中', done: '解析完成', error: '解析失败', interrupted: '解析已中断' } as const;

/** Mounted with a project/identity key. No browser storage or cross-project report cache. */
export default function ChapterAnalysisPanel({ projectId, chapters, settings, dirty = false }: {
  projectId: string; chapters: Chapter[]; settings: ModelSettings; dirty?: boolean;
}) {
  const { t } = useLocale();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'range' | 'recent'>('recent');
  const [from, setFrom] = useState('1');
  const [to, setTo] = useState('1');
  const [count, setCount] = useState('1');
  const models = (settings.models || []).filter((model) => model.enabled && model.hasKey);
  const [modelId, setModelId] = useState(settings.activeModelId || models[0]?.id || '');
  const [records, setRecords] = useState<ChapterAnalysis[]>([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [pending, setPending] = useState(false);
  const [unknownRequest, setUnknownRequest] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [invalidIdentity, setInvalidIdentity] = useState(false);
  const lifetime = useRef(new AbortController());
  const posting = useRef(false);
  const sequence = useRef(0);
  const currentProject = useRef(projectId);
  currentProject.current = projectId;
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const invalidate = () => { controller.abort(); setInvalidIdentity(true); setRecords([]); setOpen(false); };
    const storage = (event: StorageEvent) => { if (event.key === 'novel-auth-identity' || event.key === null) invalidate(); };
    window.addEventListener('novel-auth-expired', invalidate);
    window.addEventListener('storage', storage);
    return () => { controller.abort(); window.removeEventListener('novel-auth-expired', invalidate); window.removeEventListener('storage', storage); };
  }, [projectId]);
  const load = useCallback(async (signal: AbortSignal) => {
    const request = ++sequence.current;
    setLoading(true);
    try {
      const data = await api<ChapterAnalysis[]>(`/projects/${encodeURIComponent(projectId)}/chapter-analyses`, { signal });
      if (signal.aborted || lifetime.current.signal.aborted || currentProject.current !== projectId || request !== sequence.current) return;
      setRecords(data);
      setLoadError(false);
      setUnknownRequest((value) => {
        const found = data.find((record) => record.requestId === value);
        if (found) { setSelected(found.id); return ''; }
        return value;
      });
    } catch { if (!signal.aborted && !lifetime.current.signal.aborted && request === sequence.current) setLoadError(true); }
    finally { if (!signal.aborted && !lifetime.current.signal.aborted && request === sequence.current) setLoading(false); }
  }, [projectId]);
  const active = records.some((record) => record.status === 'running');
  useEffect(() => {
    if (!open || invalidIdentity) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await load(controller.signal);
      if (!controller.signal.aborted && (active || unknownRequest)) timer = setTimeout(() => void poll(), 2500);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [open, refresh, active, unknownRequest, invalidIdentity, load]);
  const scope = analysisSelection(chapters, kind, from, to, count);
  const validModel = models.some((model) => model.id === modelId);
  const report = records.find((record) => record.id === selected) || records[0];
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (posting.current || pending || unknownRequest || active || loading || loadError || invalidIdentity || !scope.selection || !validModel) return;
    posting.current = true;
    // A history GET started before admission must not overwrite the accepted record.
    sequence.current += 1;
    setPending(true);
    setSubmitError('');
    const requestId = crypto.randomUUID();
    const signal = lifetime.current.signal;
    const sentProject = projectId;
    try {
      const result = await api<ChapterAnalysis>(`/projects/${encodeURIComponent(projectId)}/chapter-analyses`, {
        method: 'POST', signal, body: JSON.stringify({ requestId, selection: scope.selection, modelId }),
      });
      if (signal.aborted || currentProject.current !== sentProject) return;
      setRecords((previous) => [result, ...previous.filter((record) => record.id !== result.id)]);
      setSelected(result.id);
      setRefresh((value) => value + 1);
    } catch (error) {
      if (signal.aborted || currentProject.current !== sentProject) return;
      if (analysisSubmissionUnknown(error)) { setUnknownRequest(requestId); setRefresh((value) => value + 1); }
      else setSubmitError(error instanceof Error ? error.message : t('解析提交未完成，请检查错误后重试。'));
    } finally {
      if (!signal.aborted && currentProject.current === sentProject) { posting.current = false; setPending(false); }
    }
  };
  return <>
    <button type="button" className="button secondary" disabled={invalidIdentity} onClick={() => setOpen(true)}>{t('章节解析')}</button>
    {open && <Modal title={t('章节解析')} description={t('解析只读取已保存章节，调用所选模型并消耗 Token；报告独立保存，不修改正文。')} close={() => setOpen(false)} wide busy={pending} className="chapter-analysis-modal" error={submitError}>
      <div className="chapter-analysis-panel">
        {dirty && <p>{t('未保存的编辑不会包含在解析中。')}</p>}
        <form onSubmit={(event) => void submit(event)} className="chapter-analysis-form">
          <label>{t('解析范围')}<select value={kind} disabled={pending} onChange={(event) => setKind(event.target.value as 'range' | 'recent')}><option value="range">{t('手动起止章')}</option><option value="recent">{t('最近 N 章')}</option></select></label>
          {kind === 'range' ? <>
            <label>{t('起始章号')}<input type="number" min="1" step="1" required value={from} disabled={pending} aria-describedby={`${id}-scope`} onChange={(event) => setFrom(event.target.value)} /></label>
            <label>{t('结束章号')}<input type="number" min="1" step="1" required value={to} disabled={pending} aria-describedby={`${id}-scope`} onChange={(event) => setTo(event.target.value)} /></label>
          </> : <label>{t('最近章节数')}<input type="number" min="1" max="100" step="1" required value={count} disabled={pending} aria-describedby={`${id}-scope`} onChange={(event) => setCount(event.target.value)} /></label>}
          <label>{t('解析模型')}<select value={validModel ? modelId : ''} required disabled={pending} onChange={(event) => setModelId(event.target.value)}><option value="">{t('请选择可用模型')}</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.model}</option>)}</select></label>
          <p id={`${id}-scope`} className="chapter-analysis-scope" role="status">{t('实际选中 {count} 章（仅已保存正文）。', { count: scope.count })} {scope.error && t(scope.error === 'invalid' ? '请输入有效的正整数字段；起始章不得大于结束章，每次最多解析 100 章。' : '所选章号不存在，或已保存章节不足，请调整范围。')}</p>
          <button type="submit" className="button primary" disabled={pending || !!unknownRequest || active || loading || loadError || !scope.selection || !validModel}>{t(pending ? '正在提交解析…' : '开始解析')}</button>
        </form>
        {unknownRequest && <p role="alert">{t('提交结果未知；不会自动重发。请仅刷新解析状态核对。')} <span>{t('请求标识')}: {unknownRequest}</span></p>}
        <div className="chapter-analysis-history-toolbar"><label>{t('解析历史')}<select value={report?.id || ''} onChange={(event) => setSelected(event.target.value)} disabled={!records.length}><option value="" disabled>{t('尚无解析报告。')}</option>{records.map((record) => <option key={record.id} value={record.id}>{formatDateTime(record.createdAt)} · {record.modelName} · {t(statusKeys[record.status])}</option>)}</select></label><button type="button" className="button secondary" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>{t('刷新解析状态')}</button></div>
        {loading && <p role="status">{t('正在读取解析历史…')}</p>}
        {loadError && <p role="alert">{t('解析历史加载失败，请刷新核对。')}</p>}
        {!loading && !loadError && !report && <p>{t('尚无解析报告。')}</p>}
        {report && <section className="chapter-analysis-report" aria-label={t('完整解析报告')}>
          <dl><div><dt>{t('调用状态')}</dt><dd role="status">{t(statusKeys[report.status])}</dd></div><div><dt>{t('解析模型')}</dt><dd>{report.modelName} · {report.modelId}</dd></div><div><dt>{t('创建时间')}</dt><dd>{formatDateTime(report.createdAt)}</dd></div><div><dt>{t('完成时间')}</dt><dd>{formatDateTime(report.completedAt)}</dd></div></dl>
          <h3>{t('所选章节快照')}</h3><ul>{report.sourceChapters.map((chapter) => <li key={chapter.id}>{t('第 {number} 章 · 修订 v{revision} · {title}', chapter)}</li>)}</ul>
          {report.errorCode && <p role="alert">{t('错误代码')}: {report.errorCode}</p>}
          <h3>{t('完整解析报告')}</h3><pre tabIndex={0}>{report.report || t('报告尚未生成；请查看调用状态。')}</pre>
        </section>}
      </div>
    </Modal>}
  </>;
}
