import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useConfirm } from './AppDialog';

type Driver = 'mysql' | 'postgresql' | 'sqlserver';
type Config = { driver: Driver; host: string; port: number; database: string; user: string; tls: 'verify' | 'off'; timeoutMs: number; hasPassword?: boolean };
type Status = { configured: boolean; config: Config | null; busy: boolean; storage: string; schemaVersion: number; available: boolean; errorCode?: string };
const initial: Config = { driver: 'mysql', host: 'localhost', port: 3306, database: 'novel_agent', user: '', tls: 'verify', timeoutMs: 10000 };
const ports: Record<Driver, number> = { mysql: 3306, postgresql: 5432, sqlserver: 1433 };
export default function DatabaseSettings() {
  const confirm = useConfirm();
  const [config, setConfig] = useState<Config>(initial);
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dirty, setDirty] = useState(false);
  const gate = useRef(false);
  useEffect(() => {
    let active = true;
    void api<Status>('/sqlconnect/status').then(value => {
      if (!active) return;
      setStatus(value); if (value.config) setConfig(value.config);
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '数据库配置加载失败'); });
    return () => { active = false; };
  }, []);
  const change = (patch: Partial<Config>) => { setConfig(value => ({ ...value, ...patch })); setDirty(true); setNotice(''); };
  const run = async (task: () => Promise<void>) => {
    if (gate.current) return;
    gate.current = true; setBusy(true); setError(''); setNotice('');
    try { await task(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '数据库操作失败'); }
    finally { gate.current = false; setBusy(false); }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const { hasPassword: _hasPassword, ...fields } = config;
      await api('/sqlconnect/config', { method: 'PUT', body: JSON.stringify({ ...fields, ...(clearPassword ? { password: '' } : password ? { password } : {}) }) });
      const value = await api<Status>('/sqlconnect/status');
      setStatus(value); if (value.config) setConfig(value.config);
      setPassword(''); setClearPassword(false); setDirty(false); setNotice('数据库连接配置已保存，尚未自动连接或初始化。');
    });
  };
  const initialize = () => void run(async () => {
    const accepted = await confirm(`将在数据库「${config.database}」内创建 NovelAgent 预留表。请先备份数据库；不会迁移本地小说、删除或覆盖现有表数据。是否继续？`, { title: '初始化数据库结构', confirmText: '确认初始化', danger: true });
    if (!accepted) return;
    await api('/sqlconnect/initialize', { method: 'POST', body: JSON.stringify({ confirmDatabase: config.database }), timeoutMs: 120000 });
    setNotice('数据库结构初始化完成。本地小说存储仍为 JSON，未执行数据迁移。');
  });
  return <section className="settings-card database-settings" aria-label="SQLconnect 数据库连接">
    <h3>SQLconnect · 数据库连接</h3>
    <p>支持 MySQL、PostgreSQL、SQL Server（MSSQL）。当前小说仍使用本地 JSON；此处管理数据库连接与预留结构，不自动迁移数据。User 用户服务暂未启用。</p>
    <form onSubmit={save}>
      <fieldset disabled={busy || !status || !status.available} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <label>数据库类型<select value={config.driver} onChange={event => { const driver = event.target.value as Driver; change({ driver, port: ports[driver] }); }}><option value="mysql">MySQL</option><option value="postgresql">PostgreSQL</option><option value="sqlserver">SQL Server / MSSQL</option></select></label>
        <label>服务器<input required value={config.host} onChange={event => change({ host: event.target.value })} autoComplete="off" /></label>
        <label>端口<input type="number" min="1" max="65535" required value={config.port} onChange={event => change({ port: Number(event.target.value) })} /></label>
        <label>数据库名称<input required value={config.database} onChange={event => change({ database: event.target.value })} autoComplete="off" /></label>
        <label>数据库用户<input required value={config.user} onChange={event => change({ user: event.target.value })} autoComplete="off" /></label>
        <label>数据库密码<input type="password" value={password} placeholder={config.hasPassword ? '已保存；留空保留原密码' : '输入密码'} autoComplete="new-password" onChange={event => { setPassword(event.target.value); setDirty(true); }} /></label>
        <label><input type="checkbox" checked={clearPassword} onChange={event => { setClearPassword(event.target.checked); setDirty(true); }} />清除已保存的数据库密码</label>
        <label>TLS<select value={config.tls} onChange={event => change({ tls: event.target.value as Config['tls'] })}><option value="verify">启用并验证证书（推荐）</option><option value="off">关闭（仅 localhost / 回环地址）</option></select></label>
        <label>连接超时（毫秒）<input type="number" min="1000" max="30000" value={config.timeoutMs} onChange={event => change({ timeoutMs: Number(event.target.value) })} /></label>
        <button type="submit">{busy ? '处理中…' : '保存数据库配置'}</button>
        <button type="button" disabled={!status?.configured || dirty} onClick={() => void run(async () => { await api('/sqlconnect/test', { method: 'POST', body: '{}' }); setNotice('数据库连接测试成功。'); })}>测试连接</button>
        <button type="button" disabled={!status?.configured || dirty} onClick={initialize}>初始化数据库</button>
        {dirty && <p>请先保存配置，再进行连接测试或初始化。</p>}
      </fieldset>
    </form>
    {status && !status.available && <p role="alert">数据库连接配置不可用。请停止服务并修复数据目录内的 sqlconnect.json 后重启；本地小说不受影响。</p>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
