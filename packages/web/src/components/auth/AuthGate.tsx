import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { KeyRound, LogOut, Monitor, Settings2, ShieldCheck, UserRound } from 'lucide-react';
import { api, resetApiSession } from '../../services/api';
import './auth-toolbar.scss';
import { hasPermission, ROLES } from '../../../../../shared/permissions';
import Administration from '../administration/Administration';
import AccountSecurity from './AccountSecurity';
import { AccountAccess } from '../account/AccountAccess';
import { AccountCompletion } from '../account/AccountCompletion';
import { AccountSettings } from '../account/AccountSettings';
import { LanguageSwitcher, useLocale } from '../../locals';
import Modal from '../common/Modal';
import type {
  AuthStatus as Session,
  TurnstilePublicSettings as TurnstilePublic,
} from '../../../../../shared/auth';

type TurnstileApi = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  remove: (id: string) => void;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}
const card: CSSProperties = {
  padding: 24,
  border: '1px solid var(--line)',
  borderRadius: 8,
  background: 'var(--surface)',
};
const stack: CSSProperties = { display: 'grid', gap: 12 };
function message(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请重试。';
}

// Only remove keys owned by this app, never clear unrelated origin storage.
function prepareIdentity(identity: string) {
  try {
    const previous = localStorage.getItem('novel-auth-identity');
    // Installing this gate must not discard existing single-user preferences.
    if (identity === 'auth-disabled' && previous === null) return;
    if (previous !== identity || sessionStorage.getItem('novel-auth-identity') !== identity) {
      for (const storage of [localStorage, sessionStorage]) {
        const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
        for (const key of keys) {
          if (
            key &&
            key !== 'novel-auth-identity' &&
            key !== 'novel-locale' &&
            (key.startsWith('novel-') ||
              key.startsWith('platform-hidden:') ||
              key.startsWith('publication-auto-approve:'))
          )
            storage.removeItem(key);
        }
      }
      sessionStorage.setItem('novel-auth-identity', identity);
      localStorage.setItem('novel-auth-identity', identity);
    }
  } catch {
    /* Storage may be unavailable; identity transitions also reload all module state. */
  }
}

function Challenge({
  settings,
  attempt,
  token,
}: {
  settings: TurnstilePublic;
  attempt: number;
  token: (value: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const callback = useRef(token);
  callback.current = token;
  const [error, setError] = useState('');
  useEffect(() => {
    if (!settings.enabled) return;
    let disposed = false;
    let widget: string | undefined;
    setError('');
    callback.current('');
    const render = () => {
      if (disposed || !container.current || !window.turnstile) return;
      try {
        widget = window.turnstile.render(container.current, {
          sitekey: settings.siteKey,
          ...(settings.action ? { action: settings.action } : {}),
          callback: (value: string) => {
            if (!disposed) callback.current(value);
          },
          'expired-callback': () => callback.current(''),
          'error-callback': () => {
            callback.current('');
            setError('人机验证失败，请刷新验证后重试。');
          },
        });
      } catch {
        setError('无法初始化人机验证，请刷新页面。');
      }
    };
    const failed = () => setError('无法载入 Cloudflare 人机验证，请检查网络后刷新。');
    const src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    let script = document.querySelector<HTMLScriptElement>('script[data-novel-turnstile]');
    if (window.turnstile) render();
    else {
      if (!script) {
        script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.defer = true;
        script.dataset.novelTurnstile = 'true';
        document.head.appendChild(script);
      }
      script.addEventListener('load', render);
      script.addEventListener('error', failed);
    }
    return () => {
      disposed = true;
      script?.removeEventListener('load', render);
      script?.removeEventListener('error', failed);
      if (widget !== undefined) window.turnstile?.remove(widget);
    };
  }, [settings.enabled, settings.siteKey, settings.action, attempt]);
  return (
    <>
      <div ref={container} />
      {error && <p role="alert">{error}</p>}
    </>
  );
}

const accountRequest = <T,>(path: string, method = 'GET', body?: unknown): Promise<T> => {
  if (!path.startsWith('/api/auth/') && !path.startsWith('/api/admin/'))
    return Promise.reject(new Error('无效账户请求路径'));
  return api<T>(path.slice(4), { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
};

type Completion = { purpose: 'register' | 'reset' | 'email'; token: string };
function completionFromLocation(): Completion | undefined {
  if (window.location.pathname !== '/account/complete') return;
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const purpose = fragment.get('purpose');
  const token = fragment.get('token');
  if ((purpose === 'register' || purpose === 'reset' || purpose === 'email') && token)
    return { purpose, token };
}

function Login({ session }: { session: Session }) {
  const { t } = useLocale();
  const [pendingMfa, setPendingMfa] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [turnstileToken, setToken] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const token = turnstileToken;
    setToken('');
    try {
      const result = await api<Session | { mfaRequired: true }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password, ...(token ? { turnstileToken: token } : {}) }),
      });
      setPassword('');
      if ('mfaRequired' in result && result.mfaRequired) {
        setPendingMfa(true);
        return;
      }
      // A reload purges App's module-level pending-run caches as well as React state.
      window.location.reload();
    } catch (error) {
      setError(message(error));
    } finally {
      setPassword('');
      setAttempt((value) => value + 1);
      setBusy(false);
    }
  };
  return (
    <main style={{ maxWidth: 460, margin: '10vh auto', padding: 16 }}>
      <LanguageSwitcher />
      {pendingMfa ? (
        <div style={{ ...card, ...stack }}>
          <AccountAccess
            request={accountRequest}
            pendingMfa
            onAuthenticated={() => window.location.reload()}
          />
          <button type="button" onClick={() => setPendingMfa(false)}>
            {t('返回密码登录')}
          </button>
        </div>
      ) : (
        <>
          <form onSubmit={submit} style={{ ...card, ...stack }} aria-busy={busy}>
            <h1>{t('登录 Novel Agent')}</h1>
            <label style={stack}>
              {t('用户名')}
              <input
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
                disabled={busy}
              />
            </label>
            <label style={stack}>
              {t('密码')}
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                disabled={busy}
              />
            </label>
            <Challenge settings={session.turnstile} attempt={attempt} token={setToken} />
            {error && <p role="alert">{error}</p>}
            <button disabled={busy || (session.turnstile.enabled && !turnstileToken)}>
              {busy ? t('正在登录…') : t('登录')}
            </button>
          </form>
          <div style={{ ...card, marginTop: 16 }}>
            <AccountAccess
              request={accountRequest}
              turnstile={session.turnstile}
              renderChallenge={(attempt, token) => (
                <Challenge settings={session.turnstile} attempt={attempt} token={token} />
              )}
              onAuthenticated={() => window.location.reload()}
            />
          </div>
        </>
      )}
    </main>
  );
}

function CompletionPage({ session, completion }: { session: Session; completion?: Completion }) {
  const { t } = useLocale();
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const oidc = new URLSearchParams(window.location.search).get('oidc');
  const home = () => window.location.assign('/');
  useEffect(() => {
    if (oidc === 'success') home();
  }, [oidc]);
  return (
    <main style={{ ...card, ...stack, maxWidth: 480, margin: '10vh auto' }}>
      <LanguageSwitcher />
      <h1>{t('账户操作')}</h1>
      {done ? (
        <p role="status">{t('账户操作已完成，请返回登录。')}</p>
      ) : oidc === 'mfa' ? (
        <AccountAccess request={accountRequest} pendingMfa onAuthenticated={home} />
      ) : completion?.purpose === 'email' ? (
        session.enabled && session.authenticated ? (
          <>
            <p>{t('确认将此邮箱关联到当前登录的账户。')}</p>
            <button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError('');
                void accountRequest('/api/auth/account/email/complete', 'POST', { token: completion.token })
                  .then(() => setDone(true))
                  .catch((reason: unknown) => setError(message(reason)))
                  .finally(() => setBusy(false));
              }}
            >
              {t('确认邮箱')}
            </button>
            {error && <p role="alert">{error}</p>}
          </>
        ) : (
          <p role="status">
            {t('请先登录此邮箱所属的账户，再重新打开邮件中的原始链接。验证链接不会自动关联到其他账户。')}
          </p>
        )
      ) : completion ? (
        <AccountCompletion
          purpose={completion.purpose}
          token={completion.token}
          request={accountRequest}
          onComplete={() => setDone(true)}
        />
      ) : (
        <p role="alert">
          {oidc === 'failed'
            ? t('OIDC 登录失败，请返回登录后重试。')
            : oidc === 'success'
              ? t('正在返回应用…')
              : t('账户链接无效或已失效，请重新申请邮件。')}
        </p>
      )}
      <button type="button" onClick={home}>
        {t('返回应用 / 登录')}
      </button>
    </main>
  );
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  const [completion] = useState(completionFromLocation);
  useEffect(() => {
    if (window.location.pathname === '/account/complete' && window.location.hash)
      window.history.replaceState(
        window.history.state,
        '',
        window.location.pathname + window.location.search,
      );
  }, []);
  const [session, setSession] = useState<Session>();
  const [error, setError] = useState('');
  const [admin, setAdmin] = useState(false);
  const [account, setAccount] = useState(false);
  const [security, setSecurity] = useState(false);
  const [localAdmin, setLocalAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setError('');
    try {
      const next = await api<Session>('/auth/session');
      prepareIdentity(
        next.enabled ? (next.authenticated && next.user ? next.user.id : 'anonymous') : 'auth-disabled',
      );
      setSession(next);
    } catch (error) {
      setError(message(error));
    }
  };
  useEffect(() => {
    void refresh();
    const expired = () => {
      resetApiSession();
      window.location.reload();
    };
    const switched = (event: StorageEvent) => {
      if (event.key === 'novel-auth-identity') expired();
    };
    window.addEventListener('novel-auth-expired', expired);
    window.addEventListener('storage', switched);
    return () => {
      window.removeEventListener('novel-auth-expired', expired);
      window.removeEventListener('storage', switched);
    };
  }, []);
  useEffect(() => {
    setLocalAdmin(false);
    if (!session || session.enabled) return;
    const controller = new AbortController();
    void api<{ available: boolean; mode: string }>('/admin/session', { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setLocalAdmin(result.available === true && result.mode === 'local');
      })
      .catch(() => {
        /* Unavailable or non-local administration must not disrupt normal local usage. */
      });
    return () => controller.abort();
  }, [session]);
  if (!session)
    return (
      <main style={{ ...card, margin: '10vh auto', maxWidth: 480 }}>
        <LanguageSwitcher />
        <p role={error ? 'alert' : 'status'}>{error || t('正在检查登录状态…')}</p>
        {error && <button onClick={() => void refresh()}>{t('重试')}</button>}
      </main>
    );
  if (window.location.pathname === '/account/complete')
    return <CompletionPage session={session} completion={completion} />;
  if (!session.enabled)
    return (
      <>
        {localAdmin ? (
          <div className="auth-toolbar auth-toolbar--local" role="region" aria-label={t('本机模式状态')}>
            <div className="auth-toolbar__identity">
              <span className="auth-toolbar__emblem" aria-hidden="true">
                <Monitor size={18} />
              </span>
              <span className="auth-toolbar__copy">
                <span className="auth-toolbar__pill">
                  <span className="auth-toolbar__dot" />
                  {t('本机模式')}
                </span>
                <span className="auth-toolbar__caption">{t('登录认证已关闭 · 仅供本机使用')}</span>
              </span>
            </div>
            <div className="auth-toolbar__actions">
              <LanguageSwitcher />
              <button
                className="auth-toolbar__button auth-toolbar__button--primary"
                type="button"
                onClick={() => setAdmin(true)}
              >
                <Settings2 size={16} aria-hidden="true" />
                <span>{t('管理控制台')}</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="auth-toolbar">
            <LanguageSwitcher />
          </div>
        )}
        {children}
        {localAdmin && admin && <Administration close={() => setAdmin(false)} mode="local" />}
      </>
    );
  if (!session.authenticated || !session.user) return <Login session={session} />;
  const user = session.user;
  const logout = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api('/auth/logout', { method: 'POST' });
      window.location.reload();
    } catch (error) {
      setError(message(error));
      setBusy(false);
    }
  };
  return (
    <div key={user.id}>
      <div className="auth-toolbar auth-toolbar--account" role="region" aria-label={t('账户状态与操作')}>
        <div className="auth-toolbar__identity">
          <span className="auth-toolbar__emblem" aria-hidden="true">
            <UserRound size={18} />
          </span>
          <span className="auth-toolbar__copy">
            <span className="auth-toolbar__username" title={user.username}>
              {user.username}
            </span>
            <span className="auth-toolbar__pill">
              <span className="auth-toolbar__dot" />
              {ROLES[user.role]?.label ?? '未知角色'}
            </span>
          </span>
        </div>
        <div className="auth-toolbar__actions">
          <LanguageSwitcher />
          {hasPermission(user.role, 'admin.access') && (
            <button
              className="auth-toolbar__button auth-toolbar__button--primary"
              type="button"
              onClick={() => setAdmin(true)}
            >
              <Settings2 size={16} aria-hidden="true" />
              <span>{t('管理控制台')}</span>
            </button>
          )}
          <button className="auth-toolbar__button" type="button" onClick={() => setAccount(true)}>
            <KeyRound size={16} aria-hidden="true" />
            <span>{t('邮箱与双重验证')}</span>
          </button>
          <button className="auth-toolbar__button" type="button" onClick={() => setSecurity(true)}>
            <ShieldCheck size={16} aria-hidden="true" />
            <span>{t('账号安全')}</span>
          </button>
          <button
            className="auth-toolbar__button auth-toolbar__button--logout"
            type="button"
            onClick={() => void logout()}
            disabled={busy}
          >
            <LogOut size={16} aria-hidden="true" />
            <span>{busy ? t('正在退出…') : t('退出登录')}</span>
          </button>
        </div>
        {error && (
          <span className="auth-toolbar__error" role="alert">
            {error}
          </span>
        )}
      </div>
      {children}
      {admin && hasPermission(user.role, 'admin.access') && (
        <Administration close={() => setAdmin(false)} mode="authenticated" />
      )}
      {security && <AccountSecurity close={() => setSecurity(false)} />}
      {account && (
        <Modal title={t('邮箱与双重验证')} close={() => setAccount(false)} className="administration">
          <AccountSettings request={accountRequest} onSessionRevoked={() => window.location.reload()} />
        </Modal>
      )}
    </div>
  );
}
