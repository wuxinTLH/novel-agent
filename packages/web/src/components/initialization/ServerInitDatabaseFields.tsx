import type { ServerInitDatabaseConfig } from '../../../../../shared/server-init';
import type { Translator } from '../../locals';
import { databaseFields, type DatabaseDraft } from './init-database';
export default function ServerInitDatabaseFields({ config, value, onChange, t, invalid }: { config?: ServerInitDatabaseConfig; value: DatabaseDraft; onChange: (value: DatabaseDraft) => void; t: Translator; invalid: boolean }) {
  const locked = (key: string) => config?.environmentFields.includes(key) ?? false;
  const update = (key: keyof DatabaseDraft, next: string) => onChange({ ...value, [key]: next });
  const labels = { host: '数据库主机', port: '数据库端口', database: '数据库名称', user: '数据库用户', password: '数据库密码', timeoutMs: '连接超时（毫秒）' } as const;
  return <fieldset><legend>{t('存储配置')}</legend>
    <p className="server-init__notice">{t('当前使用本地 JSON。SQL 仅保存后续连接配置：不连接数据库、不创建表、不迁移数据，也不激活 SQL；重启后仍使用 JSON。')}</p>
    <label htmlFor="init-db-mode">{t('存储方式')}</label>
    <select id="init-db-mode" data-testid="init-db-mode" disabled={locked('mode')} value={value.mode} onChange={event => update('mode', event.target.value)}>
      <option value="local-json">{t('本地 JSON（默认，立即使用）')}</option><option value="sql-later">{t('SQL（仅保存配置，稍后离线初始化）')}</option>
    </select>
    {value.mode === 'sql-later' && <>
      <label htmlFor="init-db-driver">{t('数据库类型')}</label>
      <select id="init-db-driver" data-testid="init-db-driver" disabled={locked('driver')} value={value.driver} onChange={event => onChange({ ...value, driver: event.target.value, port: locked('port') ? value.port : event.target.value === 'mysql' ? '3306' : event.target.value === 'sqlserver' ? '1433' : '5432' })}>
        <option value="postgresql">PostgreSQL</option><option value="mysql">MySQL</option><option value="sqlserver">SQL Server</option>
      </select>
      {databaseFields.filter((key): key is keyof typeof labels => key in labels).map(key => <div className="server-init__field" key={key}>
        <label htmlFor={'init-db-' + key}>{t(labels[key])}</label>
        <input id={'init-db-' + key} data-testid={'init-db-' + (key === 'timeoutMs' ? 'timeout' : key)} type={key === 'password' ? 'password' : 'text'} inputMode={key === 'port' || key === 'timeoutMs' ? 'numeric' : undefined} autoComplete="off" readOnly={locked(key)} value={value[key]} onChange={event => update(key, event.target.value)} aria-describedby={locked(key) ? 'init-db-env' : undefined} />
        {key === 'password' && config?.connection?.hasPassword && <small>{t('已配置（秘密不回显）')}</small>}
      </div>)}
      <label htmlFor="init-db-tls">TLS</label><select id="init-db-tls" data-testid="init-db-tls" value={value.tls} disabled={locked('tls')} onChange={event => update('tls', event.target.value)}><option value="verify">{t('验证 TLS 证书（推荐）')}</option><option value="off">{t('关闭 TLS（仅回环主机）')}</option></select>
      <p>{t('后续须停止服务、备份数据，再通过离线流程初始化数据库及迁移；此处不会执行这些操作。')}</p>
      {invalid && <p role="alert">{t('请检查数据库配置：主机、端口（1–65535）、名称（字母或下划线开头，仅字母数字下划线）、用户及超时（1000–30000 毫秒）；仅回环主机可关闭 TLS。')}</p>}
    </>}
    {!!config?.environmentFields.length && <small id="init-db-env">{t('环境配置优先（只读）')}</small>}
  </fieldset>;
}
