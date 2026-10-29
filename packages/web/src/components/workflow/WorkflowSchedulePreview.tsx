import { useMemo, useState } from 'react';
import { planWorkflowSchedule, type ScheduleEdge } from '../../../../../shared/workflow-scheduler';

/** Topology preview only: this local cap does not save execution settings. */
export default function WorkflowSchedulePreview({ steps, edges }: {
  steps: readonly { id: string; title: string; enabled?: boolean }[];
  edges: readonly ScheduleEdge[];
}) {
  const [concurrency, setConcurrency] = useState(2);
  const preview = useMemo(() => {
    try { return { plan: planWorkflowSchedule(steps, edges, concurrency), error: '' }; }
    catch (error) { return { plan: undefined, error: error instanceof Error ? error.message : '无法计算调度预览。' }; }
  }, [steps, edges, concurrency]);
  const names = new Map(steps.map(step => [step.id, step]));
  return <section aria-label="工作流拓扑波次预览" className="info-note">
    <h3>拓扑波次预览</h3>
    <p>查看依赖允许同时准备的节点。执行时仅独立普通节点可在已保存的并发上限内并行，正文与审校节点保持串行；此处调整只改变拓扑预览，不保存设置或发起请求。条件分支仅在运行结果明确选择后生效，预览列出所有可能路径；实际正文与审校屏障可能增加波次。</p>
    <label>预览并发上限 <input type="number" min={1} max={32} step={1} value={concurrency} onChange={event => setConcurrency(Number(event.target.value))} /></label>
    {preview.error ? <p role="alert">{preview.error}</p> : <ol>{preview.plan?.waves.map((wave, index) => <li key={index}>
      波次 {index + 1}：{wave.map(id => `${names.get(id)?.title || id}${names.get(id)?.enabled === false ? '（已禁用，将跳过）' : ''}`).join('、')}
    </li>)}</ol>}
  </section>;
}
