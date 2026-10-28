import { useState, type FormEvent } from 'react';
/** Public registration/recovery completion. Parent must supply the prelogin CSRF client. */
export function AccountCompletion({
  purpose,
  token,
  request,
  onComplete,
}: {
  purpose: 'register' | 'reset';
  token: string;
  request(path: string, method: string, body: unknown): Promise<unknown>;
  onComplete(): void;
}) {
  const [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await request(`/api/auth/account/${purpose === 'reset' ? 'recovery' : 'register'}/complete`, 'POST', {
        token,
        ...(purpose === 'reset' ? { password } : {}),
      });
      setPassword('');
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : '令牌无效或已过期');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <h2>{purpose === 'reset' ? '设置新密码' : '确认注册'}</h2>
      <p>此链接只能使用一次；不会自动登录。</p>
      {purpose === 'reset' && (
        <label>
          新密码{' '}
          <input
            type="password"
            minLength={12}
            required
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
      )}
      <p role="alert">{error}</p>
      <button disabled={busy}>确认</button>
    </form>
  );
}
