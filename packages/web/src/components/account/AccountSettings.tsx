import { useEffect, useState, type FormEvent } from 'react';
import type {
  AccountFeatures,
  AccountSettings as Settings,
  MfaEnrollment,
} from '../../../../../shared/account';

/** Parent supplies its existing same-origin API/CSRF client; this component never stores credentials. */
export interface AccountSettingsProps {
  request<T>(path: string, method?: string, body?: unknown): Promise<T>;
  onSessionRevoked(): void;
}
export function AccountSettings({ request, onSessionRevoked }: AccountSettingsProps) {
  const [settings, setSettings] = useState<Settings>();
  const [features, setFeatures] = useState<AccountFeatures>();
  const [email, setEmail] = useState(''),
    [token, setToken] = useState(''),
    [code, setCode] = useState('');
  const [enrollment, setEnrollment] = useState<MfaEnrollment>();
  const [codes, setCodes] = useState<string[]>([]),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    Promise.all([
      request<Settings>('/api/auth/account'),
      request<AccountFeatures>('/api/auth/account/features'),
    ])
      .then(([s, f]) => {
        if (active) {
          setSettings(s);
          setFeatures(f);
          setEmail(s.email);
        }
      })
      .catch(() => {
        if (active) setMessage('无法读取账户设置');
      });
    return () => {
      active = false;
    };
  }, [request]);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }
  const submitEmail = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await request('/api/auth/account/email', 'POST', { email });
      setMessage('验证邮件已发送，请复制邮件中的令牌完成验证。');
    });
  };
  return (
    <section aria-label="账户安全">
      <h2>账户安全</h2>
      <p role="status">{message}</p>
      {settings && (
        <p>
          邮箱：{settings.email || '未设置'}（{settings.emailVerified ? '已验证' : '未验证'}）；双重验证：
          {settings.mfaEnabled ? '已开启' : '未开启'}
        </p>
      )}
      {features?.emailVerification && (
        <>
          <form onSubmit={submitEmail}>
            <label>
              邮箱{' '}
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </label>
            <button disabled={busy}>发送验证邮件</button>
          </form>
          <label>
            验证令牌 <input value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          </label>
          <button
            disabled={busy || !token}
            onClick={() =>
              void run(async () => {
                await request('/api/auth/account/email/complete', 'POST', { token });
                setToken('');
                setSettings(await request<Settings>('/api/auth/account'));
                setMessage('邮箱已验证');
              })
            }
          >
            确认邮箱
          </button>
        </>
      )}
      {features?.mfa && !settings?.mfaEnabled && !enrollment && (
        <button
          disabled={busy}
          onClick={() =>
            void run(async () =>
              setEnrollment(await request<MfaEnrollment>('/api/auth/account/mfa/setup', 'POST', {})),
            )
          }
        >
          设置验证器
        </button>
      )}
      {enrollment && (
        <div>
          <p>将以下密钥导入 TOTP 验证器。不要分享或截图密钥。</p>
          <code>{enrollment.secret}</code>
          <p>密钥只在此显示，验证成功会退出所有会话。</p>
          <label>
            验证码{' '}
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
            />
          </label>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await request<{ recoveryCodes: string[] }>(
                  '/api/auth/account/mfa/enable',
                  'POST',
                  { token: enrollment.token, code },
                );
                setCodes(result.recoveryCodes);
                setEnrollment(undefined);
                setCode('');
                setMessage('已启用。请保存一次性恢复码，再返回登录。');
              })
            }
          >
            确认启用
          </button>
        </div>
      )}
      {codes.length > 0 && (
        <div>
          <h3>一次性恢复码（仅显示一次）</h3>
          <pre>{codes.join('\n')}</pre>
          <button
            onClick={() => {
              setCodes([]);
              onSessionRevoked();
            }}
          >
            已安全保存，返回登录
          </button>
        </div>
      )}
      {features?.mfa && settings?.mfaEnabled && (
        <div>
          <p>剩余恢复码：{settings.recoveryCodesRemaining}</p>
          <label>
            验证码或恢复码{' '}
            <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" />
          </label>
          <button
            disabled={busy || !code}
            onClick={() =>
              void run(async () => {
                await request('/api/auth/account/mfa', 'DELETE', { code });
                setCode('');
                onSessionRevoked();
              })
            }
          >
            关闭双重验证并退出
          </button>
        </div>
      )}
    </section>
  );
}
