import { useConfirm } from './components/AppDialog';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Link2, LoaderCircle, RefreshCw, ShieldCheck, Unlink, X } from 'lucide-react';
import { api } from './api';
import type {
  DraftOperation,
  DraftPreparation,
  DraftReceipt,
  PlatformChapterChoice,
  PlatformConnection,
  PlatformLogin,
  PlatformProvider,
  PlatformSession,
  PlatformWork,
  ProjectPlatformWorkLink,
} from '../shared/platforms';

const messageOf = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请稍后查询状态。');
const dateLabel = (value?: string) => (value ? new Date(value).toLocaleString('zh-CN') : '尚未核验');
const stateLabels: Record<DraftOperation['state'], string> = {
  queued: '已记录意图，等待执行',
  running: '正在执行',
  verified: '已重新打开核实保存',
  failed: '写入前失败',
  unknown: '结果未知，禁止重发',
};

export default function PlatformPanel({
  projectId,
  running,
  selectedChapterId,
}: {
  projectId: string;
  running: boolean;
  selectedChapterId?: string;
}) {
  const confirmDialog = useConfirm();
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const [providers, setProviders] = useState<PlatformProvider[]>([]);
  const [session, setSession] = useState<PlatformSession | null>(null);
  const [connections, setConnections] = useState<PlatformConnection[]>([]);
  const [links, setLinks] = useState<ProjectPlatformWorkLink[]>([]);
  const [chapters, setChapters] = useState<PlatformChapterChoice[]>([]);
  const [operations, setOperations] = useState<DraftOperation[]>([]);
  const [receipts, setReceipts] = useState<DraftReceipt[]>([]);
  const [connectionId, setConnectionId] = useState('');
  const [linkId, setLinkId] = useState('');
  const [chapterId, setChapterId] = useState(selectedChapterId || '');
  const [works, setWorks] = useState<PlatformWork[]>([]);
  const [login, setLogin] = useState<PlatformLogin | null>(null);
  const [preview, setPreview] = useState<DraftPreparation | null>(null);
  const [approved, setApproved] = useState(false);
  const [mockToken, setMockToken] = useState('');
  const [mockTitle, setMockTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const lifetime = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const selectionVersion = useRef(0);
  const executeKeys = useRef(new Map<string, string>());

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    pending.current = false;
    setConnectionId('');
    setLinkId('');
    setWorks([]);
    setPreview(null);
    setApproved(false);
    setLogin(null);
    setMockToken('');
    setMockTitle('');
    setBusy(false);
    setNotice('');
    executeKeys.current.clear();
    return () => controller.abort();
  }, [projectId]);
  useEffect(() => {
    setChapterId(selectedChapterId || '');
    setPreview(null);
    setApproved(false);
    selectionVersion.current++;
  }, [selectedChapterId, projectId]);
  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const [nextSession, nextProviders] = await Promise.all([
          api<PlatformSession>('/platforms/session', options),
          api<PlatformProvider[]>('/platforms/providers', options),
        ]);
        if (controller.signal.aborted) return;
        setSession(nextSession);
        setProviders(nextProviders);
        if (!nextSession.available) {
          setError(nextSession.reason || '平台服务暂不可用。');
          return;
        }
        const [nextConnections, nextLinks, nextChapters, nextOperations, nextReceipts] = await Promise.all([
          api<PlatformConnection[]>(`${base}/platform-connections`, options),
          api<ProjectPlatformWorkLink[]>(`${base}/platform-links`, options),
          api<PlatformChapterChoice[]>(`${base}/platform-chapters`, options),
          api<DraftOperation[]>(`${base}/platform-operations`, options),
          api<DraftReceipt[]>(`${base}/platform-draft-receipts`, options),
        ]);
        if (controller.signal.aborted) return;
        setConnections(nextConnections);
        setLinks(nextLinks);
        setChapters(nextChapters);
        setOperations(nextOperations);
        setReceipts(nextReceipts);
        setConnectionId((id) => (nextConnections.some((item) => item.id === id) ? id : ''));
        setLinkId((id) => (nextLinks.some((item) => item.id === id) ? id : ''));
      } catch (failure) {
        if (!controller.signal.aborted) setError(messageOf(failure));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [base, refresh]);

  const activeOperation = operations.some((operation) => ['queued', 'running'].includes(operation.state));
  const activeLogin = !!login && ['waiting', 'needs_verification'].includes(login.status);
  // Poll local status only, never launch, read an account, or upload on a timer.
  useEffect(() => {
    if (!activeOperation && !activeLogin) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        if (activeOperation) {
          const next = await api<DraftOperation[]>(`${base}/platform-operations`, {
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          setOperations(next);
          if (!next.some((item) => ['queued', 'running'].includes(item.state))) {
            const nextReceipts = await api<DraftReceipt[]>(`${base}/platform-draft-receipts`, {
              signal: controller.signal,
            });
            if (!controller.signal.aborted) setReceipts(nextReceipts);
          }
        }
        if (activeLogin && login) {
          const next = await api<PlatformLogin>(`${base}/platform-login/${encodeURIComponent(login.id)}`, {
            signal: controller.signal,
          });
          if (!controller.signal.aborted) setLogin(next);
        }
      } catch (failure) {
        if (!controller.signal.aborted) setError(messageOf(failure));
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => {
            void poll();
          }, 1500);
      }
    };
    timer = setTimeout(() => {
      void poll();
    }, 1000);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [base, activeOperation, activeLogin, login?.id]);

  const disabled = loading || busy || running || !session?.available;
  const mutateDisabled = disabled || activeOperation || activeLogin;
  const connection = connections.find((item) => item.id === connectionId);
  const provider = providers.find((item) => item.id === connection?.providerId);
  const selectedLink = links.find((item) => item.id === linkId && item.connectionId === connectionId);
  const selectedChapter = chapters.find((item) => item.id === chapterId);
  const canRead =
    !!connection?.hasCredential && connection.status === 'connected' && !!provider?.capabilities.listWorks;
  const resetPreview = () => {
    selectionVersion.current++;
    setPreview(null);
    setApproved(false);
  };
  const action = async <T,>(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    body: object | undefined,
    accept: (value: T) => void,
    success: string,
    key?: string,
  ) => {
    const controller = lifetime.current;
    if (disabled || pending.current || !controller || controller.signal.aborted || !session) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const value = await api<T>(`${base}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          'X-Platform-CSRF': session.csrfToken,
          ...(method === 'GET' ? {} : { 'Idempotency-Key': key || crypto.randomUUID() }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (controller.signal.aborted) return;
      accept(value);
      setNotice(success);
    } catch (failure) {
      if (!controller.signal.aborted) setError(messageOf(failure));
    } finally {
      if (!controller.signal.aborted) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const acceptConnection = (value: PlatformConnection) => {
    setConnections((items) => [...items.filter((item) => item.id !== value.id), value]);
    // No automatic account selection or account work lookup after login.
    setWorks([]);
    resetPreview();
  };
  const startLogin = (id?: string) =>
    void action<PlatformLogin>(
      '/platform-connections/tomato/login/start',
      'POST',
      id ? { connectionId: id } : {},
      setLogin,
      '独立浏览器已打开。请人工操作登录；本工具不会读取密码、验证码或自动上传。',
    );
  const refreshLocal = () => {
    resetPreview();
    setRefresh((value) => value + 1);
  };
  const readWorks = () => {
    if (!canRead || !connection) return;
    const version = selectionVersion.current;
    void action<PlatformWork[]>(
      `/platform-works?connectionId=${encodeURIComponent(connection.id)}`,
      'GET',
      undefined,
      (value) => {
        if (version === selectionVersion.current) setWorks(value);
      },
      '已只读获取所选账号的作品；尚未打开编辑器。',
    );
  };
  const prepare = () => {
    if (!selectedLink || !selectedChapter) return;
    const version = selectionVersion.current;
    void action<DraftPreparation>(
      '/platform-drafts/prepare',
      'POST',
      { linkId: selectedLink.id, chapterId: selectedChapter.id },
      (value) => {
        if (version === selectionVersion.current) {
          setPreview(value);
          setApproved(false);
        }
      },
      '已准备服务器保存版本的完整预览。确认前不会进入编辑器。',
    );
  };
  const execute = () => {
    if (!preview || !approved) return;
    let key = executeKeys.current.get(preview.id);
    if (!key) {
      key = crypto.randomUUID();
      executeKeys.current.set(preview.id, key);
    }
    void action<DraftOperation>(
      '/platform-drafts/execute',
      'POST',
      { preparationId: preview.id, contentHash: preview.snapshot.contentHash, approved: true },
      (value) => {
        setOperations((items) => [...items.filter((item) => item.id !== value.id), value]);
        setApproved(false);
      },
      '已取得草稿操作记录，请以核实回执为准。关闭本页面不会撤回已到达平台的内容。',
      key,
    );
  };
  const connectMock = (event: FormEvent) => {
    event.preventDefault();
    const token = mockToken.trim();
    if (!token) return;
    setMockToken('');
    void action<PlatformConnection>(
      '/platform-connections/mock/token',
      'POST',
      { token },
      acceptConnection,
      '已创建明确标记的本地 Mock 连接，不是真实账号。',
    );
  };

  return (
    <div className="platform-panel" aria-busy={loading || busy}>
      <div className="platform-notice">
        <ShieldCheck size={18} />
        <p>
          第三方本机辅助工具，不是番茄官方 API
          或客户端。仅允许人工登录、选择一个已保存章节、完整预览并确认后保存草稿；绝不自动上传或正式发布。
        </p>
      </div>
      {session && (
        <p className="platform-help">
          {session.persistentCredentials
            ? '会话通过本机 PLATFORM_SECRETS_KEY 加密保存。网站会话能否跨重启恢复仍须真实验收，过期后请重新人工登录。'
            : '未配置持久加密密钥，会话仅保存在进程内存；重启后须在原连接下重新人工登录，绑定仍保留。'}
        </p>
      )}
      {session?.legacyArchived && (
        <p className="platform-notice">
          旧“番茄本地发布”的模拟连接、作品、绑定和操作已隔离归档，不能当作真实草稿或远端 ID。
        </p>
      )}
      {running && <p className="platform-notice">工作流运行中，平台操作暂时停用。</p>}
      {error && (
        <div className="error-banner" role="alert">
          <span>{error} 请求中断时先查询操作记录，不要盲目重发。</span>
          <button aria-label="关闭平台错误" onClick={() => setError('')}>
            <X size={16} />
          </button>
        </div>
      )}
      {notice && (
        <p className="platform-success" role="status">
          <Check size={16} />
          {notice}
        </p>
      )}
      <div className="platform-section-heading">
        <h2>平台连接与能力</h2>
        <button className="button secondary" disabled={loading || busy} onClick={refreshLocal}>
          <RefreshCw size={14} />
          刷新本地状态
        </button>
      </div>
      {loading && (
        <p className="platform-loading">
          <LoaderCircle className="spin" size={16} />
          读取本地连接与记录…
        </p>
      )}
      <div className="platform-provider-grid">
        {providers.map((item) => (
          <section className="platform-card" key={item.id}>
            <div className="platform-section-heading">
              <h3>{item.name}</h3>
              <span className="platform-badge">
                {item.readiness === 'ready'
                  ? '已核验能力'
                  : item.readiness === 'mock'
                    ? '本地测试'
                    : item.readiness === 'needs_verification'
                      ? '真实页面待核验'
                      : '暂未开放'}
              </span>
            </div>
            <p className="platform-help">{item.description}</p>
            {item.readinessReason && <p className="platform-help">{item.readinessReason}</p>}
            {item.id === 'tomato' && (
              <button
                className="button primary"
                disabled={mutateDisabled || !item.capabilities.manualLogin}
                onClick={() => startLogin()}
              >
                <Link2 size={14} />
                打开独立浏览器人工登录
              </button>
            )}
            {item.id === 'mock' && (
              <details>
                <summary>仅本地 Mock 测试，不连接番茄</summary>
                <form className="platform-form" onSubmit={connectMock} autoComplete="off">
                  <label>
                    任意非空演示令牌
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={mockToken}
                      onChange={(event) => setMockToken(event.target.value)}
                      disabled={mutateDisabled}
                    />
                  </label>
                  <button className="button secondary" disabled={mutateDisabled || !mockToken.trim()}>
                    创建 Mock 连接
                  </button>
                </form>
              </details>
            )}
          </section>
        ))}
      </div>
      {login && (
        <section className="platform-card">
          <h3>本次人工登录</h3>
          <p>{login.message}</p>
          <p className="platform-help">
            登录状态：{login.status} · 有效至 {dateLabel(login.expiresAt)}
          </p>
          {activeLogin && (
            <div className="platform-actions">
              <button
                className="button primary"
                disabled={disabled}
                onClick={() =>
                  void action<PlatformConnection>(
                    `/platform-login/${encodeURIComponent(login.id)}/complete`,
                    'POST',
                    {},
                    (value) => {
                      acceptConnection(value);
                      setLogin({
                        ...login,
                        status: 'completed',
                        message: '稳定作者身份核验通过，会话已保存。',
                      });
                    },
                    '登录验证完成；请显式选择账号后读取作品。',
                  )
                }
              >
                我已登录，核验作者身份
              </button>
              <button
                className="button secondary"
                disabled={disabled}
                onClick={() =>
                  void action(
                    `/platform-login/${encodeURIComponent(login.id)}`,
                    'DELETE',
                    undefined,
                    () => setLogin({ ...login, status: 'closed', message: '登录窗口已关闭，未上传章节。' }),
                    '已关闭人工登录。',
                  )
                }
              >
                关闭登录窗口
              </button>
            </div>
          )}
        </section>
      )}
      <section className="platform-card">
        <h3>当前项目连接</h3>
        {!connections.length && (
          <p className="platform-empty">尚无真实连接。打开登录窗口不等于已验证账号。</p>
        )}
        <div className="platform-list">
          {connections.map((item) => (
            <article className="platform-row" key={item.id}>
              <div className="platform-row-content">
                <strong>{item.accountName}</strong>
                <p className="platform-help">
                  {item.providerId} · 稳定账号 ID：{item.accountId} ·{' '}
                  {item.status === 'connected'
                    ? '本机有会话，远程操作前仍须核验'
                    : item.status === 'needs_reauth'
                      ? '需要重新授权'
                      : '页面适配待验证'}{' '}
                  · {dateLabel(item.lastCheckedAt)}
                </p>
                {item.providerId === 'mock' && (
                  <MockCredentialForm
                    disabled={mutateDisabled}
                    onSave={(token) =>
                      void action<PlatformConnection>(
                        `/platform-connections/${encodeURIComponent(item.id)}/credential`,
                        'PUT',
                        { token },
                        acceptConnection,
                        'Mock 连接已重新授权。',
                      )
                    }
                  />
                )}
              </div>
              <div className="platform-actions">
                {item.providerId === 'tomato' && (
                  <button
                    className="button secondary"
                    disabled={mutateDisabled}
                    onClick={() => startLogin(item.id)}
                  >
                    重新人工登录
                  </button>
                )}
                <button
                  className="button secondary"
                  disabled={mutateDisabled || !item.hasCredential}
                  onClick={() =>
                    void action<PlatformConnection>(
                      `/platform-connections/${encodeURIComponent(item.id)}/test`,
                      'POST',
                      {},
                      acceptConnection,
                      '已核验当前账号。',
                    )
                  }
                >
                  只读核验账号
                </button>
                <button
                  className="button secondary"
                  disabled={mutateDisabled || links.some((link) => link.connectionId === item.id)}
                  onClick={async () => {
                    if (!(await confirmDialog('只删除本机连接与会话，不删除远端作品或草稿。是否继续？')))
                      return;
                    void action(
                      `/platform-connections/${encodeURIComponent(item.id)}`,
                      'DELETE',
                      undefined,
                      () => {
                        setConnections((items) => items.filter((value) => value.id !== item.id));
                        if (connectionId === item.id) {
                          setConnectionId('');
                          setWorks([]);
                          resetPreview();
                        }
                      },
                      '本机连接已删除，远端内容未改动。',
                    );
                  }}
                >
                  删除本机连接
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
      <section className="platform-card">
        <h2>明确选择账号与作品</h2>
        <p className="platform-help">
          选择账号不会自动访问远端；点击“只读读取作品”后才查询。真实番茄不提供创建或修改作品功能。
        </p>
        <div className="platform-form">
          <label>
            账号
            <select
              value={connectionId}
              disabled={mutateDisabled}
              onChange={(event) => {
                setConnectionId(event.target.value);
                setWorks([]);
                setLinkId('');
                resetPreview();
              }}
            >
              <option value="">请选择准确账号</option>
              {connections.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.providerId} · {item.accountName} · {item.accountId}
                </option>
              ))}
            </select>
          </label>
          <button className="button secondary" disabled={mutateDisabled || !canRead} onClick={readWorks}>
            <RefreshCw size={14} />
            只读读取作品
          </button>
        </div>
        {connection && !canRead && (
          <p className="platform-notice">
            会话缺失、过期或页面能力未核验。可使用上方重新登录入口，但未经验证不会开放草稿写入。
          </p>
        )}
        {connection?.providerId === 'mock' && (
          <form
            className="platform-form"
            onSubmit={(event) => {
              event.preventDefault();
              void action<PlatformWork>(
                '/platform-works',
                'POST',
                { connectionId, title: mockTitle.trim(), description: '', genre: '' },
                (work) => {
                  setWorks((items) => [...items, work]);
                  setMockTitle('');
                },
                '已创建本地 Mock 作品。',
              );
            }}
          >
            <label>
              本地 Mock 作品名
              <input
                value={mockTitle}
                onChange={(event) => setMockTitle(event.target.value)}
                disabled={mutateDisabled}
                maxLength={120}
              />
            </label>
            <button className="button secondary" disabled={mutateDisabled || !canRead || !mockTitle.trim()}>
              创建 Mock 作品
            </button>
          </form>
        )}
        <div className="platform-list">
          {works.map((work) => (
            <article className="platform-row" key={work.id}>
              <div className="platform-row-content">
                <h3>{work.title}</h3>
                <p className="platform-help">
                  作品 ID：{work.id} · {work.description}
                </p>
              </div>
              <button
                className="button secondary"
                disabled={
                  mutateDisabled ||
                  links.some((item) => item.connectionId === connectionId && item.remoteWorkId === work.id)
                }
                onClick={() =>
                  void action<ProjectPlatformWorkLink>(
                    '/platform-links',
                    'POST',
                    { connectionId, remoteWorkId: work.id },
                    (link) => setLinks((items) => [...items.filter((item) => item.id !== link.id), link]),
                    '已显式绑定所选作品；未上传章节。',
                  )
                }
              >
                <Link2 size={14} />
                绑定此作品
              </button>
            </article>
          ))}
        </div>
        <div className="platform-list">
          {links
            .filter((item) => item.connectionId === connectionId)
            .map((link) => (
              <article className="platform-row" key={link.id}>
                <div className="platform-row-content">
                  <strong>已绑定：{link.title}</strong>
                  <p className="platform-help">
                    {link.remoteWorkId} · 最近只读同步 {dateLabel(link.lastSyncedAt)}
                  </p>
                </div>
                <div className="platform-actions">
                  <button
                    className="button secondary"
                    disabled={mutateDisabled || !canRead || !provider?.capabilities.syncWork}
                    onClick={() =>
                      void action<ProjectPlatformWorkLink>(
                        `/platform-links/${encodeURIComponent(link.id)}/sync`,
                        'POST',
                        {},
                        (next) =>
                          setLinks((items) => items.map((item) => (item.id === next.id ? next : item))),
                        '已只读刷新作品资料。',
                      )
                    }
                  >
                    只读刷新资料
                  </button>
                  <button
                    className="button secondary"
                    disabled={mutateDisabled}
                    onClick={() =>
                      void action(
                        `/platform-links/${encodeURIComponent(link.id)}`,
                        'DELETE',
                        undefined,
                        () => {
                          setLinks((items) => items.filter((item) => item.id !== link.id));
                          if (linkId === link.id) {
                            setLinkId('');
                            resetPreview();
                          }
                        },
                        '已解除本机绑定，远端作品与草稿仍保留。',
                      )
                    }
                  >
                    <Unlink size={14} />
                    解绑
                  </button>
                </div>
              </article>
            ))}
        </div>
      </section>
      <section className="platform-card">
        <h2>单章草稿 · 先完整预览再批准</h2>
        <p className="platform-help">
          只使用已保存的正式本地章节，不上传编辑器未保存内容或未采用候选。历史草稿正文变化后不自动覆盖，也不另建重复稿。
        </p>
        <div className="platform-form">
          <label>
            目标作品
            <select
              value={linkId}
              disabled={mutateDisabled}
              onChange={(event) => {
                setLinkId(event.target.value);
                resetPreview();
              }}
            >
              <option value="">请选择该账号下的准确绑定作品</option>
              {links
                .filter((item) => item.connectionId === connectionId)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title} · {item.remoteWorkId}
                  </option>
                ))}
            </select>
          </label>
          <label>
            已保存章节
            <select
              value={chapterId}
              disabled={mutateDisabled}
              onChange={(event) => {
                setChapterId(event.target.value);
                resetPreview();
              }}
            >
              <option value="">请选择一章</option>
              {chapters.map((item) => (
                <option key={item.id} value={item.id}>
                  第 {item.number} 章 · {item.title} · 版本 {item.revision}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button primary"
            disabled={
              mutateDisabled ||
              !selectedLink ||
              !selectedChapter ||
              !canRead ||
              !provider?.capabilities.saveDraft
            }
            onClick={prepare}
          >
            准备完整预览（不会打开编辑器）
          </button>
        </div>
        {preview && (
          <div className="platform-form">
            <h3>确认目标与全部内容</h3>
            <p>
              账号：{preview.accountName}（{preview.accountId}）<br />
              作品：{preview.workTitle}（{preview.remoteWorkId}）<br />第 {preview.snapshot.number} 章 · 版本{' '}
              {preview.snapshot.revision}
            </p>
            <label>
              完整标题
              <input readOnly value={preview.snapshot.title} />
            </label>
            <label>
              完整正文
              <textarea rows={18} readOnly value={preview.snapshot.content} />
            </label>
            <p className="platform-help" style={{ overflowWrap: 'anywhere' }}>
              内容 SHA-256：{preview.snapshot.contentHash}
              <br />
              预览有效至 {dateLabel(preview.expiresAt)}
            </p>
            <p className="platform-notice">{preview.warning}</p>
            <label>
              <input
                type="checkbox"
                checked={approved}
                disabled={mutateDisabled}
                onChange={(event) => setApproved(event.target.checked)}
              />
              我已核对账号、作品、标题和完整正文，批准进入可能自动存稿的编辑器，仅保存本章草稿。
            </label>
            <button className="button primary" disabled={mutateDisabled || !approved} onClick={execute}>
              批准并保存这一章草稿（不发布）
            </button>
          </div>
        )}
      </section>
      <section className="platform-card">
        <h2>草稿操作与核实回执</h2>
        <p className="platform-help">
          操作记录独立于本地正文和正式发布状态。结果未知时仅允许只读核对；不自动续传、不批量补发。离开页面不等于撤销写入。
        </p>
        {!operations.length && <p className="platform-empty">还没有草稿操作。</p>}
        <div className="platform-list">
          {[...operations].reverse().map((operation) => (
            <article className="platform-row" key={operation.id}>
              <div className="platform-row-content">
                <strong>
                  第 {operation.chapterNumber} 章 · {operation.title}
                </strong>
                <p className="platform-help">
                  {stateLabels[operation.state]} · 版本 {operation.revision} · 作品 {operation.remoteWorkId} ·{' '}
                  {dateLabel(operation.verifiedAt || operation.updatedAt)}
                </p>
                {operation.error && <p role="alert">{operation.error}</p>}
                {operation.remoteDraftId && (
                  <p className="platform-help">远端草稿 ID：{operation.remoteDraftId}</p>
                )}
                {receipts
                  .filter((item) => item.operationId === operation.id)
                  .map((receipt) => (
                    <p className="platform-success" key={receipt.id}>
                      草稿已核实（非发布） · {dateLabel(receipt.verifiedAt)}
                      {chapters.some(
                        (item) =>
                          item.id === receipt.chapterId &&
                          (item.revision !== receipt.revision || item.contentHash !== receipt.contentHash),
                      )
                        ? ' · 本地有未同步修改；安全更新未开放'
                        : ''}
                    </p>
                  ))}
              </div>
              {operation.state === 'unknown' && (
                <button
                  className="button secondary"
                  disabled={mutateDisabled}
                  onClick={() =>
                    void action<DraftOperation>(
                      `/platform-operations/${encodeURIComponent(operation.id)}/reconcile`,
                      'POST',
                      {},
                      (next) => {
                        setOperations((items) => items.map((item) => (item.id === next.id ? next : item)));
                        setRefresh((value) => value + 1);
                      },
                      '已只读核对操作；没有重新发送正文。',
                    )
                  }
                >
                  只读核对，不重发
                </button>
              )}
            </article>
          ))}
        </div>
      </section>
      {busy && (
        <p className="platform-loading" role="status">
          <LoaderCircle className="spin" size={16} />
          正在处理明确请求…
        </p>
      )}
    </div>
  );
}

function MockCredentialForm({ disabled, onSave }: { disabled: boolean; onSave: (token: string) => void }) {
  const [token, setToken] = useState('');
  return (
    <form
      className="platform-form"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && token.trim()) {
          const value = token.trim();
          setToken('');
          onSave(value);
        }
      }}
    >
      <label>
        重新授权 Mock 连接
        <input
          type="password"
          autoComplete="new-password"
          value={token}
          disabled={disabled}
          onChange={(event) => setToken(event.target.value)}
          placeholder="任意非空测试令牌，不要输入真实密钥"
        />
      </label>
      <button className="button secondary" disabled={disabled || !token.trim()}>
        重新授权 Mock
      </button>
    </form>
  );
}
