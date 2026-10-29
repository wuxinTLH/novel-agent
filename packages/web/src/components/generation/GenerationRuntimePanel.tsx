import { useEffect, useState } from 'react';
import type { Project } from '../../../../../shared/types';
import { api } from '../../services/api';
interface ProgressSnapshot { runId: string; nodes: { stepId: string; text: string; truncated: boolean; updatedAt: string }[] }

export default function GenerationRuntimePanel({ project, busy, onResume }: { project: Project; busy: boolean; onResume: () => void }) {
  const run = project.run;
  const [preview, setPreview] = useState<ProgressSnapshot | undefined>();
  const [previewError, setPreviewError] = useState('');
  useEffect(() => {
    setPreview(undefined); setPreviewError('');
    if (run?.status !== 'running') return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const value = await api<ProgressSnapshot>(`/projects/${encodeURIComponent(project.id)}/generation-progress`, { signal: controller.signal, timeoutMs: 5000 });
        if (!disposed) { setPreview(value.runId === run.id ? value : undefined); setPreviewError(''); }
      } catch {
        if (!disposed) { setPreview(undefined); setPreviewError('临时正文暂时无法读取，生成状态以工作流结果为准。'); }
      } finally {
        if (!disposed) timer = setTimeout(() => { void poll(); }, 500);
      }
    };
    void poll();
    return () => { disposed = true; controller.abort(); if (timer !== undefined) clearTimeout(timer); };
  }, [project.id, run?.id, run?.status]);
  const usage = project.modelUsage || [];
  const recent = usage.slice(-5).reverse();
  return <div className="generation-progress">
    {run?.status === 'running' && <section aria-label="实时临时正文">
      <h3>实时临时正文</h3>
      <p className="muted">以下为模型增量预览，尚未完成或审校；失败时不会采用，也不能发布。结束后会清空预览，以保存结果为准。</p>
      {previewError && <p role="status">{previewError}</p>}
      {preview?.runId === run.id && preview.nodes.length ? preview.nodes.map(node => <details key={node.stepId} open>
        <summary>{project.steps.find(step => step.id === node.stepId)?.title || node.stepId}{node.truncated ? ' · 仅显示最近 128 Ki 字符' : ''}</summary>
        <pre tabIndex={0} aria-label="临时正文，可滚动阅读" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 320, overflow: 'auto' }}>{node.text || '等待模型返回正文…'}</pre>
      </details>) : <p className="muted">等待模型返回增量内容…</p>}
    </section>}
    {run?.resumeSnapshot && (run.status === 'error' || run.status === 'cancelled') && !run.request?.stepId &&
      <p><button type="button" className="button" disabled={busy} onClick={onResume}>从断点继续剩余章节</button>
        <span className="muted"> 校验原任务快照，跳过已保存章节；配置或原稿变化时拒绝恢复。</span></p>}
    {recent.length > 0 && <details><summary>模型用量（共 {usage.length} 次，显示最近 {recent.length} 次）</summary>
      <p className="muted">输入 {usage.reduce((sum, item) => sum + item.inputTokens, 0).toLocaleString()} tokens · 输出 {usage.reduce((sum, item) => sum + item.outputTokens, 0).toLocaleString()} tokens</p>
      <ul>{recent.map((item, index) => <li key={`${item.createdAt}-${index}`}>
        {project.steps.find((step) => step.id === item.stepId)?.title || item.stepId} · 输入 {item.inputTokens} / 输出 {item.outputTokens} tokens
        {item.estimated ? '（估算）' : '（服务商返回）'}{item.estimatedCost !== undefined ? ` · 预估费用 ${item.estimatedCost.toFixed(6)}` : ''}
      </li>)}</ul>
    </details>}
  </div>;
}
