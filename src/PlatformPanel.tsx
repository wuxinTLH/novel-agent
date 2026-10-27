import type { Project, WorkflowSettings } from '../shared/types';
import { useHiddenPlatformRecords } from './hooks/useHiddenPlatformRecords';
import { accessiblePlatformStep, platformStepAccess, type PlatformStep } from './hooks/platformSteps';
import { platformWorkChoices } from './hooks/platformWorkChoices';
import PublicationPanel, { ensureAutoApprovedBatchStarted } from './components/PublicationPanel';
import type { PublicationBatch } from '../shared/publication';
import { useConfirm } from './components/AppDialog';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronRight, Link2, LoaderCircle, RefreshCw, ShieldCheck, Trash2, Unlink, X } from 'lucide-react';
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
  PlatformId,
} from '../shared/platforms';

const messageOf = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请稍后查询状态。');
const dateLabel = (value?: string) => (value ? new Date(value).toLocaleString('zh-CN') : '尚未核验');
const readinessLabel = (provider?: PlatformProvider) =>
  provider?.readiness === 'ready' ? '可用' : provider?.readiness === 'mock' ? '本地测试'
    : provider?.readiness === 'needs_verification' ? '待核验' : '暂未开放';
const stateLabels: Record<DraftOperation['state'], string> = {
  queued: '已记录意图，等待执行',
  running: '正在执行',
  verified: '已重新打开核实保存',
  failed: '写入前失败',
  unknown: '结果未知，禁止重发',
  deleted: '远端草稿已删除',
};

export default function PlatformPanel({
  projectId,
  running,
  selectedChapterId,
  workflow,
  onProjectChange,
  selectedPlatform,
  onSelectPlatform,
  onBackToPlatforms,
}: {
  projectId: string;
  running: boolean;
  selectedChapterId?: string;
  workflow?: WorkflowSettings;
  onProjectChange?: (project: Project) => void;
  selectedPlatform: PlatformId | null;
  onSelectPlatform: (platform: PlatformId) => void;
  onBackToPlatforms: () => void;
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
  const [pendingWorkId, setPendingWorkId] = useState('');
  const [chapterId, setChapterId] = useState(selectedChapterId || '');
  const [works, setWorks] = useState<PlatformWork[]>([]);
  const [login, setLogin] = useState<PlatformLogin | null>(null);
  const [preview, setPreview] = useState<DraftPreparation | null>(null);
  const [incomingBatch, setIncomingBatch] = useState<PublicationBatch>();
  const [step, setStep] = useState<PlatformStep>('account');
  const [batchPreviewReady, setBatchPreviewReady] = useState(false);
  const [batchSelectionVersion, setBatchSelectionVersion] = useState(0);
  const history = useHiddenPlatformRecords(projectId, 'drafts');
  const [approved, setApproved] = useState(false);
  const [autoApprove, setAutoApprove] = useState(() => {
    try { return localStorage.getItem(`publication-auto-approve:${projectId}`) === 'true'; } catch { return false; }
  });
  const changeAutoApprove = (enabled: boolean) => {
    setAutoApprove(enabled);
    setApproved(false);
    try { localStorage.setItem(`publication-auto-approve:${projectId}`, String(enabled)); } catch { /* In-memory selection remains usable. */ }
  };
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
    setIncomingBatch(undefined);
    setStep('account');
    setBatchPreviewReady(false);
    setBatchSelectionVersion((value) => value + 1);
    setConnectionId('');
    setLinkId('');
    setPendingWorkId('');
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
    setConnectionId('');
    setLinkId('');
    setPendingWorkId('');
    setWorks([]);
    setIncomingBatch(undefined);
    setStep('account');
    setBatchPreviewReady(false);
    setBatchSelectionVersion((value) => value + 1);
    selectionVersion.current++;
    setPreview(null);
    setApproved(false);
  }, [selectedPlatform]);
  useEffect(() => {
    setChapterId(selectedChapterId || '');
    setPreview(null);
    setBatchPreviewReady(false);
    setBatchSelectionVersion((value) => value + 1);
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
  const connection = connections.find((item) => item.id === connectionId && item.providerId === selectedPlatform);
  const provider = providers.find((item) => item.id === connection?.providerId);
  const selectedLink = links.find((item) => item.id === linkId && item.connectionId === connectionId && item.providerId === selectedPlatform);
  const selectedChapter = chapters.find((item) => item.id === chapterId);
  const canRead =
    !!connection?.hasCredential && connection.status === 'connected' && !!provider?.capabilities.listWorks;
  const resetPreview = () => {
    selectionVersion.current++;
    setPreview(null);
    setBatchPreviewReady(false);
    setBatchSelectionVersion((value) => value + 1);
    setApproved(false);
  };
  const action = async <T,>(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    body: object | undefined,
    accept: (value: T) => void | Promise<void>,
    success: string | ((value: T) => string),
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
        ...(path === '/platform-publication-batches/prepare' ? { timeoutMs: 180_000 } : {}),
        signal: controller.signal,
        headers: {
          'X-Platform-CSRF': session.csrfToken,
          ...(method === 'GET' ? {} : { 'Idempotency-Key': key || crypto.randomUUID() }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (controller.signal.aborted) return;
      await accept(value);
      if (controller.signal.aborted) return;
      setNotice(typeof success === 'function' ? success(value) : success);
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
    setPendingWorkId('');
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
        if (version === selectionVersion.current) {
          setWorks(value);
          setPendingWorkId((id) => value.some((work) => work.id === id) ? id : '');
        }
      },
      '已只读获取所选账号的作品；尚未打开编辑器。',
    );
  };
  const prepare = () => {
    if (!selectedLink || !selectedChapter) return;
    const version = selectionVersion.current;
    if (autoApprove) {
      const controller = lifetime.current;
      if (!controller || !session) return;
      void action<PublicationBatch>(
        '/platform-publication-batches/prepare', 'POST',
        { linkId: selectedLink.id, chapterIds: [selectedChapter.id], action: 'save_draft', autoApprove: true },
        async (batch) => {
          setIncomingBatch(batch);
          const next = await ensureAutoApprovedBatchStarted(batch, true, (prepared) => api<PublicationBatch>(
            `${base}/platform-publication-batches/${encodeURIComponent(prepared.id)}/start`, {
              method: 'POST', signal: controller.signal,
              headers: { 'X-Platform-CSRF': session.csrfToken, 'Idempotency-Key': `auto-start:${prepared.id}` },
              body: JSON.stringify({ approvalHash: prepared.preview.hash, autoApprove: true }),
            },
          ));
          if (!controller.signal.aborted) {
            setIncomingBatch(next);
            setPreview(null);
            setApproved(false);
            setStep('results');
          }
        },
        '已处理单章自动授权请求；这不是上传成功回执。请查看下方队列的实际执行状态及远端回读核实结果。',
      );
      return;
    }
    void action<DraftPreparation>(
      '/platform-drafts/prepare',
      'POST',
      { linkId: selectedLink.id, chapterId: selectedChapter.id },
      (value) => {
        if (version === selectionVersion.current) {
          setPreview(value);
          setApproved(false);
          setStep('review');
        }
      },
      '仅已准备 1 章本地预览，未上传、未保存远端草稿、未提交审核。请在下方核对完整内容并点击“批准并保存这一章草稿”；多章上传请使用“远端上传 / 草稿送审队列”。',
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
        history.show(value.id);
        setPreview(null);
        setApproved(false);
        setStep('results');
        if (!['queued', 'running'].includes(value.state)) {
          setError(`该内容已有操作记录：${stateLabels[value.state]}。本次只返回原记录，没有重新上传；请在“草稿操作与核实回执”核对。`);
        }
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

  if (!selectedPlatform) return (
    <div className="platform-panel" aria-busy={loading}>
      <div className="platform-section-heading">
        <div><h2>选择平台</h2><p className="platform-help">进入平台后再管理账号、作品与章节上传；此页面不会访问远端或上传正文。</p></div>
        <button className="button secondary" disabled={loading} onClick={refreshLocal}><RefreshCw size={14} />刷新本地状态</button>
      </div>
      {error && <p className="platform-notice" role="alert">{error}</p>}
      {loading && <p className="platform-loading" role="status"><LoaderCircle className="spin" size={16} />正在读取平台信息…</p>}
      <div className="platform-provider-grid">
        {providers.map((item) => (
          <button type="button" className="platform-card platform-provider-entry" key={item.id} onClick={() => onSelectPlatform(item.id)}>
            <span className="platform-section-heading"><strong>{item.name}</strong><span className="platform-badge">{readinessLabel(item)}</span></span>
            <span className="platform-help">{item.description}</span>
            <span className="platform-help">{connections.filter((connection) => connection.providerId === item.id).length} 个本地账号 · {links.filter((link) => link.providerId === item.id).length} 个已绑定作品</span>
            <span className="platform-entry-next">进入平台 <ChevronRight size={16} /></span>
          </button>
        ))}
      </div>
    </div>
  );

  const selectedProvider = providers.find((item) => item.id === selectedPlatform);
  const platformConnections = connections.filter((item) => item.providerId === selectedPlatform);
  const platformLinks = links.filter((item) => item.providerId === selectedPlatform);
  const workChoices = platformWorkChoices(connectionId, works, platformLinks);
  const workSelection = selectedLink ? `link:${selectedLink.id}`
    : workChoices.some((choice) => choice.value === `work:${pendingWorkId}`) ? `work:${pendingWorkId}` : '';
  const supportsDrafts = selectedPlatform === 'tomato';
  const stepAccess = platformStepAccess({
    connected: platformConnections.some((item) => item.hasCredential && item.status === 'connected'),
    workBound: !!selectedLink && canRead,
    previewReady: (!!preview || batchPreviewReady) && !!selectedLink && canRead,
  });
  const visibleStep = accessiblePlatformStep(step, stepAccess);
  const steps: { id: PlatformStep; label: string; hint: string }[] = [
    { id: 'account', label: '核验账号', hint: '人工登录，确认作者身份' },
    { id: 'work', label: '绑定作品', hint: '选择账号，读取并绑定作品' },
    { id: 'setup', label: '选择章节', hint: '确定目标、分卷和正文' },
    { id: 'review', label: '预览并批准', hint: '逐章核对完整内容' },
    { id: 'results', label: '核对结果', hint: '回读回执与异常处理' },
  ];
  return (
    <div className="platform-panel" aria-busy={loading || busy}>
      <button type="button" className="button secondary platform-back" onClick={onBackToPlatforms}>← 返回平台作品</button>
      <div className="platform-section-heading"><h2>{selectedProvider?.name || selectedPlatform}</h2><span className="platform-badge">{readinessLabel(selectedProvider)}</span></div>
      <div className="platform-notice">
        <ShieldCheck size={18} />
        <p>
          第三方本机辅助工具，不是番茄官方 API
          或客户端。仅允许人工登录、完整预览并确认后保存或覆盖草稿及提交审核；支持回读核验，送审不等于已发布，不支持无人值守定时发布。
        </p>
      </div>
      {session && (
        <p className="platform-help">
          {session.persistentCredentials
            ? '会话通过本机 PLATFORM_SECRETS_KEY 加密保存；身份核验和读取成功后同步浏览器更新的 Cookie。网站真正撤销或过期的会话仍需人工登录，不会绕过验证码。'
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
        <p className="platform-notice" role="status">
          {notice}
        </p>
      )}
      <div className="platform-step-layout">
        <nav className="platform-step-nav" aria-label="平台操作步骤">
          <p className="platform-help">{autoApprove ? '自动审批模式 · 请核对结果' : '手动操作 · 按步骤完成'}</p>
          {steps.filter((item) => supportsDrafts || item.id === 'account' || item.id === 'work' || item.id === 'results').map((item, index) => (
            <button type="button" key={item.id} className={`platform-step-button ${visibleStep === item.id ? 'is-current' : ''}`}
              aria-current={visibleStep === item.id ? 'step' : undefined} disabled={!stepAccess[item.id]}
              onClick={() => setStep(item.id)}>
              <span className="platform-step-index">{index + 1}</span>
              <span><strong>{item.label}</strong><small>{item.hint}</small></span>
            </button>
          ))}
          <p className="platform-help">查看步骤不会自动登录、读取作品或上传。结果与异常可随时查看。</p>
        </nav>
        <div className="platform-step-content">
      {visibleStep === 'account' && <>
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
      {selectedProvider?.readinessReason && <p className="platform-help">{selectedProvider.readinessReason}</p>}
      {selectedPlatform === 'tomato' && (
        <button className="button primary" disabled={mutateDisabled || !selectedProvider?.capabilities.manualLogin} onClick={() => startLogin()}>
          <Link2 size={14} />打开独立浏览器人工登录
        </button>
      )}
      {selectedPlatform === 'mock' && (
        <details className="platform-advanced"><summary>创建本地 Mock 测试连接</summary>
          <form className="platform-form" onSubmit={connectMock} autoComplete="off">
            <label>任意非空演示令牌<input type="password" autoComplete="new-password" value={mockToken} onChange={(event) => setMockToken(event.target.value)} disabled={mutateDisabled} /></label>
            <button className="button secondary" disabled={mutateDisabled || !mockToken.trim()}>创建 Mock 连接</button>
          </form>
        </details>
      )}
      {!selectedProvider?.available && <p className="platform-notice">该平台目前未开放连接或上传；可以返回选择其他平台。</p>}
      {selectedPlatform === 'tomato' && login && (
        <section className="platform-card">
          <h3>本次人工登录</h3>
          <p>{login.message}</p>
          {activeLogin && (
            <p className="platform-help">
              点击核验后，已打开的隔离浏览器会自动进入番茄作者后台首页并读取登录身份；无需粘贴 Cookie、session 或 token。
            </p>
          )}
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
      {selectedProvider?.available && <section className="platform-card">
        <h3>当前项目连接</h3>
        {!platformConnections.length && (
          <p className="platform-empty">当前平台尚无已验证连接。登录窗口打开不等于验证成功。</p>
        )}
        <div className="platform-list">
          {platformConnections.map((item) => (
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
      </section>}
      {stepAccess.work && <button type="button" className="button primary platform-next" onClick={() => setStep('work')}>下一步：绑定作品 <ChevronRight size={14} /></button>}
      </>}
      {visibleStep === 'work' && <>
      {selectedProvider?.available && <section className="platform-card">
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
                setPendingWorkId('');
                resetPreview();
              }}
            >
              <option value="">请选择准确账号</option>
              {platformConnections.map((item) => (
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
                    (link) => {
                      setLinks((items) => [...items.filter((item) => item.id !== link.id), link]);
                      setLinkId(link.id);
                      setPendingWorkId('');
                      resetPreview();
                    },
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
        <label className="platform-form">
          本次操作的目标作品
          <select value={workSelection} disabled={mutateDisabled} onChange={(event) => {
            const value = event.target.value;
            setLinkId(value.startsWith('link:') ? value.slice(5) : '');
            setPendingWorkId(value.startsWith('work:') ? value.slice(5) : '');
            resetPreview();
          }}>
            <option value="">请选择作品；未绑定的作品需先绑定才能进入章节步骤</option>
            {workChoices.map((choice) => (
              <option value={choice.value} key={choice.value}>{choice.label}</option>
            ))}
          </select>
        </label>
        {pendingWorkId && works.some((work) => work.id === pendingWorkId) && (
          <button type="button" className="button secondary" disabled={mutateDisabled || !canRead}
            onClick={() => void action<ProjectPlatformWorkLink>(
              '/platform-links', 'POST', { connectionId, remoteWorkId: pendingWorkId },
              (link) => {
                setLinks((items) => [...items.filter((item) => item.id !== link.id), link]);
                setLinkId(link.id);
                setPendingWorkId('');
                resetPreview();
              },
              '已显式绑定所选作品；未上传章节。',
            )}>
            <Link2 size={14} /> 绑定所选作品
          </button>
        )}
        <div className="platform-list">
          {platformLinks
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
      </section>}
      {stepAccess.setup && <button type="button" className="button primary platform-next" onClick={() => setStep('setup')}>下一步：选择章节 <ChevronRight size={14} /></button>}
      </>}
      {supportsDrafts && (visibleStep === 'setup' || (visibleStep === 'review' && !!preview)) && <section className="platform-card">
        <h2>{visibleStep === 'setup' ? '单章草稿 · 选择正文' : '单章草稿 · 完整预览与批准'}</h2>
        <p className="platform-help">
          只使用已保存的正式本地章节，不上传编辑器未保存内容或未采用候选。历史草稿正文变化后不自动覆盖，也不另建重复稿。
        </p>
        {visibleStep === 'setup' && <div className="platform-form">
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
              {platformLinks
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
            {autoApprove ? '自动批准并上传单章草稿' : '准备完整预览（不会打开编辑器）'}
          </button>
        </div>}
        {preview && visibleStep === 'setup' && (
          <button className="button secondary" disabled={busy} onClick={resetPreview}>清除本地暂存预览（不删除正文）</button>
        )}
        {preview && visibleStep === 'review' && (
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
            {error && <p className="platform-notice" role="alert">本次操作未完成：{error} 不会自动重发；原预览保留供核对。</p>}
            <p className="platform-help" role="status">
              {loading ? '正在加载平台状态，请稍候。' : busy ? '正在处理平台请求，请等待完成。' : running ? '创作工作流仍在运行，请等待结束或先停止工作流，再批准上传。' : !session?.available ? '平台服务尚未就绪，请刷新本地状态。' : activeOperation ? '已有草稿操作排队或执行中，请先查询操作记录。' : activeLogin ? '人工登录尚未完成，请先核验作者身份。' : !approved ? '尚未批准：请勾选上方“我已核对账号、作品、标题和完整正文”后再保存。' : '已满足本地批准条件，可保存草稿；执行时仍会验证远端状态。'}
              此入口仅保存草稿，不提交审核；送审请使用下方队列并选择“提交审核”。
            </p>
            <button className="button primary" disabled={mutateDisabled || !approved} onClick={execute}>
              批准并保存这一章草稿（不发布）
            </button>
          </div>
        )}
        {preview && visibleStep === 'setup' && <button type="button" className="button primary platform-next" onClick={() => setStep('review')}>下一步：核对完整预览 <ChevronRight size={14} /></button>}
      </section>}
      {supportsDrafts && visibleStep === 'results' && <section className="platform-card">
        <h2>草稿操作与核实回执</h2>
        <button className="button secondary" disabled={mutateDisabled} onClick={async () => {
          if (!(await confirmDialog('将备份并清空当前作品的本地平台预览、操作、回执与全部批次（包括隐藏记录），解除历史去重阻塞。不会删除本地章节、登录绑定或番茄正文。之后上传可能产生重复章节，请先核对官方后台。确认承担重复风险并清空？', { danger: true, confirmText: '确认备份并清空' }))) return;
          void action('/platform-staging/clear', 'POST', { confirmed: true, acknowledgeDuplicateRisk: true }, () => {
            resetPreview(); setOperations([]); setReceipts([]); history.restore(); setRefresh(value => value + 1);
          }, '已备份并清空本作品本地平台记录；未删除远端内容，未自动重传。');
        }}>备份并清空本地暂存（解除历史阻塞）</button>
        <p className="platform-help">
          操作记录独立于本地正文和正式发布状态。保存后会回读核验；结果未知时仅允许只读核对。已核实草稿可在确认后从番茄作者页删除，删除后再次读取列表确认，不自动发布或批量补发。
        </p>
        {history.hiddenIds.length > 0 && <p className="platform-notice">已隐藏 {operations.filter(item => history.hiddenIds.includes(item.id)).length} 条本地记录；服务端审计和未知操作防重复限制仍保留。<button className="button secondary" onClick={history.restore}>恢复显示全部历史</button></p>}
        {!operations.length && <p className="platform-empty">还没有草稿操作。</p>}
        <div className="platform-list">
          {[...operations].reverse().filter(operation => !history.hiddenIds.includes(operation.id)).map((operation) => (
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
                {operation.state === 'deleted' && (
                  <p className="platform-help">已在番茄作者页确认该草稿已删除；本地操作记录保留用于审计。</p>
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
              {!['queued', 'running'].includes(operation.state) && <button className="button secondary" onClick={async () => {
                if (await confirmDialog('仅从当前浏览器隐藏此历史记录，不删除番茄草稿或本地正文，不解除未知操作防重复限制；可以恢复显示。是否继续？')) history.hide(operation.id);
              }}>移出本地暂存列表</button>}
              {operation.state === 'verified' && operation.remoteDraftId && (
                <button
                  className="button secondary"
                  disabled={mutateDisabled}
                  onClick={async () => {
                    if (
                      !(await confirmDialog(
                        `将从番茄作者页永久删除草稿“${operation.title}”（远端 ID：${operation.remoteDraftId}）。此操作不可撤销，是否继续？`,
                      ))
                    )
                      return;
                    void action<DraftOperation>(
                      `/platform-operations/${encodeURIComponent(operation.id)}/draft`,
                      'DELETE',
                      { approved: true },
                      (next) => {
                        setOperations((items) => items.map((item) => (item.id === next.id ? next : item)));
                        setReceipts((items) => items.filter((item) => item.operationId !== next.id));
                        setRefresh((value) => value + 1);
                      },
                      '已在番茄作者页删除并确认该草稿不再出现在草稿列表。',
                    );
                  }}
                >
                  <Trash2 size={14} />
                  删除远端草稿
                </button>
              )}
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
      </section>}
      {supportsDrafts && <PublicationPanel selectionVersion={batchSelectionVersion} incomingBatch={incomingBatch} targetLinkId={linkId} projectId={projectId} csrfToken={session?.csrfToken ?? ''} links={platformLinks} chapters={chapters} disabled={mutateDisabled} reviewAvailable={true} autoApprove={autoApprove} onAutoApproveChange={changeAutoApprove} workflow={workflow} onProjectChange={onProjectChange} step={visibleStep} onPreviewReady={() => { setBatchPreviewReady(true); setStep('review'); }} onShowResults={() => setStep('results')} />}
      {visibleStep === 'review' && supportsDrafts && <button type="button" className="button secondary platform-next" onClick={() => setStep('results')}>查看队列与回执 <ChevronRight size={14} /></button>}
      {busy && (
        <p className="platform-loading" role="status">
          <LoaderCircle className="spin" size={16} />
          正在处理明确请求…
        </p>
      )}
        </div>
      </div>
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
