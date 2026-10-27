import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { api, resetApiSession } from '../../services/api';
import Administration from '../administration/Administration';
import AccountSecurity from './AccountSecurity';
import type { AuthStatus as Session, TurnstilePublicSettings as TurnstilePublic } from '../../../../../shared/auth';

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
const toolbar: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 12,
  alignItems: 'center',
  justifyContent: 'flex-end',
  padding: '8px 16px',
  background: 'var(--surface)',
  borderBottom: '1px solid var(--line)',
};
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

function Login({ session }: { session: Session }) {
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
      await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password, ...(token ? { turnstileToken: token } : {}) }),
      });
      setPassword('');
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
      <form onSubmit={submit} style={{ ...card, ...stack }} aria-busy={busy}>
        <h1>登录 Novel Agent</h1>
        <label style={stack}>
          用户名
          <input
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
            disabled={busy}
          />
        </label>
        <label style={stack}>
          密码
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
          {busy ? '正在登录…' : '登录'}
        </button>
      </form>
    </main>
  );
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>();
  const [error, setError] = useState('');
  const [admin, setAdmin] = useState(false);
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
        <p role={error ? 'alert' : 'status'}>{error || '正在检查登录状态…'}</p>
        {error && <button onClick={() => void refresh()}>重试</button>}
      </main>
    );
  if (!session.enabled)
    return (
      <>
        {localAdmin && (
          <div style={toolbar}>
            <span>本机模式 · 登录认证关闭</span>
            <button type="button" onClick={() => setAdmin(true)}>
              管理控制台
            </button>
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
      <div style={toolbar}>
        <span>
          {user.username} · {user.role}
        </span>
        {user.role === 'superadmin' && (
          <button type="button" onClick={() => setAdmin(true)}>
            管理控制台
          </button>
        )}
        <button type="button" onClick={() => setSecurity(true)}>
          账号安全
        </button>
        <button type="button" onClick={() => void logout()} disabled={busy}>
          退出登录
        </button>
        {error && <span role="alert">{error}</span>}
      </div>
      {children}
      {admin && <Administration close={() => setAdmin(false)} mode="authenticated" />}
      {security && <AccountSecurity close={() => setSecurity(false)} />}
    </div>
  );
}
