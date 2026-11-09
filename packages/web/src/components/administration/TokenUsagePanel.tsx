import { Component, Suspense, lazy, useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { TokenUsageResponse } from '../../../../../shared/token-usage';
import { api } from '../../services/api';
import { formatCalendarDate, formatDateTime } from '../../lib/dateTime';
import { useLocale } from '../../locals';
import { defaultTokenUsageRange, modelChartData, tokenUsageQuery, validTokenUsageRange } from './tokenUsageHelpers';
import './token-usage.scss';

const Charts = lazy(() => import('./TokenUsageCharts'));

class ChartBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

type Metrics = TokenUsageResponse['totals'];
type UsageRow = Metrics & { label: string };

function UsageTable({ caption, firstHeading, rows }: { caption: string; firstHeading: string; rows: UsageRow[] }) {
  const { t, locale } = useLocale();
  const format = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 6 });
  const columns = [t('输入 Token'), t('输出 Token'), t('总 Token'), t('请求次数'), t('成功 / 失败 / 待定'), t('估算请求'), t('平均 RPM'), t('峰值 RPM'), t('平均 TokenPM'), t('峰值 TokenPM')];
  return <div className="token-usage-table-scroll" role="region" aria-label={caption} tabIndex={0}>
    <table><caption>{caption}</caption><thead><tr><th scope="col">{firstHeading}</th>{columns.map((column) => <th scope="col" key={column}>{column}</th>)}</tr></thead>
      <tbody>{rows.map((row) => <tr key={row.label}><th scope="row">{row.label}</th>
        <td>{format(row.inputTokens)}</td><td>{format(row.outputTokens)}</td><td>{format(row.totalTokens)}</td><td>{format(row.requests)}</td>
        <td>{format(row.succeeded)} / {format(row.failed)} / {format(row.pending)}</td><td>{format(row.estimatedRequests)}</td>
        <td>{format(row.rpm.average)}</td><td>{format(row.rpm.peak)}</td><td>{format(row.tokenPm.average)}</td><td>{format(row.tokenPm.peak)}</td>
      </tr>)}</tbody></table>
  </div>;
}

/** Parent mounts only for an active, authorized admin tab; no global or persistent stats cache. */
export default function TokenUsagePanel() {
  const { t, locale } = useLocale();
  const id = useId();
  const [draft, setDraft] = useState(() => ({ ...defaultTokenUsageRange(), model: '' }));
  const [query, setQuery] = useState(draft);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<TokenUsageResponse>();
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const valid = validTokenUsageRange(draft.from, draft.to);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    setData(undefined);
    void api<TokenUsageResponse>(tokenUsageQuery(query.from, query.to, query.model), { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        // Preserve options when an exact-model response only contains that model.
        setModels((previous) => Array.from(new Set([...previous, ...result.models])).sort());
      })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, revision]);
  const pie = useMemo(() => modelChartData(data?.byModel.map((item) => ({ label: item.model, value: item.totalTokens })) ?? [], t('其他模型')), [data, t]);
  const bars = useMemo(() => data?.daily.map((item) => ({ label: formatCalendarDate(item.day), value: item.totalTokens })) ?? [], [data]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    setQuery({ ...draft });
    setRevision((current) => current + 1);
  };
  const format = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 6 });
  const fallback = <p data-testid="token-usage-chart-fallback" role="status">{t('图表不可用，请查看下方等价数据表。')}</p>;
  return <section data-testid="token-usage-panel" className="token-usage-panel" aria-labelledby={`${id}-title`}>
    <header><h3 id={`${id}-title`}>{t('Token 用量')}</h3><p>{t('按 UTC 自然日查看模型调用与 Token 用量。')}</p></header>
    <form className="token-usage-filters" onSubmit={submit}>
      <label>{t('开始日期（UTC）')}<input type="date" required aria-invalid={!valid} value={draft.from} aria-describedby={`${id}-range`} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></label>
      <label>{t('结束日期（UTC）')}<input type="date" required aria-invalid={!valid} value={draft.to} aria-describedby={`${id}-range`} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></label>
      <label>{t('模型')}<select value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })}><option value="">{t('全部模型')}</option>{models.map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
      <button type="submit" disabled={!valid || loading}>{t('查询用量')}</button>
      <p id={`${id}-range`} className={valid ? 'token-usage-range' : 'token-usage-range is-invalid'} role={valid ? undefined : 'alert'}>{t('请选择有效日期，范围为 1–31 天（含首尾日）。')}</p>
    </form>
    <div aria-busy={loading} className="token-usage-results">
      {loading && <p role="status">{t('正在加载用量…')}</p>}
      {error && <div role="alert"><p>{t('用量加载失败，请重试。')}</p><button type="button" onClick={() => setRevision((current) => current + 1)}>{t('重试')}</button></div>}
      {data && !loading && <>
        <p className="token-usage-applied">{formatCalendarDate(data.range.from)} — {formatCalendarDate(data.range.to)} · {query.model || t('全部模型')}</p>
        <dl className="token-usage-metrics">{([
          [t('输入 Token'), data.totals.inputTokens], [t('输出 Token'), data.totals.outputTokens], [t('总 Token'), data.totals.totalTokens], [t('请求次数'), data.totals.requests],
          [t('平均 RPM'), data.totals.rpm.average], [t('峰值 RPM'), data.totals.rpm.peak], [t('平均 TokenPM'), data.totals.tokenPm.average], [t('峰值 TokenPM'), data.totals.tokenPm.peak],
        ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{format(value)}</dd></div>)}</dl>
        <aside className="token-usage-disclaimer"><p>{t('实际值与估算值可能混合；供应商未返回用量时使用估算，不作为账单依据。')}</p>
          <p>{t('估算请求')}: {format(data.totals.estimatedRequests)}</p>
          <p>{t('平均速率以所选完整 UTC 日期的全部分钟为分母；峰值为 UTC 分钟桶最大值。')}</p>
          <p>{t('统计覆盖不保证完整；最早可用日期：{day}，保留 {days} 天。', { day: data.coverage.earliestDay ? formatCalendarDate(data.coverage.earliestDay) : t('未知'), days: data.coverage.retentionDays })}</p>
          <p>{t('统计起始时间：{time}', { time: formatDateTime(data.coverage.startedAt) })}</p>
        </aside>
        {data.totals.requests === 0 ? <p role="status">{t('此日期范围与模型下暂无调用记录。')}</p> : <ChartBoundary fallback={fallback} key={revision}>
          <Suspense fallback={<p role="status">{t('正在加载图表…')}</p>}><Charts pie={pie} bars={bars} pieTitle={t('模型用量占比')} barTitle={t('每日 Token 用量（UTC）')} fallbackLabel={t('图表不可用，请查看下方等价数据表。')} /></Suspense>
        </ChartBoundary>}
        <UsageTable caption={t('按模型统计（图表等价数据）')} firstHeading={t('模型')} rows={data.byModel.map((row) => ({ ...row, label: row.model }))} />
        <UsageTable caption={t('按日统计（UTC，图表等价数据）')} firstHeading={t('日期（UTC）')} rows={data.daily.map((row) => ({ ...row, label: formatCalendarDate(row.day) }))} />
      </>}
    </div>
  </section>;
}
