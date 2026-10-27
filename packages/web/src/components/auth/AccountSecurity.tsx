import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../../services/api';
import Modal from '../common/Modal';
import { useConfirm } from '../common/AppDialog';
import type { AuthSessionInfo } from '../../../../../shared/auth';
import '../../styles/administration.scss';

export default function AccountSecurity({ close }: { close: () => void }) {
  const confirm = useConfirm();
  const [sessions, setSessions] = useState<AuthSessionInfo[]>([]);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [repeatPassword, setRepeatPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const gate = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api<AuthSessionInfo[] | { sessions: AuthSessionInfo[] }>('/auth/sessions', {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setSessions(Array.isArray(value) ? value : value.sessions);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : '无法读取登录会话。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision]);
  const run = async (operation: () => Promise<unknown>) => {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setError('');
    try {
      await operation();
      window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '请求失败，请重试。');
    } finally {
      gate.current = false;
      setBusy(false);
      setCurrentPassword('');
      setNewPassword('');
      setRepeatPassword('');
    }
  };
  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword !== repeatPassword) {
      setError('两次输入的新密码不一致。');
      return;
    }
    if (
      !(await confirm('修改密码后将撤销所有登录会话，并返回登录页面。确定继续？', {
        title: '修改我的密码',
        confirmText: '修改并重新登录',
        danger: true,
      }))
    )
      return;
    await run(() =>
      api('/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
    );
  };
  return (
    <Modal
      title="账号安全"
      description="管理自己的密码与登录会话。"
      close={close}
      busy={busy}
      dirty={!!(currentPassword || newPassword || repeatPassword)}
      error={error}
      className="administration"
    >
      <div className="administration-stack">
        <form className="administration-card" onSubmit={(event) => void changePassword(event)}>
          <h3>修改我的密码</h3>
          <p>需要验证当前密码。修改成功后会退出全部设备，请使用新密码重新登录。</p>
          <fieldset className="administration-fields" disabled={busy}>
            <label className="administration-full">
              当前密码
              <input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                required
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </label>
            <label>
              新密码
              <input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                required
                minLength={12}
                maxLength={1024}
                onChange={(event) => setNewPassword(event.target.value)}
              />
              <small>至少 12 个字符；最终策略以服务端为准。</small>
            </label>
            <label>
              再次输入新密码
              <input
                type="password"
                autoComplete="new-password"
                value={repeatPassword}
                required
                minLength={12}
                maxLength={1024}
                onChange={(event) => setRepeatPassword(event.target.value)}
              />
            </label>
            <div className="administration-actions administration-full">
              <button type="submit" className="is-primary">
                修改密码
              </button>
            </div>
          </fieldset>
        </form>
        <section className="administration-card">
          <div className="administration-section-heading">
            <h3>我的登录会话</h3>
            <button
              type="button"
              disabled={loading || busy}
              onClick={() => setRevision((value) => value + 1)}
            >
              刷新
            </button>
          </div>
          <p>仅展示非凭据会话标识，不显示 Cookie、令牌或密码。</p>
          {loading && <p role="status">正在读取登录会话…</p>}
          <ul className="administration-sessions">
            {sessions.map((session) => (
              <li key={session.id}>
                <span>
                  {session.current ? '当前会话' : '其他登录会话'}
                  <small>到期 {new Date(session.expiresAt).toLocaleString()}</small>
                </span>
                <code>{session.id}</code>
              </li>
            ))}
          </ul>
          {!loading && !sessions.length && <p>暂无可显示的会话。</p>}
          <button
            type="button"
            disabled={busy || loading || sessions.length === 0}
            onClick={() =>
              void (async () => {
                if (
                  !(await confirm('撤销自己的所有会话（包括当前会话）？所有设备都需要重新登录。', {
                    title: '退出全部设备',
                    confirmText: '撤销并退出',
                    danger: true,
                  }))
                )
                  return;
                await run(() => api('/auth/sessions', { method: 'DELETE' }));
              })()
            }
          >
            撤销全部会话并退出
          </button>
        </section>
      </div>
    </Modal>
  );
}
