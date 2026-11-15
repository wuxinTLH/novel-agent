import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LOG_LEVELS, LOG_CATEGORIES, ALERT_PROVIDERS, updateLogAlertConfigSchema, type LogsResponse, type LogAlertConfig, type LogAlertsResponse } from '../../../../../shared/operational-logs';
import { api, ApiError } from '../../services/api';
import { formatDateTime } from '../../lib/dateTime';
import { useLocale } from '../../locals';
import { useConfirm } from '../common/AppDialog';
import { alertConfigBody, emptyLogFilters, LOG_PAGE_SIZE, operationalLogsQuery, validLogFilters } from './operationalLogHelpers';
import './operational-logs.scss';

type Props = { writable: boolean; onBusy: (value: boolean) => void; onDirty: (value: boolean) => void };
type AlertResponse = LogAlertsResponse;
const levels = { info: '信息', warning: '警告', error: '错误' } as const;
const categories = { runtime: '运行日志', error: '错误日志', 'medium-risk': '中风险', 'high-risk': '高风险', 'system-error': '系统错误', 'system-failure': '系统故障' } as const;
const providers = { wechat: '微信', feishu: '飞书', dingtalk: '钉钉', wecom: '企业微信' } as const;

export default function OperationalLogsPanel({ writable, onBusy, onDirty }: Props) {
  const { t } = useLocale();
  const [draft, setDraft] = useState(emptyLogFilters);
  const [query, setQuery] = useState({ filters: emptyLogFilters, offset: 0 });
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<LogsResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const expire = () => { setExpired(true); setData(undefined); };
    const storage = (event: StorageEvent) => { if (event.key === 'novel-auth-identity' || event.key === null) expire(); };
    window.addEventListener('novel-auth-expired', expire);
    window.addEventListener('storage', storage);
    return () => { window.removeEventListener('novel-auth-expired', expire); window.removeEventListener('storage', storage); };
  }, []);
  useEffect(() => {
    if (expired) return;
    const controller = new AbortController();
    setLoading(true); setError(false); setData(undefined);
    void api<LogsResponse>(operationalLogsQuery(query.filters, query.offset), { signal: controller.signal, cache: 'no-store' })
      .then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, refresh, expired]);
  const valid = validLogFilters(draft);
  return <div className="operational-logs-panel" data-testid="operational-logs-panel">
    <header><h3>{t('日志与告警')}</h3><p>{t('仅显示脱敏运维事件；时间与日期筛选均为 UTC+8。')}</p></header>
    {expired && <p role="alert">{t('会话已切换，请关闭并重新打开管理控制台。')}</p>}
    <form className="operational-log-filters" onSubmit={event => { event.preventDefault(); if (valid && !expired) { setQuery({ filters: { ...draft }, offset: 0 }); setRefresh(value => value + 1); } }}>
      <label>{t('日志级别')}<select value={draft.level} disabled={expired} onChange={event => setDraft({ ...draft, level: event.target.value as typeof draft.level })}><option value="">{t('全部级别')}</option>{LOG_LEVELS.map(level => <option key={level} value={level}>{t(levels[level])}</option>)}</select></label>
      <label>{t('日志分类')}<select value={draft.category} disabled={expired} onChange={event => setDraft({ ...draft, category: event.target.value as typeof draft.category })}><option value="">{t('全部分类')}</option>{LOG_CATEGORIES.map(category => <option key={category} value={category}>{t(categories[category])}</option>)}</select></label>
      <label>{t('开始日期（UTC+8）')}<input type="date" value={draft.from} aria-invalid={!valid} disabled={expired} onChange={event => setDraft({ ...draft, from: event.target.value })} /></label>
      <label>{t('结束日期（UTC+8）')}<input type="date" value={draft.to} aria-invalid={!valid} disabled={expired} onChange={event => setDraft({ ...draft, to: event.target.value })} /></label>
      <label>{t('搜索日志')}<input type="search" maxLength={100} value={draft.search} disabled={expired} onChange={event => setDraft({ ...draft, search: event.target.value })} /></label>
      <button type="submit" disabled={!valid || loading || expired}>{t('查询日志')}</button>
      {!valid && <p role="alert">{t('请选择有效日期，开始日期不能晚于结束日期。')}</p>}
    </form>
    <div className="operational-log-actions"><button type="button" disabled={loading || expired} onClick={() => setRefresh(value => value + 1)}>{t('刷新日志')}</button></div>
    <section aria-busy={loading && !expired} aria-label={t('日志结果')}>
      {loading && !expired && <p role="status">{t('正在加载日志…')}</p>}
      {error && !expired && <p role="alert">{t('日志加载失败，请刷新重试。')}</p>}
      {data && !loading && <>
        {data.items.length === 0 ? <p role="status">{t('当前筛选下暂无日志。')}</p> : <div className="operational-log-table" role="region" aria-label={t('日志结果')} tabIndex={0}><table>
          <caption>{t('运维日志（UTC+8）')}</caption><thead><tr>{(['时间', '日志级别', '日志分类', '事件代码', '消息'] as const).map(label => <th scope="col" key={label}>{t(label)}</th>)}</tr></thead>
          <tbody>{data.items.map(item => <tr key={item.id}><td>{formatDateTime(item.at)}</td><td>{t(levels[item.level])}</td><td>{t(categories[item.category])}</td><td><code>{item.code}</code></td><td className="operational-log-message">{item.message}</td></tr>)}</tbody>
        </table></div>}
        <nav className="operational-log-actions" aria-label={t('日志分页')}>
          <button type="button" disabled={query.offset === 0 || expired} onClick={() => setQuery({ ...query, offset: Math.max(0, query.offset - LOG_PAGE_SIZE) })}>{t('上一页')}</button>
          <span>{t('第 {page} 页，共 {total} 条', { page: Math.floor(query.offset / LOG_PAGE_SIZE) + 1, total: data.total })}</span>
          <button type="button" disabled={query.offset + LOG_PAGE_SIZE >= data.total || query.offset + LOG_PAGE_SIZE > 10000 || expired} onClick={() => setQuery({ ...query, offset: query.offset + LOG_PAGE_SIZE })}>{t('下一页')}</button>
        </nav>
      </>}
    </section>
    {writable && <AlertConfigForm writable={writable} expired={expired} onBusy={onBusy} onDirty={onDirty} />}
  </div>;
}

function AlertConfigForm({ writable, expired, onBusy, onDirty }: Props & { expired: boolean }) {
  const { t } = useLocale();
  const confirm = useConfirm();
  const [saved, setSaved] = useState<LogAlertConfig>();
  const [draft, setDraft] = useState<LogAlertConfig>();
  const [availability, setAvailability] = useState<AlertResponse['providers']>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [reload, setReload] = useState(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const gate = useRef(false);
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => { controller.current?.abort(); onBusy(false); onDirty(false); }, [onBusy, onDirty]);
  useEffect(() => { if (expired) { controller.current?.abort(); gate.current = false; setBusy(false); onBusy(false); setDraft(undefined); setSaved(undefined); } }, [expired, onBusy]);
  useEffect(() => {
    if (expired || !writable) return;
    const request = new AbortController(); controller.current = request;
    gate.current = true; setBusy(true); onBusy(true); setError(''); setNotice('');
    void api<AlertResponse>('/admin/log-alerts', { signal: request.signal, cache: 'no-store' }).then(value => {
      if (request.signal.aborted) return;
      setSaved(value.config); setDraft(value.config); setAvailability(value.providers); setConflict(false);
    }).catch(() => { if (!request.signal.aborted) setError(t('告警配置加载失败，请重试。')); })
      .finally(() => { if (!request.signal.aborted) { gate.current = false; setBusy(false); onBusy(false); } });
    return () => request.abort();
  }, [reload, writable, expired, onBusy]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!writable || expired || gate.current || conflict || !draft || !dirty || !updateLogAlertConfigSchema.safeParse(alertConfigBody(draft)).success) return;
    const request = new AbortController(); controller.current = request;
    gate.current = true; setBusy(true); onBusy(true); setError(''); setNotice('');
    try {
      const value = await api<AlertResponse>('/admin/log-alerts', { method: 'PUT', signal: request.signal, body: JSON.stringify(alertConfigBody(draft)) });
      if (request.signal.aborted) return;
      setSaved(value.config); setDraft(value.config); setAvailability(value.providers); setNotice(t('告警配置已保存；不代表通知已发送。'));
    } catch (reason) {
      if (request.signal.aborted) return;
      const stale = reason instanceof ApiError && reason.status === 409;
      setConflict(stale); setError(t(stale ? '告警配置已被其他管理员修改。编辑内容已保留，请重新加载；不会自动覆盖。' : '告警配置保存失败，编辑内容已保留。'));
    } finally { if (!request.signal.aborted) { gate.current = false; setBusy(false); onBusy(false); } }
  };
  return <form className="operational-alert-config" onSubmit={event => { void save(event); }} aria-busy={busy}>
    <h3>{t('告警配置')}</h3><p>{t('通知渠道为预留配置，未接入的渠道不会发送通知。')}</p>
    {busy && <p role="status">{t('正在读取服务端状态…')}</p>}
    {error && <p role="alert" className="administration-feedback is-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <button type="button" disabled={busy || expired} onClick={async () => {
      if (dirty && !(await confirm(t('重新加载将丢弃尚未保存的告警编辑，确定继续吗？')))) return;
      if (!expired && !gate.current) setReload(value => value + 1);
    }}>{t('重新加载告警配置')}</button>
    {draft && <>
      <fieldset disabled={busy || expired || conflict}><legend>{t('告警规则')}</legend>
        <label className="operational-log-checkbox"><input type="checkbox" checked={draft.enabled} onChange={event => { setNotice(''); setDraft({ ...draft, enabled: event.target.checked }); }} />{t('启用告警')}</label>
        <label>{t('最低告警级别')}<select value={draft.minimumLevel} onChange={event => { setNotice(''); setDraft({ ...draft, minimumLevel: event.target.value as 'warning' | 'error' }); }}><option value="warning">{t('警告及错误')}</option><option value="error">{t('仅错误')}</option></select></label>
        <label>{t('冷却时间（秒）')}<input type="number" required min={1} max={86400} step={1} value={Number.isNaN(draft.cooldownSeconds) ? '' : draft.cooldownSeconds} onChange={event => { setNotice(''); setDraft({ ...draft, cooldownSeconds: event.target.valueAsNumber }); }} /></label>
        <fieldset><legend>{t('告警分类')}</legend><div className="operational-log-checks">{LOG_CATEGORIES.map(category => <label className="operational-log-checkbox" key={category}><input type="checkbox" checked={draft.categories.includes(category)} onChange={event => { setNotice(''); setDraft({ ...draft, categories: event.target.checked ? [...draft.categories, category] : draft.categories.filter(value => value !== category) }); }} />{t(categories[category])}</label>)}</div></fieldset>
        <fieldset><legend>{t('通知渠道')}</legend><div className="operational-log-checks">{ALERT_PROVIDERS.map(provider => <label className="operational-log-checkbox" key={provider}><input type="checkbox" checked={draft.providers[provider]} onChange={event => { setNotice(''); setDraft({ ...draft, providers: { ...draft.providers, [provider]: event.target.checked } }); }} />{t(providers[provider])}<small>{t(availability.some(value => value.id === provider && value.available) ? '已接入' : '预留，未接入')}</small></label>)}</div></fieldset>
      </fieldset>
      <button type="submit" disabled={busy || expired || conflict || !dirty || !Number.isInteger(draft.cooldownSeconds) || draft.cooldownSeconds < 1 || draft.cooldownSeconds > 86400 || draft.categories.length === 0}>{t('保存告警配置')}</button>
    </>}
  </form>;
}
