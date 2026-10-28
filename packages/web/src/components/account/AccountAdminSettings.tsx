import { useEffect, useState, type FormEvent } from 'react';
import type { AccountAdminConfig } from '../../../../../shared/account';

/** Mount only inside the existing administrator-authenticated settings area. */
export function AccountAdminSettings({
  request,
}: {
  request<T>(path: string, method?: string, body?: unknown): Promise<T>;
}) {
  const [config, setConfig] = useState<AccountAdminConfig>(),
    [clientSecret, setSecret] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    request<AccountAdminConfig>('/api/admin/account/config')
      .then((value) => {
        if (active) setConfig(value);
      })
      .catch(() => {
        if (active) setMessage('无法读取账户配置');
      });
    return () => {
      active = false;
    };
  }, [request]);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!config || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await request<AccountAdminConfig>('/api/admin/account/config', 'PUT', {
        ...config,
        oidc: { ...config.oidc, hasClientSecret: undefined, ...(clientSecret ? { clientSecret } : {}) },
      });
      setConfig(result);
      setSecret('');
      setMessage('配置已保存。启用的功能需要再进行实际邮件/提供商验收。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '配置保存失败');
    } finally {
      setBusy(false);
    }
  }
  if (!config) return <p role="status">{message || '正在读取账户配置…'}</p>;
  const flag = (key: 'registration' | 'emailVerification' | 'passwordRecovery' | 'mfa') => (
    <label key={key}>
      <input
        type="checkbox"
        checked={config[key]}
        onChange={(e) => setConfig({ ...config, [key]: e.target.checked })}
      />
      {
        (
          {
            registration: '允许邮箱确认后注册',
            emailVerification: '允许用户验证邮箱',
            passwordRecovery: '允许邮件找回密码',
            mfa: '启用双重验证',
          } as const
        )[key]
      }
    </label>
  );
  const oidc = (
    key: 'issuer' | 'clientId' | 'authorizationEndpoint' | 'tokenEndpoint' | 'jwksUri' | 'redirectUri',
    label: string,
  ) => (
    <label key={key}>
      {label}{' '}
      <input
        value={config.oidc[key]}
        onChange={(e) => setConfig({ ...config, oidc: { ...config.oidc, [key]: e.target.value } })}
      />
    </label>
  );
  return (
    <form onSubmit={save}>
      <h2>账户功能配置</h2>
      <p>默认全部关闭。邮件功能需要服务端 SMTP 配置。不会自动启用全局认证。</p>
      {(['registration', 'emailVerification', 'passwordRecovery', 'mfa'] as const).map(flag)}
      <label>
        公开站点 HTTPS 地址{' '}
        <input
          type="url"
          value={config.publicOrigin}
          onChange={(e) => setConfig({ ...config, publicOrigin: e.target.value })}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={config.oidc.enabled}
          onChange={(e) => setConfig({ ...config, oidc: { ...config.oidc, enabled: e.target.checked } })}
        />
        启用 OIDC 登录
      </label>
      {oidc('issuer', '签发者')}
      {oidc('clientId', '客户端 ID')}
      {oidc('authorizationEndpoint', '授权端点')}
      {oidc('tokenEndpoint', '令牌端点')}
      {oidc('jwksUri', 'JWKS 地址')}
      {oidc('redirectUri', '回调地址')}
      <label>
        客户端密钥（留空则保留已保存值）{' '}
        <input
          type="password"
          value={clientSecret}
          onChange={(e) => setSecret(e.target.value)}
          autoComplete="new-password"
        />
      </label>
      <p>
        已保存客户端密钥：{config.oidc.hasClientSecret ? '是' : '否'}。OIDC 账号关联须由管理员单独核对和设置。
      </p>
      <p role="status">{message}</p>
      <button disabled={busy}>保存配置</button>
    </form>
  );
}
