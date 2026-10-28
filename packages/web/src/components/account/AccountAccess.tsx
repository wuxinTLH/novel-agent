import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { TurnstilePublicSettings } from '../../../../../shared/auth';
import type { AccountFeatures } from '../../../../../shared/account';

/** Adjacent to existing login UI. Parent request must obtain/retain prelogin CSRF cookies. */
export function AccountAccess({
  request,
  pendingMfa = false,
  onAuthenticated,
  turnstile,
  renderChallenge,
}: {
  request<T>(path: string, method?: string, body?: unknown): Promise<T>;
  pendingMfa?: boolean;
  turnstile?: TurnstilePublicSettings;
  renderChallenge?: (attempt: number, onToken: (token: string) => void) => ReactNode;
  onAuthenticated(result: unknown): void;
}) {
  const [features, setFeatures] = useState<AccountFeatures>();
  const [mode, setMode] = useState<'register' | 'reset'>('reset');
  const [turnstileToken, setTurnstileToken] = useState(''),
    [attempt, setAttempt] = useState(0);
  const [username, setUsername] = useState(''),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [code, setCode] = useState('');
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    request<AccountFeatures>('/api/auth/account/features')
      .then((v) => {
        if (active) {
          setFeatures(v);
          setMode(v.passwordRecovery ? 'reset' : 'register');
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [request]);
  async function perform(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '账户操作失败');
    } finally {
      setBusy(false);
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    void perform(async () => {
      if (pendingMfa) {
        const result = await request('/api/auth/account/mfa/verify', 'POST', { code });
        setCode('');
        onAuthenticated(result);
        return;
      }
      if (mode === 'register' && turnstile?.enabled && !turnstileToken) throw new Error('请先完成人机验证');
      try {
        await request(
          `/api/auth/account/${mode === 'register' ? 'register' : 'recovery'}`,
          'POST',
          mode === 'register'
            ? { username, email, password, ...(turnstile?.enabled ? { turnstileToken } : {}) }
            : { email },
        );
      } finally {
        if (mode === 'register') {
          setTurnstileToken('');
          setAttempt((v) => v + 1);
        }
      }
      setPassword('');
      setMessage('如果请求可以处理，验证邮件将发送到该邮箱。请检查邮件。');
    });
  }
  if (pendingMfa)
    return (
      <form onSubmit={submit}>
        <h2>双重验证</h2>
        <label>
          验证器验证码或一次性恢复码{' '}
          <input
            required
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        <p role="status">{message}</p>
        <button disabled={busy}>验证并登录</button>
      </form>
    );
  return (
    <section aria-label="其他账户入口">
      {features?.oidc && (
        <button
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const result = await request<{ url: string }>('/api/auth/account/oidc/start', 'POST', {});
              const url = new URL(result.url);
              if (url.protocol !== 'https:') throw new Error('无效提供商地址');
              window.location.assign(url.href);
            })
          }
        >
          使用 OIDC 登录
        </button>
      )}
      {(features?.registration || features?.passwordRecovery) && (
        <>
          <nav aria-label="账户操作">
            {features.registration && (
              <button type="button" onClick={() => setMode('register')}>
                注册账户
              </button>
            )}
            {features.passwordRecovery && (
              <button type="button" onClick={() => setMode('reset')}>
                找回密码
              </button>
            )}
          </nav>
          <form onSubmit={submit}>
            <h3>{mode === 'register' ? '注册账户（需验证邮箱）' : '找回密码'}</h3>
            {mode === 'register' && (
              <label>
                用户名{' '}
                <input
                  required
                  pattern="[a-z0-9][a-z0-9_.-]{2,63}"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </label>
            )}
            <label>
              邮箱{' '}
              <input
                required
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            {mode === 'register' && (
              <label>
                密码{' '}
                <input
                  required
                  type="password"
                  minLength={12}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
            )}
            {mode === 'register' &&
              turnstile?.enabled &&
              (renderChallenge ? (
                renderChallenge(attempt, setTurnstileToken)
              ) : (
                <p role="alert">无法载入人机验证，请联系管理员。</p>
              ))}
            <button
              disabled={
                busy ||
                (mode === 'register'
                  ? !features.registration || (!!turnstile?.enabled && (!renderChallenge || !turnstileToken))
                  : !features.passwordRecovery)
              }
            >
              发送验证邮件
            </button>
          </form>
        </>
      )}
      <p role="status">{message}</p>
    </section>
  );
}
