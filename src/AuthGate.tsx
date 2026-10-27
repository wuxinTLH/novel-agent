import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { api, resetApiSession } from './api';
import Modal from './components/Modal';

import type {
  AuthStatus as Session,
  AuthUser as User,
  AuthRole,
  TurnstilePublicSettings as TurnstilePublic,
  TurnstileAdminSettings as TurnstileSettings,
} from '../shared/auth';
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

function Administration({ close }: { close: () => void }) {
  const [users, setUsers] = useState<User[]>([]);
  const [config, setConfig] = useState<TurnstileSettings>();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [role, setRole] = useState<AuthRole>('user');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = async () => {
    const [result, settings] = await Promise.all([
      api<User[] | { users: User[] }>('/auth/users'),
      api<TurnstileSettings>('/auth/turnstile'),
    ]);
    setUsers(Array.isArray(result) ? result : result.users);
    setConfig(settings);
  };
  useEffect(() => {
    void load().catch((error) => setError(message(error)));
  }, []);
  const run = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation();
      await load();
      setNotice('已保存。');
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
      setPassword('');
      setSecretKey('');
    }
  };
  return (
    <Modal title="用户与登录安全" close={close} busy={busy} error={error} wide>
      <div style={stack}>
        {notice && <p role="status">{notice}</p>}
        <h3>用户管理</h3>
        <p>新用户使用独立数据空间；超级管理员不能在此停用。</p>
        <ul style={{ paddingLeft: 20 }}>
          {users.map((user) => (
            <li key={user.id} style={{ marginBottom: 10 }}>
              {user.username} · {user.role} · {user.disabled ? '已停用' : '正常'}{' '}
              {user.role !== 'superadmin' && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      api(`/auth/users/${encodeURIComponent(user.id)}`, {
                        method: 'PATCH',
                        body: JSON.stringify({ disabled: !user.disabled }),
                      }),
                    )
                  }
                >
                  {user.disabled ? '启用' : '停用'}
                </button>
              )}
            </li>
          ))}
        </ul>
        <form
          style={stack}
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await api('/auth/users', {
                method: 'POST',
                body: JSON.stringify({ username, password, role }),
              });
              setUsername('');
            });
          }}
        >
          <label style={stack}>
            新用户名
            <input
              value={username}
              autoComplete="off"
              onChange={(event) => setUsername(event.target.value)}
              required
              disabled={busy}
            />
          </label>
          <label style={stack}>
            初始密码
            <input
              type="password"
              value={password}
              autoComplete="new-password"
              onChange={(event) => setPassword(event.target.value)}
              required
              disabled={busy}
            />
          </label>
          <label style={stack}>
            角色
            <select
              value={role}
              onChange={(event) => setRole(event.target.value as AuthRole)}
              disabled={busy}
            >
              <option value="user">普通用户</option>
              <option value="superadmin">超级管理员</option>
            </select>
          </label>
          <button disabled={busy}>创建用户</button>
        </form>
        <h3>Cloudflare Turnstile</h3>
        {config ? (
          <form
            style={stack}
            onSubmit={(event) => {
              event.preventDefault();
              void run(() =>
                api('/auth/turnstile', {
                  method: 'PUT',
                  body: JSON.stringify({
                    enabled: config.enabled,
                    siteKey: config.siteKey,
                    action: config.action || '',
                    hostname: config.hostname || '',
                    ...(secretKey ? { secret: secretKey } : {}),
                  }),
                }),
              );
            }}
          >
            <label>
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(event) => setConfig({ ...config, enabled: event.target.checked })}
                disabled={busy}
              />{' '}
              启用登录人机验证
            </label>
            <label style={stack}>
              Site Key
              <input
                value={config.siteKey || ''}
                onChange={(event) => setConfig({ ...config, siteKey: event.target.value })}
                disabled={busy}
              />
            </label>
            <label style={stack}>
              Secret Key（留空保留现有值）
              <input
                type="password"
                autoComplete="new-password"
                value={secretKey}
                onChange={(event) => setSecretKey(event.target.value)}
                disabled={busy}
              />
            </label>
            <p>服务端密钥{config.hasSecret ? '已配置' : '未配置'}；密钥不会回显或写入浏览器存储。</p>
            <label style={stack}>
              预期 Action
              <input
                value={config.action || ''}
                onChange={(event) => setConfig({ ...config, action: event.target.value })}
                disabled={busy}
              />
            </label>
            <label style={stack}>
              预期 Hostname
              <input
                value={config.hostname || ''}
                onChange={(event) => setConfig({ ...config, hostname: event.target.value })}
                disabled={busy}
              />
            </label>
            <p>
              请先在 Cloudflare 配置合法域名，并确认 Site Key、Secret Key、Action 和 Hostname
              相互匹配，避免无法登录。
            </p>
            <button disabled={busy}>保存验证设置</button>
          </form>
        ) : (
          <p role="status">正在加载设置…</p>
        )}
      </div>
    </Modal>
  );
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>();
  const [error, setError] = useState('');
  const [admin, setAdmin] = useState(false);
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
  if (!session)
    return (
      <main style={{ ...card, margin: '10vh auto', maxWidth: 480 }}>
        <p role={error ? 'alert' : 'status'}>{error || '正在检查登录状态…'}</p>
        {error && <button onClick={() => void refresh()}>重试</button>}
      </main>
    );
  if (!session.enabled) return <>{children}</>;
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
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          justifyContent: 'flex-end',
          padding: '8px 16px',
          background: 'var(--surface)',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <span>
          {user.username} · {user.role}
        </span>
        {user.role === 'superadmin' && <button onClick={() => setAdmin(true)}>用户与登录安全</button>}
        <button onClick={() => void logout()} disabled={busy}>
          退出登录
        </button>
        {error && <span role="alert">{error}</span>}
      </div>
      {children}
      {admin && <Administration close={() => setAdmin(false)} />}
    </div>
  );
}
