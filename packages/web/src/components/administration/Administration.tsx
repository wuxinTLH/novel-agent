import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Copy, Database, HardDrive, RefreshCw, ShieldCheck, Users } from 'lucide-react';
import { api } from '../../services/api';
import Modal from '../common/Modal';
import OnlineMaintenance from './OnlineMaintenance';
import { AccountAdminSettings } from '../account/AccountAdminSettings';
import { useConfirm } from '../common/AppDialog';
import type { AuthRole, AuthSessionInfo, AuthUser, TurnstileAdminSettings } from '../../../../../shared/auth';
import '../../styles/administration.scss';

const accountAdminRequest = <T,>(path: string, method = 'GET', body?: unknown): Promise<T> => {
  if (!path.startsWith('/api/admin/')) return Promise.reject(new Error('无效管理员请求路径'));
  return api<T>(path.slice(4), { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
};

type Mode = 'local' | 'authenticated';
type Driver = 'mysql' | 'postgresql' | 'sqlserver';
type AdminStatus = {
  mode: Mode;
  authenticationEnabled: boolean;
  configured: boolean;
  userCount?: number;
  storage: {
    backend: string;
    profiles: { id: string; label: string; driver: string; database: string; ownerCount: number }[];
    active: boolean;
  };
  runtime: { tenantCount: number };
  maintenance: { offlineRequired: true };
};
type Connection = {
  driver: Driver;
  host: string;
  port: number;
  database: string;
  user: string;
  tls: 'verify' | 'off';
  timeoutMs: number;
  hasPassword?: boolean;
  password?: string;
};
type Profile = { id: string; label?: string; connection: Connection };
type StorageConfig = {
  version: 3;
  defaultProfileId: string;
  profiles: Profile[];
  ownerProfiles: { ownerId: string; profileId: string }[];
};
type Maintenance = {
  commands: { label: string; command: string; description: string }[];
  offlineRequired: true;
};
type BusyCallback = (busy: boolean) => void;
const ports: Record<Driver, number> = { mysql: 3306, postgresql: 5432, sqlserver: 1433 };
const roles: Record<AuthRole, string> = { user: '普通用户', superadmin: '超级管理员' };
const tabs = [
  { id: 'users', label: '用户', icon: Users },
  { id: 'database', label: '数据库', icon: Database },
  { id: 'backup', label: '备份与维护', icon: HardDrive },
  { id: 'system', label: '系统与安全', icon: ShieldCheck },
] as const;
type Tab = (typeof tabs)[number]['id'];
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : '请求失败，请重试。');
const date = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '未知时间' : parsed.toLocaleString();
};

function useResource<T>(path: string) {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api<T>(path, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setValue(result);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, revision]);
  return { value, error, loading, reload: () => setRevision((value) => value + 1) };
}

function useOperation(onBusy: BusyCallback) {
  const gate = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const run = async (operation: () => Promise<void>, success: string) => {
    if (gate.current) return false;
    gate.current = true;
    setBusy(true);
    onBusy(true);
    setError('');
    setNotice('');
    try {
      await operation();
      setNotice(success);
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    } finally {
      gate.current = false;
      setBusy(false);
      onBusy(false);
    }
  };
  return { busy, error, notice, run };
}

function Feedback({ error, notice }: { error?: string; notice?: string }) {
  return (
    <>
      {error && (
        <p className="administration-feedback is-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="administration-feedback" role="status">
          {notice}
        </p>
      )}
    </>
  );
}
function LoadState({ loading, error, retry }: { loading: boolean; error: string; retry: () => void }) {
  return (
    <>
      {loading && (
        <p role="status" className="administration-empty">
          正在读取服务端状态…
        </p>
      )}
      {error && (
        <div className="administration-feedback is-error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={retry}>
            重新加载
          </button>
        </div>
      )}
    </>
  );
}

function UsersPanel({ mode, onBusy, changed }: { mode: Mode; onBusy: BusyCallback; changed: () => void }) {
  const resource = useResource<AuthUser[] | { users: AuthUser[] }>('/admin/users');
  const users = resource.value ? (Array.isArray(resource.value) ? resource.value : resource.value.users) : [];
  const operation = useOperation(onBusy);
  const confirm = useConfirm();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<AuthRole>('user');
  const [selected, setSelected] = useState<AuthUser>();
  const [newPassword, setNewPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [sessionUser, setSessionUser] = useState<AuthUser>();
  const mutate = async (user: AuthUser, patch: { role?: AuthRole; disabled?: boolean }) => {
    const action = patch.role
      ? `将角色更改为「${roles[patch.role]}」`
      : patch.disabled
        ? '停用账号并撤销其会话'
        : '重新启用账号';
    if (
      !(await confirm(`确定为「${user.username}」${action}？服务端会阻止不安全的管理员变更。`, {
        title: '确认账号变更',
        confirmText: '确认变更',
        danger: !!patch.disabled || !!patch.role,
      }))
    )
      return;
    await operation.run(async () => {
      await api(`/admin/users/${encodeURIComponent(user.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      resource.reload();
      changed();
    }, '账号状态已更新。');
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (
      !(await confirm(`创建「${username.trim()}」（${roles[role]}）？新用户将使用独立数据空间。`, {
        title: '创建账号',
        confirmText: '确认创建',
        danger: role === 'superadmin',
      }))
    )
      return;
    try {
      await operation.run(async () => {
        await api('/admin/users', {
          method: 'POST',
          body: JSON.stringify({ username: username.trim(), password, role }),
        });
        setUsername('');
        resource.reload();
        changed();
      }, '账号已创建；登录认证状态没有改变。');
    } finally {
      setPassword('');
    }
  };
  const reset = async (event: FormEvent) => {
    event.preventDefault();
    if (
      !selected ||
      !(await confirm(`重置「${selected.username}」的密码？该用户现有会话将被撤销，需要重新登录。`, {
        title: '重置密码',
        confirmText: '确认重置',
        danger: true,
      }))
    )
      return;
    try {
      await operation.run(async () => {
        await api(`/admin/users/${encodeURIComponent(selected.id)}/password`, {
          method: 'POST',
          body: JSON.stringify({ newPassword, ...(mode === 'authenticated' ? { currentPassword } : {}) }),
        });
        setSelected(undefined);
        setSessionUser(undefined);
      }, '密码已重置，旧会话已撤销。');
    } finally {
      setNewPassword('');
      setCurrentPassword('');
    }
  };
  return (
    <div className="administration-stack">
      <header className="administration-section-heading">
        <div>
          <h3>用户与访问权限</h3>
          <p>按账号隔离数据，敏感变更始终由服务端校验权限。</p>
        </div>
        <button type="button" disabled={operation.busy || resource.loading} onClick={resource.reload}>
          <RefreshCw size={15} aria-hidden="true" />
          刷新
        </button>
      </header>
      <Feedback error={operation.error} notice={operation.notice} />
      <LoadState loading={resource.loading} error={resource.error} retry={resource.reload} />
      {!resource.loading && !resource.error && (
        <div className="administration-table-wrap">
          <table>
            <caption className="administration-sr-only">用户账号与管理操作</caption>
            <thead>
              <tr>
                <th scope="col">账号</th>
                <th scope="col">角色</th>
                <th scope="col">状态</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <th scope="row">
                    <strong>{user.username}</strong>
                    <small>创建于 {date(user.createdAt)}</small>
                  </th>
                  <td>
                    <select
                      aria-label={`${user.username} 的角色`}
                      value={user.role}
                      disabled={operation.busy}
                      onChange={(event) => void mutate(user, { role: event.target.value as AuthRole })}
                    >
                      <option value="user">普通用户</option>
                      <option value="superadmin">超级管理员</option>
                    </select>
                  </td>
                  <td>
                    <span className={`administration-badge ${user.disabled ? 'is-muted' : ''}`}>
                      {user.disabled ? '已停用' : '正常'}
                    </span>
                  </td>
                  <td>
                    <div className="administration-actions">
                      <button
                        type="button"
                        disabled={operation.busy}
                        onClick={() => void mutate(user, { disabled: !user.disabled })}
                      >
                        {user.disabled ? '启用' : '停用'}
                      </button>
                      <button
                        type="button"
                        disabled={operation.busy}
                        onClick={() => {
                          setSelected(user);
                          setNewPassword('');
                          setCurrentPassword('');
                        }}
                      >
                        重置密码
                      </button>
                      <button type="button" disabled={operation.busy} onClick={() => setSessionUser(user)}>
                        会话
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {users.length === 0 && <p className="administration-empty">暂无账号。</p>}
        </div>
      )}
      {selected && (
        <form className="administration-card" onSubmit={(event) => void reset(event)}>
          <h4>重置密码 · {selected.username}</h4>
          <p>重置后撤销该账号的全部会话；重置当前账号可能使本页面退出。</p>
          <fieldset disabled={operation.busy} className="administration-fields">
            {mode === 'authenticated' && (
              <label>
                当前管理员密码
                <input
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  required
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </label>
            )}
            <label>
              新密码
              <input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                minLength={12}
                maxLength={1024}
                required
                onChange={(event) => setNewPassword(event.target.value)}
              />
              <small>至少 12 个字符，最终密码策略以服务端为准。</small>
            </label>
            <div className="administration-actions">
              <button className="is-primary" type="submit">
                确认重置密码
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelected(undefined);
                  setNewPassword('');
                  setCurrentPassword('');
                }}
              >
                取消
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {sessionUser && (
        <SessionsPanel
          key={sessionUser.id}
          user={sessionUser}
          onBusy={onBusy}
          close={() => setSessionUser(undefined)}
        />
      )}
      <form className="administration-card" onSubmit={(event) => void create(event)}>
        <h4>创建新账号</h4>
        <p>不会自动启用登录认证。建议为每位使用者分配独立账号，按需授予管理员权限。</p>
        <fieldset className="administration-fields" disabled={operation.busy}>
          <label>
            用户名
            <input
              value={username}
              autoComplete="off"
              maxLength={64}
              required
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label>
            初始密码
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              minLength={12}
              maxLength={1024}
              required
              onChange={(event) => setPassword(event.target.value)}
            />
            <small>至少 12 个字符；密码不会存入浏览器存储。</small>
          </label>
          <label>
            角色
            <select value={role} onChange={(event) => setRole(event.target.value as AuthRole)}>
              <option value="user">普通用户</option>
              <option value="superadmin">超级管理员</option>
            </select>
          </label>
          <div className="administration-actions">
            <button className="is-primary" type="submit">
              创建账号
            </button>
          </div>
        </fieldset>
      </form>
    </div>
  );
}

function SessionsPanel({ user, onBusy, close }: { user: AuthUser; onBusy: BusyCallback; close: () => void }) {
  const path = `/admin/users/${encodeURIComponent(user.id)}/sessions`;
  const resource = useResource<AuthSessionInfo[] | { sessions: AuthSessionInfo[] }>(path);
  const sessions = resource.value
    ? Array.isArray(resource.value)
      ? resource.value
      : resource.value.sessions
    : [];
  const operation = useOperation(onBusy);
  const confirm = useConfirm();
  return (
    <section className="administration-card" aria-label={`${user.username} 的会话`}>
      <div className="administration-section-heading">
        <h4>登录会话 · {user.username}</h4>
        <button type="button" disabled={operation.busy} onClick={close}>
          收起
        </button>
      </div>
      <p>只展示非凭据会话标识，不显示 Cookie 或令牌。撤销全部会话也会使当前会话失效。</p>
      <Feedback error={operation.error} notice={operation.notice} />
      <LoadState loading={resource.loading} error={resource.error} retry={resource.reload} />
      <ul className="administration-sessions">
        {sessions.map((session) => (
          <li key={session.id}>
            <span>
              {session.current ? '当前会话' : '登录会话'}
              <small>到期 {date(session.expiresAt)}</small>
            </span>
            <code title={session.id}>{session.id}</code>
          </li>
        ))}
      </ul>
      {!resource.loading && !resource.error && sessions.length === 0 && <p>没有有效会话。</p>}
      <button
        type="button"
        disabled={operation.busy || resource.loading || !!resource.error || sessions.length === 0}
        onClick={() =>
          void (async () => {
            if (
              !(await confirm(
                `撤销「${user.username}」的全部登录会话？如果包含你当前的会话，需要重新登录。`,
                { title: '撤销登录会话', danger: true, confirmText: '撤销全部' },
              ))
            )
              return;
            await operation.run(async () => {
              await api(path, { method: 'DELETE' });
              resource.reload();
            }, '会话已撤销。');
          })()
        }
      >
        撤销全部会话
      </button>
    </section>
  );
}

function DatabasePanel({
  status,
  onBusy,
  onDirty,
  changed,
}: {
  status: AdminStatus;
  onBusy: BusyCallback;
  onDirty: (dirty: boolean) => void;
  changed: () => void;
}) {
  const resource = useResource<StorageConfig>('/admin/storage');
  const [draft, setDraft] = useState<StorageConfig>();
  const [dirty, setDirty] = useState(false);
  const operation = useOperation(onBusy);
  const confirm = useConfirm();
  const locked = status.storage.active !== false;
  useEffect(() => {
    if (resource.value) {
      setDraft(resource.value);
      setDirty(false);
      onDirty(false);
    }
  }, [resource.value, onDirty]);
  const change = (next: StorageConfig) => {
    setDraft(next);
    setDirty(true);
    onDirty(true);
  };
  const profileChange = (index: number, patch: Partial<Profile>) => {
    if (draft)
      change({
        ...draft,
        profiles: draft.profiles.map((profile, item) =>
          item === index ? { ...profile, ...patch } : profile,
        ),
      });
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || locked) return;
    if (
      !(await confirm(
        '保存数据库配置与租户映射？此操作不迁移任何数据。修改映射前必须离线备份并迁移相应租户数据，避免看见空数据空间。',
        {
          title: '保存存储配置',
          danger: true,
          confirmText: '确认已完成离线准备',
        },
      ))
    )
      return;
    await operation.run(async () => {
      const ids = new Set(draft.profiles.map((profile) => profile.id));
      if (ids.size !== draft.profiles.length || !ids.has(draft.defaultProfileId))
        throw new Error('配置 ID 必须唯一，且默认配置必须存在。');
      const owners = new Set(draft.ownerProfiles.map((binding) => binding.ownerId));
      if (
        owners.size !== draft.ownerProfiles.length ||
        draft.ownerProfiles.some((binding) => !binding.ownerId.trim() || !ids.has(binding.profileId))
      )
        throw new Error('租户标识不可留空或重复，且映射必须引用现有配置。');
      const profiles = draft.profiles.map((profile) => {
        const { hasPassword: _hasPassword, password, ...connection } = profile.connection;
        return { ...profile, connection: { ...connection, ...(password ? { password } : {}) } };
      });
      await api('/admin/storage', { method: 'PUT', body: JSON.stringify({ ...draft, profiles }) });
      // Forget entered credentials immediately, even if refreshing the public config later fails.
      setDraft({
        ...draft,
        profiles: draft.profiles.map((profile) => {
          const { password: _password, ...connection } = profile.connection;
          return { ...profile, connection };
        }),
      });
      setDirty(false);
      onDirty(false);
      resource.reload();
      changed();
    }, '配置已保存；未连接、初始化或迁移数据库，请按离线维护流程生效。');
  };
  return (
    <div className="administration-stack">
      <header className="administration-section-heading">
        <div>
          <h3>数据库配置与租户路由</h3>
          <p>为不同数据空间分配 MySQL、PostgreSQL 或 SQL Server 配置。</p>
        </div>
      </header>
      <div className="administration-callout">
        <strong>{locked ? '运行中 · 配置只读' : '维护模式 · 可编辑配置'}</strong>
        <p>
          {locked
            ? '存储正在使用中。为避免数据分流与损坏，需停止业务运行并进入服务端支持的维护模式后才能保存。'
            : '仅可保存未被运行时使用的配置。服务端会再次校验状态；保存不会迁移数据。'}
        </p>
      </div>
      <Feedback error={operation.error} notice={operation.notice} />
      <LoadState loading={resource.loading} error={resource.error} retry={resource.reload} />
      {draft && (
        <form onSubmit={(event) => void save(event)}>
          <fieldset
            disabled={operation.busy || locked || resource.loading || !!resource.error}
            className="administration-stack"
          >
            <label>
              默认数据库配置
              <select
                value={draft.defaultProfileId}
                onChange={(event) => change({ ...draft, defaultProfileId: event.target.value })}
              >
                {draft.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.label || profile.id}
                  </option>
                ))}
              </select>
              <small>未单独映射的租户使用此配置。</small>
            </label>
            {draft.profiles.map((profile, index) => (
              <section className="administration-card" key={index} aria-label={`数据库配置 ${index + 1}`}>
                <div className="administration-section-heading">
                  <h4>
                    配置 {index + 1} · {profile.label || profile.id}
                  </h4>
                  <button
                    type="button"
                    disabled={
                      draft.profiles.length <= 1 ||
                      draft.defaultProfileId === profile.id ||
                      draft.ownerProfiles.some((binding) => binding.profileId === profile.id)
                    }
                    onClick={() =>
                      void (async () => {
                        if (
                          await confirm(`移除配置「${profile.label || profile.id}」？不会删除数据库。`, {
                            danger: true,
                            confirmText: '移除配置',
                          })
                        )
                          change({ ...draft, profiles: draft.profiles.filter((_, item) => item !== index) });
                      })()
                    }
                  >
                    移除配置
                  </button>
                </div>
                <div className="administration-fields">
                  <label>
                    配置 ID
                    <input
                      required
                      maxLength={128}
                      value={profile.id}
                      onChange={(event) => {
                        const id = event.target.value;
                        change({
                          ...draft,
                          defaultProfileId:
                            draft.defaultProfileId === profile.id ? id : draft.defaultProfileId,
                          profiles: draft.profiles.map((value, item) =>
                            item === index ? { ...value, id } : value,
                          ),
                          ownerProfiles: draft.ownerProfiles.map((binding) =>
                            binding.profileId === profile.id ? { ...binding, profileId: id } : binding,
                          ),
                        });
                      }}
                    />
                    <small>更改配置 ID、类型、服务器、端口、数据库或用户后，必须重新输入密码。</small>
                  </label>
                  <label>
                    显示名称
                    <input
                      maxLength={200}
                      value={profile.label || ''}
                      onChange={(event) => profileChange(index, { label: event.target.value })}
                    />
                  </label>
                  <label>
                    数据库类型
                    <select
                      value={profile.connection.driver}
                      onChange={(event) => {
                        const driver = event.target.value as Driver;
                        profileChange(index, {
                          connection: { ...profile.connection, driver, port: ports[driver] },
                        });
                      }}
                    >
                      <option value="mysql">MySQL</option>
                      <option value="postgresql">PostgreSQL</option>
                      <option value="sqlserver">SQL Server / MSSQL</option>
                    </select>
                  </label>
                  <label>
                    服务器
                    <input
                      required
                      maxLength={253}
                      value={profile.connection.host}
                      autoComplete="off"
                      onChange={(event) =>
                        profileChange(index, {
                          connection: { ...profile.connection, host: event.target.value },
                        })
                      }
                    />
                  </label>
                  <label>
                    端口
                    <input
                      type="number"
                      required
                      min={1}
                      max={65535}
                      step={1}
                      value={profile.connection.port}
                      onChange={(event) =>
                        profileChange(index, {
                          connection: { ...profile.connection, port: Number(event.target.value) },
                        })
                      }
                    />
                  </label>
                  <label>
                    数据库名称
                    <input
                      required
                      maxLength={63}
                      pattern="[a-zA-Z_][a-zA-Z0-9_]*"
                      value={profile.connection.database}
                      onChange={(event) =>
                        profileChange(index, {
                          connection: { ...profile.connection, database: event.target.value },
                        })
                      }
                    />
                  </label>
                  <label>
                    数据库用户
                    <input
                      required
                      maxLength={128}
                      value={profile.connection.user}
                      autoComplete="off"
                      onChange={(event) =>
                        profileChange(index, {
                          connection: { ...profile.connection, user: event.target.value },
                        })
                      }
                    />
                  </label>
                  <label>
                    数据库密码
                    <input
                      type="password"
                      maxLength={4096}
                      autoComplete="new-password"
                      value={profile.connection.password || ''}
                      placeholder={
                        profile.connection.hasPassword ? '已配置；留空保留现有密码' : '留空表示不设置密码'
                      }
                      onChange={(event) =>
                        profileChange(index, {
                          connection: { ...profile.connection, password: event.target.value },
                        })
                      }
                    />
                    <small>不回显现有密码，不写入浏览器存储。</small>
                  </label>
                  <label>
                    TLS
                    <select
                      value={profile.connection.tls}
                      onChange={(event) =>
                        profileChange(index, {
                          connection: { ...profile.connection, tls: event.target.value as Connection['tls'] },
                        })
                      }
                    >
                      <option value="verify">启用并验证证书（推荐）</option>
                      <option value="off">关闭（仅回环主机）</option>
                    </select>
                  </label>
                  <label>
                    连接超时（毫秒）
                    <input
                      type="number"
                      min={1000}
                      max={30000}
                      step={1}
                      required
                      value={profile.connection.timeoutMs}
                      onChange={(event) =>
                        profileChange(index, {
                          connection: { ...profile.connection, timeoutMs: Number(event.target.value) },
                        })
                      }
                    />
                  </label>
                </div>
              </section>
            ))}
            <div>
              <button
                type="button"
                onClick={() => {
                  let number = draft.profiles.length + 1;
                  while (draft.profiles.some((profile) => profile.id === `profile-${number}`)) number++;
                  change({
                    ...draft,
                    defaultProfileId: draft.defaultProfileId || `profile-${number}`,
                    profiles: [
                      ...draft.profiles,
                      {
                        id: `profile-${number}`,
                        label: `数据库 ${number}`,
                        connection: {
                          driver: 'mysql',
                          host: 'localhost',
                          port: 3306,
                          database: 'novel_agent',
                          user: '',
                          tls: 'verify',
                          timeoutMs: 10000,
                        },
                      },
                    ],
                  });
                }}
              >
                添加数据库配置
              </button>
            </div>
            <section className="administration-card">
              <h4>租户 → 数据库映射</h4>
              <p>
                租户标识是服务端的数据空间
                ownerId，不一定等同于用户名；不要猜测标识。删除映射后该租户回退至默认配置，不会搬移数据。
              </p>
              <div className="administration-stack">
                {draft.ownerProfiles.map((binding, index) => (
                  <div className="administration-mapping" key={index}>
                    <label>
                      租户标识
                      <input
                        required
                        maxLength={128}
                        value={binding.ownerId}
                        onChange={(event) =>
                          change({
                            ...draft,
                            ownerProfiles: draft.ownerProfiles.map((value, item) =>
                              item === index ? { ...value, ownerId: event.target.value } : value,
                            ),
                          })
                        }
                      />
                    </label>
                    <label>
                      数据库配置
                      <select
                        value={binding.profileId}
                        onChange={(event) =>
                          change({
                            ...draft,
                            ownerProfiles: draft.ownerProfiles.map((value, item) =>
                              item === index ? { ...value, profileId: event.target.value } : value,
                            ),
                          })
                        }
                      >
                        {draft.profiles.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.label || profile.id}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      aria-label={`移除租户 ${binding.ownerId || index + 1} 的映射`}
                      onClick={() =>
                        change({
                          ...draft,
                          ownerProfiles: draft.ownerProfiles.filter((_, item) => item !== index),
                        })
                      }
                    >
                      移除映射
                    </button>
                  </div>
                ))}
              </div>
              {draft.ownerProfiles.length === 0 && (
                <p className="administration-empty">暂无单独映射，所有租户使用默认配置。</p>
              )}
              <button
                type="button"
                onClick={() =>
                  change({
                    ...draft,
                    ownerProfiles: [
                      ...draft.ownerProfiles,
                      { ownerId: '', profileId: draft.defaultProfileId },
                    ],
                  })
                }
              >
                添加租户映射
              </button>
            </section>
            <div className="administration-actions">
              <button type="submit" className="is-primary" disabled={!dirty}>
                {operation.busy ? '正在保存…' : '保存配置与映射'}
              </button>
              <button
                type="button"
                disabled={!dirty}
                onClick={() =>
                  void (async () => {
                    if (await confirm('丢弃所有未保存的数据库配置？')) {
                      setDraft(resource.value);
                      setDirty(false);
                      onDirty(false);
                    }
                  })()
                }
              >
                放弃修改
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </div>
  );
}

function MaintenancePanel() {
  const resource = useResource<Maintenance>('/admin/maintenance');
  const [notice, setNotice] = useState('');
  const [copyError, setCopyError] = useState('');
  return (
    <div className="administration-stack">
      <header>
        <h3>备份、恢复与迁移</h3>
        <p>只通过服务器上的离线 CLI 执行，不在浏览器中发起破坏性维护。</p>
      </header>
      <div className="administration-callout">
        <strong>先停服务，再做维护</strong>
        <ol>
          <li>停止所有使用同一数据目录或数据库的服务进程。</li>
          <li>在服务器终端核对数据目录、数据库配置和目标，创建并验证备份。</li>
          <li>执行所需维护命令，验证数据后再启动服务。</li>
        </ol>
        <p>
          恢复与迁移可能改变数据；不要在运行中的数据库上操作。凭据仅通过服务器私有配置提供，不放入命令或剪贴板。
        </p>
      </div>
      <Feedback error={copyError} notice={notice} />
      <LoadState loading={resource.loading} error={resource.error} retry={resource.reload} />
      {resource.value?.commands.map((command, index) => (
        <section className="administration-card" key={`${command.label}-${index}`}>
          <div className="administration-section-heading">
            <h4>{command.label}</h4>
            <button
              type="button"
              onClick={() =>
                void (async () => {
                  setCopyError('');
                  setNotice('');
                  try {
                    await navigator.clipboard.writeText(command.command);
                    setNotice(`已复制「${command.label}」命令；尚未执行。`);
                  } catch {
                    setCopyError('无法访问剪贴板，请选择下方命令手动复制。');
                  }
                })()
              }
            >
              <Copy size={15} aria-hidden="true" />
              复制命令
            </button>
          </div>
          <p>{command.description}</p>
          <pre tabIndex={0} aria-label={`${command.label}命令`}>
            <code>{command.command}</code>
          </pre>
        </section>
      ))}
      {resource.value?.commands.length === 0 && (
        <p className="administration-empty">
          服务端未提供维护命令。请查阅部署环境的 CLI 帮助，不要尝试在线恢复。
        </p>
      )}
    </div>
  );
}

function SystemPanel({
  status,
  onBusy,
  onDirty,
}: {
  status: AdminStatus;
  onBusy: BusyCallback;
  onDirty: (dirty: boolean) => void;
}) {
  const resource = useResource<TurnstileAdminSettings>('/admin/turnstile');
  const [config, setConfig] = useState<TurnstileAdminSettings>();
  const [secret, setSecret] = useState('');
  const [dirty, setDirty] = useState(false);
  const operation = useOperation(onBusy);
  const confirm = useConfirm();
  useEffect(() => {
    if (resource.value) {
      setConfig(resource.value);
      setDirty(false);
      onDirty(false);
    }
  }, [resource.value, onDirty]);
  const change = (patch: Partial<TurnstileAdminSettings>) => {
    if (config) setConfig({ ...config, ...patch });
    setDirty(true);
    onDirty(true);
  };
  return (
    <div className="administration-stack">
      <header>
        <h3>系统状态与登录安全</h3>
        <p>后台配置与认证开关分离；此页面不更改服务器启动时的认证模式。</p>
      </header>
      <dl className="administration-stats">
        <div>
          <dt>登录认证</dt>
          <dd>{status.authenticationEnabled ? '已开启' : '保持关闭'}</dd>
        </div>
        <div>
          <dt>管理访问</dt>
          <dd>{status.mode === 'local' ? '本机管理' : '管理员会话'}</dd>
        </div>
        <div>
          <dt>持久化后端</dt>
          <dd>{status.storage.backend}</dd>
        </div>
        <div>
          <dt>已加载租户</dt>
          <dd>{status.runtime.tenantCount}</dd>
        </div>
      </dl>
      <div className="administration-card">
        <h4>数据库运行概览</h4>
        {status.storage.profiles.length ? (
          <ul className="administration-sessions">
            {status.storage.profiles.map((profile) => (
              <li key={profile.id}>
                <span>
                  {profile.label || profile.id}
                  <small>
                    {profile.driver} · {profile.database}
                  </small>
                </span>
                <span>{profile.ownerCount} 个租户</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>暂无 SQL 存储配置。</p>
        )}
        <p>
          运行时状态：{status.storage.active ? '存储已激活；配置只读' : '存储未激活'}
          。迁移与备份必须离线执行。
        </p>
      </div>
      <div className="administration-card">
        <AccountAdminSettings request={accountAdminRequest} />
      </div>
      <Feedback error={operation.error} notice={operation.notice} />
      <LoadState loading={resource.loading} error={resource.error} retry={resource.reload} />
      {config && (
        <form
          className="administration-card"
          onSubmit={(event) => {
            event.preventDefault();
            void (async () => {
              if (
                !(await confirm(
                  '保存 Cloudflare Turnstile 配置？请先确认合法域名、站点密钥和服务端密钥匹配；错误配置可能阻止用户登录。此操作不会开启登录认证。',
                  { title: '更新登录验证', confirmText: '确认保存' },
                ))
              )
                return;
              try {
                await operation.run(async () => {
                  await api('/admin/turnstile', {
                    method: 'PUT',
                    body: JSON.stringify({
                      enabled: config.enabled,
                      siteKey: config.siteKey,
                      action: config.action || '',
                      hostname: config.hostname || '',
                      ...(secret ? { secret } : {}),
                    }),
                  });
                  setDirty(false);
                  onDirty(false);
                  resource.reload();
                }, '人机验证设置已保存，登录认证开关保持不变。');
              } finally {
                setSecret('');
              }
            })();
          }}
        >
          <h4>Cloudflare Turnstile</h4>
          <p>仅作用于已启用的登录流程；本机模式下配置此项不会启用登录。</p>
          <fieldset
            disabled={operation.busy || resource.loading || !!resource.error}
            className="administration-fields"
          >
            <label className="administration-checkbox administration-full">
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(event) => change({ enabled: event.target.checked })}
              />
              启用登录人机验证
            </label>
            <label>
              Site Key
              <input
                required={config.enabled}
                value={config.siteKey}
                onChange={(event) => change({ siteKey: event.target.value })}
                autoComplete="off"
              />
            </label>
            <label>
              Secret Key
              <input
                type="password"
                autoComplete="new-password"
                required={config.enabled && !config.hasSecret}
                value={secret}
                placeholder={config.hasSecret ? '已配置；留空保留现有密钥' : '未配置'}
                onChange={(event) => {
                  setSecret(event.target.value);
                  setDirty(true);
                  onDirty(true);
                }}
              />
              <small>密钥仅发送到服务端，不回显、不存入浏览器存储。</small>
            </label>
            <label>
              预期 Action
              <input
                value={config.action || ''}
                onChange={(event) => change({ action: event.target.value })}
              />
            </label>
            <label>
              预期 Hostname
              <input
                value={config.hostname || ''}
                placeholder="例如 novel.example.com"
                onChange={(event) => change({ hostname: event.target.value })}
              />
            </label>
            <div className="administration-actions administration-full">
              <button type="submit" className="is-primary" disabled={!dirty}>
                保存验证设置
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </div>
  );
}

export default function Administration({ close, mode }: { close: () => void; mode: Mode }) {
  const resource = useResource<AdminStatus>('/admin/status');
  const [tab, setTab] = useState<Tab>('users');
  const [busy, setBusy] = useState(false);
  const [databaseDirty, setDatabaseDirty] = useState(false);
  const [securityDirty, setSecurityDirty] = useState(false);
  const id = useId();
  const status = resource.value;
  const keydown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : event.key === 'ArrowRight'
            ? (index + 1) % tabs.length
            : event.key === 'ArrowLeft'
              ? (index + tabs.length - 1) % tabs.length
              : -1;
    if (next < 0 || busy) return;
    event.preventDefault();
    setTab(tabs[next].id);
    document.getElementById(`${id}-tab-${tabs[next].id}`)?.focus();
  };
  return (
    <Modal
      title="管理控制台"
      description="用户、数据库与运行维护，一处管理。"
      className="administration"
      wide
      close={close}
      busy={busy}
      dirty={databaseDirty || securityDirty}
    >
      <div className="administration-mode">
        <span className="administration-badge">{mode === 'local' ? '本机管理模式' : '管理员模式'}</span>
        <p>
          {mode === 'local'
            ? '登录认证保持关闭；管理权限由服务端的本机访问校验和管理令牌保护，不代表已登录账号。'
            : '通过管理员会话访问；所有操作均需服务端授权。'}
        </p>
      </div>
      <LoadState loading={resource.loading} error={resource.error} retry={resource.reload} />
      {status && (
        <>
          {!status.configured && (
            <div className="administration-callout" role="status">
              <strong>尚未初始化认证</strong>
              <p>
                请先在服务器终端通过 CLI
                初始化首位超级管理员；不能通过此页面绕过引导。初始化账号不等于开启认证，启用前请按部署说明配置认证并重启服务。
              </p>
              <button type="button" disabled={busy} onClick={() => setTab('backup')}>
                查看离线维护命令
              </button>
            </div>
          )}
          <div className="administration-tabs" role="tablist" aria-label="管理分类">
            {tabs.map(({ id: name, label, icon: Icon }, index) => (
              <button
                key={name}
                id={`${id}-tab-${name}`}
                role="tab"
                aria-selected={tab === name}
                aria-controls={`${id}-panel-${name}`}
                tabIndex={tab === name ? 0 : -1}
                disabled={busy}
                onKeyDown={(event) => keydown(event, index)}
                onClick={() => setTab(name)}
              >
                <Icon size={17} aria-hidden="true" />
                {label}
                {name === 'users' && status.userCount !== undefined && (
                  <span className="administration-tab-count">{status.userCount}</span>
                )}
              </button>
            ))}
          </div>
          <section
            role="tabpanel"
            id={`${id}-panel-users`}
            aria-labelledby={`${id}-tab-users`}
            hidden={tab !== 'users'}
            tabIndex={0}
          >
            {status.configured ? (
              <UsersPanel mode={mode} onBusy={setBusy} changed={resource.reload} />
            ) : (
              <p className="administration-empty">
                完成 CLI 引导后，刷新状态即可管理用户。登录认证仍保持原有设置。
              </p>
            )}
          </section>
          <section
            role="tabpanel"
            id={`${id}-panel-database`}
            aria-labelledby={`${id}-tab-database`}
            hidden={tab !== 'database'}
            tabIndex={0}
          >
            <DatabasePanel
              status={status}
              onBusy={setBusy}
              onDirty={setDatabaseDirty}
              changed={resource.reload}
            />
          </section>
          <section
            role="tabpanel"
            id={`${id}-panel-backup`}
            aria-labelledby={`${id}-tab-backup`}
            hidden={tab !== 'backup'}
            tabIndex={0}
          >
            {tab === 'backup' && <OnlineMaintenance />}
            <MaintenancePanel />
          </section>
          <section
            role="tabpanel"
            id={`${id}-panel-system`}
            aria-labelledby={`${id}-tab-system`}
            hidden={tab !== 'system'}
            tabIndex={0}
          >
            <SystemPanel status={status} onBusy={setBusy} onDirty={setSecurityDirty} />
          </section>
          <footer className="administration-footer">
            <span>{busy ? '正在提交，请勿关闭页面…' : '配置与权限以服务器校验结果为准'}</span>
            <button type="button" disabled={busy || resource.loading} onClick={resource.reload}>
              <RefreshCw size={14} aria-hidden="true" />
              刷新系统状态
            </button>
          </footer>
        </>
      )}
    </Modal>
  );
}
