import { useLocale } from '../../locals';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { TurnstilePublicSettings } from '../../../../../shared/auth';
import type { AccountFeatures } from '../../../../../shared/account';

/** Adjacent to existing login UI. Parent request must obtain/retain prelogin CSRF cookies. */
export function AccountAccess({
  request,
  pendingMfa = false,
  pendingSms = false,
  onMfaRequired,
  onAuthenticated,
  turnstile,
  renderChallenge,
}: {
  request<T>(path: string, method?: string, body?: unknown): Promise<T>;
  pendingMfa?: boolean;
  pendingSms?: boolean;
  onMfaRequired?: () => void;
  turnstile?: TurnstilePublicSettings;
  renderChallenge?: (attempt: number, onToken: (token: string) => void) => ReactNode;
  onAuthenticated(result: unknown): void;
}) {
  const { t } = useLocale();
  const [features, setFeatures] = useState<AccountFeatures>();
  const [mode, setMode] = useState<'register' | 'reset'>('reset');
  const [turnstileToken, setTurnstileToken] = useState(''),
    [attempt, setAttempt] = useState(0);
  const [username, setUsername] = useState(''),
    [email, setEmail] = useState(''),
    [phone, setPhone] = useState(''),
    [password, setPassword] = useState(''),
    [code, setCode] = useState('');
  const [registrationSmsSent, setRegistrationSmsSent] = useState(false),
    [registrationSmsVerified, setRegistrationSmsVerified] = useState(false),
    [smsSent, setSmsSent] = useState(false);
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
      setMessage(e instanceof Error ? e.message : t("账户操作失败"));
    } finally {
      setBusy(false);
    }
  }
  function challengeToken() {
    if (turnstile?.enabled && !turnstileToken) throw new Error(t("请先完成人机验证"));
    return turnstile?.enabled ? { turnstileToken } : {};
  }
  async function sendSms() {
    const token = challengeToken();
    try {
      if (pendingSms) {
        await request('/api/auth/account/sms/request', 'POST', token);
        setSmsSent(true);
      } else {
        await request('/api/auth/account/register/sms/request', 'POST', { username, email, phone, ...token });
        setRegistrationSmsSent(true);
        setRegistrationSmsVerified(false);
      }
      setCode('');
      setMessage(t("验证码已发送，请检查手机短信。"));
    } finally {
      setTurnstileToken('');
      setAttempt((v) => v + 1);
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
      if (pendingSms) {
        const result = await request<{ mfaRequired?: boolean }>('/api/auth/account/sms/verify', 'POST', {
          code,
        });
        setCode('');
        if (result.mfaRequired) onMfaRequired?.();
        else onAuthenticated(result);
        return;
      }
      if (mode === 'register' && features?.smsRequired && !registrationSmsVerified)
        throw new Error(t("请先完成手机短信验证"));
      const token = mode === 'register' ? challengeToken() : {};
      try {
        await request(
          `/api/auth/account/${mode === 'register' ? 'register' : 'recovery'}`,
          'POST',
          mode === 'register'
            ? { username, email, password, ...(features?.smsRequired ? { phone } : {}), ...token }
            : { email },
        );
      } finally {
        if (mode === 'register') {
          setTurnstileToken('');
          setAttempt((v) => v + 1);
        }
      }
      setPassword('');
      setMessage(t("如果请求可以处理，验证邮件将发送到该邮箱。请检查邮件。"));
    });
  }
  if (pendingSms)
    return (
      <section aria-label={t("短信登录验证")}>
        <h2>{t("手机短信验证")}</h2>
        <p>{t("请输入绑定手机收到的一次性验证码。")}</p>
        {turnstile?.enabled &&
          (renderChallenge ? (
            renderChallenge(attempt, setTurnstileToken)
          ) : (
            <p role="alert">{t("无法载入人机验证，请联系管理员。")}</p>
          ))}
        <button
          type="button"
          disabled={busy || (!!turnstile?.enabled && (!renderChallenge || !turnstileToken))}
          onClick={() => void perform(sendSms)}
        >
          {smsSent ? t("重新发送验证码") : t("发送验证码")}
        </button>
        {smsSent && (
          <form onSubmit={submit}>
            <label>{t("短信验证码")}{' '}
              <input
                required
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
            <button disabled={busy}>{t("验证并登录")}</button>
          </form>
        )}
        <p role="status">{message}</p>
      </section>
    );
  if (pendingMfa)
    return (
      <form onSubmit={submit}>
        <h2>{t("双重验证")}</h2>
        <label>{t("验证器验证码或一次性恢复码")}{' '}
          <input
            required
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        <p role="status">{message}</p>
        <button disabled={busy}>{t("验证并登录")}</button>
      </form>
    );
  return (
    <section aria-label={t("其他账户入口")}>
      {features?.oidc && (
        <button
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const result = await request<{ url: string }>('/api/auth/account/oidc/start', 'POST', {});
              const url = new URL(result.url);
              if (url.protocol !== 'https:') throw new Error(t("无效提供商地址"));
              window.location.assign(url.href);
            })
          }
        >{t("使用 OIDC 登录")}</button>
      )}
      {(features?.registration || features?.passwordRecovery) && (
        <>
          <nav aria-label={t("账户操作")}>
            {features.registration && (
              <button type="button" onClick={() => setMode('register')}>{t("注册账户")}</button>
            )}
            {features.passwordRecovery && (
              <button type="button" onClick={() => setMode('reset')}>{t("找回密码")}</button>
            )}
          </nav>
          <form onSubmit={submit}>
            <h3>{mode === 'register' ? t("注册账户（需验证邮箱）") : t("找回密码")}</h3>
            {mode === 'register' && (
              <label>{t("用户名")}{' '}
                <input
                  required
                  pattern="[a-z0-9][a-z0-9_.-]{2,63}"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value);
                    setRegistrationSmsSent(false);
                    setRegistrationSmsVerified(false);
                  }}
                />
              </label>
            )}
            <label>{t("邮箱")}{' '}
              <input
                required
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setRegistrationSmsSent(false);
                  setRegistrationSmsVerified(false);
                }}
              />
            </label>
            {mode === 'register' && features?.smsRequired && (
              <>
                <label>{t("手机号码（含国家码）")}{' '}
                  <input
                    required
                    type="tel"
                    autoComplete="tel"
                    pattern="\+[1-9][0-9]{7,14}"
                    placeholder="+8613800138000"
                    value={phone}
                    onChange={(e) => {
                      setPhone(e.target.value);
                      setRegistrationSmsSent(false);
                      setRegistrationSmsVerified(false);
                    }}
                  />
                </label>
                <p>{t("请填写国际格式手机号码，例如 +8613800138000。")}</p>
              </>
            )}
            {mode === 'register' && (
              <label>{t("密码")}{' '}
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
                <p role="alert">{t("无法载入人机验证，请联系管理员。")}</p>
              ))}
            {mode === 'register' && features?.smsRequired && (
              <div>
                <button
                  type="button"
                  disabled={
                    busy ||
                    !/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(username) ||
                    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ||
                    !/^\+[1-9][0-9]{7,14}$/.test(phone) ||
                    (!!turnstile?.enabled && (!renderChallenge || !turnstileToken))
                  }
                  onClick={() => void perform(sendSms)}
                >
                  {registrationSmsSent ? t("重新发送短信验证码") : t("发送短信验证码")}
                </button>
                {registrationSmsSent && !registrationSmsVerified && (
                  <>
                    <label>{t("短信验证码")}{' '}
                      <input
                        autoComplete="one-time-code"
                        inputMode="numeric"
                        pattern="[0-9]{6}"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      disabled={busy || !/^[0-9]{6}$/.test(code)}
                      onClick={() =>
                        void perform(async () => {
                          await request('/api/auth/account/register/sms/verify', 'POST', { code });
                          setCode('');
                          setRegistrationSmsVerified(true);
                          setMessage(t("手机号码已验证，请完成人机验证并提交注册。"));
                        })
                      }
                    >{t("验证手机号")}</button>
                  </>
                )}
                {registrationSmsVerified && <p role="status">{t("手机号码已验证")}</p>}
              </div>
            )}
            <button
              disabled={
                busy ||
                (mode === 'register'
                  ? !features.registration ||
                    (!!features.smsRequired && !registrationSmsVerified) ||
                    (!!turnstile?.enabled && (!renderChallenge || !turnstileToken))
                  : !features.passwordRecovery)
              }
            >{t("发送验证邮件")}</button>
          </form>
        </>
      )}
      <p role="status">{message}</p>
    </section>
  );
}
