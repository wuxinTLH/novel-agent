import { useEffect, useState, type FormEvent } from 'react';
import type { Project, WorkflowEdge, Step } from '../../../../../shared/types';

export interface WorkflowSchedulePatch {
  maxParallelNodes?: number;
  edges?: WorkflowEdge[];
  steps?: Step[];
}
/** Caller persists one atomic graph patch; labels never select a branch. */
export default function WorkflowScheduleSettings({ project, busy, onSave }: {
  project: Project;
  busy: boolean;
  onSave: (patch: WorkflowSchedulePatch) => Promise<void>;
}) {
  const [cap, setCap] = useState(String(project.workflow?.maxParallelNodes ?? 1));
  // Generation status updates replace project objects without changing these settings.
  const scheduleKey = JSON.stringify({
    cap: project.workflow?.maxParallelNodes ?? 1,
    edges: project.workflow?.edges.map(({ id, source, target, when }) => ({ id, source, target, when })),
    joins: project.steps.map(({ id, join }) => ({ id, join })),
  });
  const [conditions, setConditions] = useState<Record<string, string>>(() =>
    Object.fromEntries((project.workflow?.edges || []).map(edge => [edge.id, edge.when || ''])));
  const [joins, setJoins] = useState<Record<string, 'all' | 'any'>>(() =>
    Object.fromEntries(project.steps.map(step => [step.id, step.join || 'all'])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setCap(String(project.workflow?.maxParallelNodes ?? 1));
    setConditions(Object.fromEntries((project.workflow?.edges || []).map(edge => [edge.id, edge.when || ''])));
    setJoins(Object.fromEntries(project.steps.map(step => [step.id, step.join || 'all'])));
    setError('');
  }, [project.id, scheduleKey]);
  const names = new Map(project.steps.map(step => [step.id, step.title]));
  const disabled = busy || saving;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (disabled || !project.workflow) return;
    const numericCap = Number(cap);
    if (!cap.trim() || !Number.isInteger(numericCap) || numericCap < 1 || numericCap > 4) { setError('节点并发上限必须为 1–4 的整数。'); return; }
    const edges = project.workflow.edges.map(edge => {
      const { when: _old, ...base } = edge;
      const when = (conditions[edge.id] || '').trim();
      return { ...base, ...(when ? { when } : {}) };
    });
    if (edges.some(edge => (edge.when?.length || 0) > 100)) { setError('分支值最多 100 个字符。'); return; }
    const steps = project.steps.map(step => ({ ...step, join: joins[step.id] || 'all' as const }));
    setSaving(true); setError('');
    try { await onSave({ maxParallelNodes: numericCap, edges, steps }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '调度设置保存失败。'); }
    finally { setSaving(false); }
  };
  return <form onSubmit={submit} aria-label="工作流调度设置" aria-busy={saving}>
    <h3>节点调度与条件分支</h3>
    <p className="info-note">独立普通节点可在上限内并行，正文与审校节点保持串行。默认 1 保持原执行顺序；提高上限可能同时发起多个模型请求。章节仍逐章生成。</p>
    <label>普通节点并发上限<input type="number" min={1} max={4} step={1} required value={cap} disabled={disabled} onChange={event => setCap(event.target.value)} /></label>
    <p className="info-note">条件边只匹配来源节点完整输出的严格 JSON 顶层 branch 字符串，例如 {JSON.stringify({ branch: 'approved', content: '内容' })}。branch 值区分大小写；边的显示标签不参与判断。留空表示普通依赖。缺少或无效的显式分支应停止该分支，不能从自然语言猜测。</p>
    <fieldset disabled={disabled}>
      <legend>连线条件</legend>
      {project.workflow?.edges.map(edge => <label key={edge.id}>
        {names.get(edge.source) || edge.source} → {names.get(edge.target) || edge.target}
        <input value={conditions[edge.id] || ''} maxLength={100} placeholder="留空为普通依赖，例如 approved" onChange={event => setConditions(current => ({ ...current, [edge.id]: event.target.value }))} />
      </label>)}
    </fieldset>
    <fieldset disabled={disabled}>
      <legend>节点汇合规则</legend>
      <p className="info-note">all：所有上游均成功且分支选中才执行，任一跳过会继续向下跳过。any：等待所有上游结束，至少一个成功且被选中才执行；任一上游失败仍会阻断，避免隐藏错误。</p>
      {project.steps.filter(step => (project.workflow?.edges || []).filter(edge => edge.target === step.id).length > 1).map(step => <label key={step.id}>
        {step.title}<select value={joins[step.id] || 'all'} onChange={event => setJoins(current => ({ ...current, [step.id]: event.target.value as 'all' | 'any' }))}>
          <option value="all">all · 全部成功</option><option value="any">any · 至少一路成功</option>
        </select>
      </label>)}
    </fieldset>
    {error && <p role="alert">{error}</p>}
    <button className="button primary" type="submit" disabled={disabled || !project.workflow}>{saving ? '保存中…' : '保存调度设置'}</button>
  </form>;
}
