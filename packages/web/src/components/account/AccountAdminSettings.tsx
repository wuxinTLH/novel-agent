import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, ChevronDown, KeyRound, Mail, Save, ShieldCheck } from 'lucide-react';
import type { AccountAdminConfig } from '../../../../../shared/account';
import { useLocale } from '../../locals';
import './account-admin-settings.scss';

type Flag = 'registration' | 'emailVerification' | 'passwordRecovery' | 'mfa';
const flags = [
  ['registration', '邮箱确认注册', '新用户必须先完成邮件确认，不会获得管理权限。'],
  ['emailVerification', '邮箱验证', '允许用户绑定并验证自己的邮箱。'],
  ['passwordRecovery', '密码找回', '通过一次性邮件链接重置密码，不会移除双重验证。'],
  ['mfa', '双重验证', '允许设置 TOTP 和恢复码；关闭后不会绕过已绑定的因素。'],
] as const;
const oidcFields = [
  ['issuer', '签发者', 'https://identity.example.com'],
  ['clientId', '客户端 ID', 'novel-agent'],
  ['authorizationEndpoint', '授权端点', 'https://identity.example.com/authorize'],
  ['tokenEndpoint', '令牌端点', 'https://identity.example.com/token'],
  ['jwksUri', 'JWKS 地址', 'https://identity.example.com/.well-known/jwks.json'],
  ['redirectUri', '回调地址', 'https://novel.example.com/api/auth/account/oidc/callback'],
] as const;

/** Mount only inside the existing administrator-authenticated settings area. */
export function AccountAdminSettings({
  request,
}: {
  request<T>(path: string, method?: string, body?: unknown): Promise<T>;
}) {
  const { t } = useLocale();
  const [config, setConfig] = useState<AccountAdminConfig>();
  const [saved, setSaved] = useState('');
  const [clientSecret, setSecret] = useState('');
  const [notice, setNotice] = useState<'saved' | 'loadError' | 'saveError' | ''>('');
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  useEffect(() => {
    let active = true;
    request<AccountAdminConfig>('/api/admin/account/config')
      .then((value) => {
        if (active) {
          setConfig(value);
          setSaved(JSON.stringify(value));
        }
      })
      .catch(() => {
        if (active) setNotice('loadError');
      });
    return () => {
      active = false;
    };
  }, [request]);
  const dirty = !!config && (JSON.stringify(config) !== saved || !!clientSecret);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!config || saving.current) return;
    saving.current = true;
    setBusy(true);
    setNotice('');
    setDetail('');
    try {
      const result = await request<AccountAdminConfig>('/api/admin/account/config', 'PUT', {
        ...config,
        oidc: { ...config.oidc, hasClientSecret: undefined, ...(clientSecret ? { clientSecret } : {}) },
      });
      setConfig(result);
      setSaved(JSON.stringify(result));
      setSecret('');
      setNotice('saved');
    } catch (error) {
      setNotice('saveError');
      setDetail(error instanceof Error ? error.message : '');
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  if (!config)
    return <p role={notice ? 'alert' : 'status'}>{t(notice ? '无法读取账户配置' : '正在读取账户配置…')}</p>;
  const toggle = (key: Flag) => setConfig({ ...config, [key]: !config[key] });
  const enabled = flags.filter(([key]) => config[key]).length + Number(config.oidc.enabled);
  return (
    <form className="account-admin" onSubmit={save}>
      <header className="account-admin__header">
        <div>
          <span className="account-admin__eyebrow">
            <ShieldCheck size={14} />
            {t('账户与身份')}
          </span>
          <h3>{t('账户功能配置')}</h3>
          <p>{t('按需开放账户能力，认证总开关保持独立。')}</p>
        </div>
        <span className="account-admin__count">{t('已启用 {count}/5 项', { count: enabled })}</span>
      </header>
      <div className="account-admin__notice">
        <ShieldCheck size={17} />
        <p>{t('默认全部关闭。邮件功能需要服务端 SMTP 配置。不会自动启用全局认证。')}</p>
      </div>
      <fieldset disabled={busy}>
        <section className="account-admin__section" aria-label={t('基础账户能力')}>
          <h4>
            <Mail size={17} />
            {t('基础账户能力')}
          </h4>
          <div className="account-admin__toggles">
            {flags.map(([key, title, description]) => (
              <label className="account-admin__toggle" key={key}>
                <span className="account-admin__toggle-copy">
                  <strong>{t(title)}</strong>
                  <small>{t(description)}</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={config[key]}
                  onChange={() => toggle(key)}
                  aria-label={t(title)}
                />
              </label>
            ))}
          </div>
          <label className="account-admin__field">
            <span>{t('公开站点 HTTPS 地址')}</span>
            <input
              type="url"
              placeholder="https://novel.example.com"
              value={config.publicOrigin}
              onChange={(event) => setConfig({ ...config, publicOrigin: event.target.value })}
            />
            <small>{t('用于邮件回链，须与服务端可信 HTTPS 入口一致。')}</small>
          </label>
        </section>
        <section className="account-admin__section">
          <label className="account-admin__toggle account-admin__oidc-toggle">
            <span className="account-admin__toggle-copy">
              <strong>
                <KeyRound size={17} />
                {t('OIDC 单点登录')}
              </strong>
              <small>{t('使用已有身份提供商；不会按邮箱自动关联或创建账号。')}</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={config.oidc.enabled}
              onChange={(event) =>
                setConfig({ ...config, oidc: { ...config.oidc, enabled: event.target.checked } })
              }
              aria-label={t('启用 OIDC 登录')}
            />
          </label>
          <details className="account-admin__oidc" open={config.oidc.enabled || undefined}>
            <summary>
              {t('连接与密钥设置')}
              <ChevronDown size={16} />
            </summary>
            <div className="account-admin__fields">
              {oidcFields.map(([key, label, placeholder]) => (
                <label className="account-admin__field" key={key}>
                  <span>{t(label)}</span>
                  <input
                    type={key === 'clientId' ? 'text' : 'url'}
                    placeholder={placeholder}
                    value={config.oidc[key]}
                    onChange={(event) =>
                      setConfig({ ...config, oidc: { ...config.oidc, [key]: event.target.value } })
                    }
                  />
                </label>
              ))}
              <label className="account-admin__field account-admin__secret">
                <span>{t('客户端密钥')}</span>
                <input
                  type="password"
                  value={clientSecret}
                  onChange={(event) => setSecret(event.target.value)}
                  autoComplete="new-password"
                  placeholder={t('留空则保留已保存值')}
                />
                <small>
                  {t(
                    config.oidc.hasClientSecret
                      ? '已保存客户端密钥，服务端不会返回明文。'
                      : '尚未保存客户端密钥。',
                  )}
                </small>
              </label>
            </div>
            <p className="account-admin__oidc-help">
              {t('OIDC 账号关联须由管理员单独核对和设置。启用前请核验全部端点与回调地址。')}
            </p>
          </details>
        </section>
      </fieldset>
      <footer className="account-admin__footer">
        <span className={dirty ? 'is-dirty' : ''}>
          {dirty ? (
            t('有未保存的更改')
          ) : (
            <>
              <Check size={14} />
              {t('配置已同步')}
            </>
          )}
        </span>
        <button type="submit" className="is-primary" disabled={busy || !dirty}>
          <Save size={15} />
          {t(busy ? '正在保存…' : '保存配置')}
        </button>
      </footer>
      {notice && (
        <p className="account-admin__result" role={notice === 'saved' ? 'status' : 'alert'}>
          {t(notice === 'saved' ? '配置已保存。启用的功能需要再进行实际邮件/提供商验收。' : '配置保存失败')}
          {notice === 'saveError' && detail ? ` ${detail}` : ''}
        </p>
      )}
    </form>
  );
}
