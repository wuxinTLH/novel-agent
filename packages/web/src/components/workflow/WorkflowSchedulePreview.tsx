import { stepDisplayLabel } from './nodeCatalog';
import type { TranslationKey } from '../../locals/core';
import { useLocale } from '../../locals/useLocale';
import { useMemo, useState } from 'react';
import { planWorkflowSchedule, type ScheduleEdge } from '../../../../../shared/workflow-scheduler';

/** Topology preview only: this local cap does not save execution settings. */
export default function WorkflowSchedulePreview({ steps, edges }: {
  steps: readonly { id: string; title: string; subtitle?: string; kind?: string; enabled?: boolean }[];
  edges: readonly ScheduleEdge[];
}) {
  const { t } = useLocale();
  const [concurrency, setConcurrency] = useState(2);
  const preview = useMemo(() => {
    try { return { plan: planWorkflowSchedule(steps, edges, concurrency), error: '' }; }
    catch (error) { return { plan: undefined, error: error instanceof Error ? error.message : t("无法计算调度预览。") }; }
  }, [steps, edges, concurrency, t]);
  const names = new Map(steps.map(step => [step.id, step]));
  return <section aria-label={t("工作流拓扑波次预览")} className="info-note">
    <h3>{t("拓扑波次预览")}</h3>
    <p>{t("查看依赖允许同时准备的节点。执行时仅独立普通节点可在已保存的并发上限内并行，正文与审校节点保持串行；此处调整只改变拓扑预览，不保存设置或发起请求。条件分支仅在运行结果明确选择后生效，预览列出所有可能路径；实际正文与审校屏障可能增加波次。")}</p>
    <label>{t("预览并发上限")}<input type="number" min={1} max={32} step={1} value={concurrency} onChange={event => setConcurrency(Number(event.target.value))} /></label>
    {preview.error ? <p role="alert">{preview.error}</p> : <ol>{preview.plan?.waves.map((wave, index) => <li key={index}>
      {t("波次")}{index + 1}：{wave.map(id => t("{value0}{value1}", { value0: names.has(id) ? stepDisplayLabel({ ...names.get(id)!, subtitle: names.get(id)?.subtitle || '' }, 'title', key => t(key as TranslationKey)) : id, value1: names.get(id)?.enabled === false ? t('（已禁用，将跳过）') : '' })).join('、')}
    </li>)}</ol>}
  </section>;
}
