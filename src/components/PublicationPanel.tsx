import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { PlatformChapterChoice, ProjectPlatformWorkLink } from '../../shared/platforms';
import type { Project, WorkflowSettings } from '../../shared/types';
import type { PublicationAction, PublicationBatch, PublicationItem } from '../../shared/publication';

export interface PublicationPanelProps {
  projectId: string;
  csrfToken: string;
  links: ProjectPlatformWorkLink[];
  chapters: PlatformChapterChoice[];
  disabled: boolean;
  reviewAvailable: boolean;
  autoApprove: boolean;
  onAutoApproveChange: (enabled: boolean) => void;
  workflow?: WorkflowSettings;
  onProjectChange?: (project: Project) => void;
}

const batchLabels: Record<PublicationBatch['state'], string> = {
  preview: '待人工批准',
  queued: '已排队',
  running: '正在执行',
  paused: '已暂停',
  completed: '队列处理完成（不代表已发布）',
  failed: '失败，未自动重试',
  unknown: '结果未知，禁止盲目重发',
};
const itemLabels: Record<PublicationItem['state'], string> = {
  queued: '等待执行',
  running: '正在执行',
  draft_verified: '草稿已回读核实（未发布）',
  submitted: '已提交审核（不代表已发布）',
  failed: '失败，未自动重试',
  unknown: '结果未知，禁止重发',
};
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : '操作失败，请先刷新本地队列核对状态。';
const active = (batch: PublicationBatch) => batch.state === 'queued' || batch.state === 'running';
const uncertain = (batch: PublicationBatch) =>
  batch.state === 'unknown' || batch.items.some((item) => item.state === 'unknown');
const actionLabel = (action: PublicationAction) =>
  action === 'save_draft' ? '保存草稿（不发布）' : '提交审核（不代表发布）';

/** Key the stateful panel so a project switch cannot retain approvals or stale requests. */
export default function PublicationPanel(props: PublicationPanelProps) {
  return <ProjectPublicationPanel key={props.projectId} {...props} />;
}

function ProjectPublicationPanel({
  projectId,
  csrfToken,
  links,
  chapters,
  disabled,
  reviewAvailable,
  autoApprove,
  onAutoApproveChange,
  workflow,
  onProjectChange,
}: PublicationPanelProps) {
  const base = `/projects/${encodeURIComponent(projectId)}/platform-publication-batches`;
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const [batches, setBatches] = useState<PublicationBatch[]>([]);
  const [linkId, setLinkId] = useState('');
  const [volumes, setVolumes] = useState<{ id: string; name: string }[]>([]);
  const [volumeId, setVolumeId] = useState('');
  const [volumeLoading, setVolumeLoading] = useState(false);
  const [volumeError, setVolumeError] = useState('');
  const [chapterIds, setChapterIds] = useState<string[]>([]);
  const [action, setAction] = useState<PublicationAction>('save_draft');
  const [useAi, setUseAi] = useState<'' | '1' | '2'>('');
  const [selectedId, setSelectedId] = useState('');
  const [approval, setApproval] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const readVersion = useRef(0);
  const startKeys = useRef(new Map<string, string>());
  const hasActive = batches.some(active);
  const hasUnknown = batches.some(uncertain);
  const selected = batches.find((batch) => batch.id === selectedId);
  const selectedLink = links.find((link) => link.id === linkId && link.projectId === projectId);
  const savedChapters = [...chapters].sort((a, b) => a.number - b.number || a.id.localeCompare(b.id));
  const validIds = new Set(chapters.map((chapter) => chapter.id));
  const selectionValid =
    chapterIds.length > 0 && chapterIds.length <= 50 && chapterIds.every((id) => validIds.has(id));
  const locked = disabled || busy || loading || !csrfToken;
  const approvalKey = selected ? `${selected.id}:${selected.preview.hash}` : '';
  const reviewBlocked =
    selected?.preview.action === 'submit_review' &&
    (!reviewAvailable || (selected.preview.useAi !== 1 && selected.preview.useAi !== 2));

  const refresh = useCallback(
    async (signal: AbortSignal) => {
      if (pending.current || signal.aborted) return;
      const version = ++readVersion.current;
      try {
        const next = await api<PublicationBatch[]>(base, { signal });
        if (signal.aborted || version !== readVersion.current || pending.current) return;
        setBatches(next);
        setNeedsRefresh(false);
        setError('');
      } catch (failure) {
        if (!signal.aborted && version === readVersion.current) setError(messageOf(failure));
      } finally {
        if (!signal.aborted && version === readVersion.current) setLoading(false);
      }
    },
    [base],
  );

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void refresh(controller.signal);
    return () => {
      controller.abort();
      readVersion.current++;
    };
  }, [refresh]);

  // Timers only read the local queue. Starting/resuming always requires a button click.
  useEffect(() => {
    if (!hasActive) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refresh(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1500);
    };
    timer = setTimeout(() => void poll(), 1500);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [hasActive, refresh]);

  useEffect(() => {
    const controller = new AbortController();
    setVolumes([]);
    setVolumeId('');
    setVolumeError('');
    if (!linkId) { setVolumeLoading(false); return () => controller.abort(); }
    setVolumeLoading(true);
    void api<{ id: string; name: string }[]>(`${base}/volumes?linkId=${encodeURIComponent(linkId)}`, { signal: controller.signal, timeoutMs: 60_000 })
      .then((items) => {
        if (controller.signal.aborted) return;
        setVolumes(items);
        if (items.length === 1) setVolumeId(items[0].id);
      })
      .catch((failure) => { if (!controller.signal.aborted) setVolumeError(messageOf(failure)); })
      .finally(() => { if (!controller.signal.aborted) setVolumeLoading(false); });
    return () => controller.abort();
  }, [base, linkId]);

  const post = async (path: string, body: object, key: string) => {
    const controller = lifetime.current;
    if (locked || pending.current || !controller || controller.signal.aborted) return;
    pending.current = true;
    readVersion.current++;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await api<PublicationBatch>(`${base}${path}`, {
        method: 'POST',
        timeoutMs: path === '/prepare' || path.endsWith('/reconcile') ? 180_000 : 30_000,
        signal: controller.signal,
        headers: { 'X-Platform-CSRF': csrfToken, 'Idempotency-Key': key },
        body: JSON.stringify(body),
      });
      if (controller.signal.aborted) return;
      setBatches((current) => [next, ...current.filter((batch) => batch.id !== next.id)]);
      setSelectedId(next.id);
      setApproval('');
      setNeedsRefresh(false);
      setNotice(
        path === '/prepare'
          ? '已生成已保存章节的完整快照；尚未执行远端写入。'
          : '已记录人工请求，请以队列逐章状态为准。',
      );
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(`${messageOf(failure)} 未自动重试；请先刷新本地队列核对结果。`);
        setNeedsRefresh(true);
        setApproval('');
      }
    } finally {
      if (!controller.signal.aborted) {
        pending.current = false;
        setBusy(false);
      }
    }
  };

  const prepare = () => {
    if (
      !selectedLink ||
      !selectionValid ||
      needsRefresh ||
      hasUnknown ||
      (action === 'submit_review' && (!reviewAvailable || !useAi))
    )
      return;
    const selectedIds = savedChapters
      .filter((chapter) => chapterIds.includes(chapter.id))
      .map((chapter) => chapter.id);
    void post(
      '/prepare',
      {
        linkId,
        chapterIds: selectedIds,
        action,
        autoApprove,
        ...(volumeId ? { volumeId } : {}),
        ...(action === 'submit_review' && useAi ? { useAi: Number(useAi) } : {}),
      },
      crypto.randomUUID(),
    );
  };
  const execute = (batch: PublicationBatch, operation: 'start' | 'resume') => {
    if (
      (!autoApprove && approval !== `${batch.id}:${batch.preview.hash}`) ||
      uncertain(batch) ||
      hasUnknown ||
      needsRefresh ||
      (batch.preview.action === 'submit_review' &&
        (!reviewAvailable || (batch.preview.useAi !== 1 && batch.preview.useAi !== 2)))
    )
      return;
    if (operation === 'start' && batch.state !== 'preview') return;
    if (operation === 'resume' && batch.state !== 'paused') return;
    let key = operation === 'start' ? startKeys.current.get(batch.id) : undefined;
    if (!key) {
      key = crypto.randomUUID();
      if (operation === 'start') startKeys.current.set(batch.id, key);
    }
    void post(
      `/${encodeURIComponent(batch.id)}/${operation}`,
      { approvalHash: batch.preview.hash, ...(autoApprove ? { autoApprove: true } : { approved: true }) },
      key,
    );
  };

  const saveWorkflowPublication = async (enabled: boolean) => {
    const controller = lifetime.current;
    if (!workflow?.id || !controller || controller.signal.aborted || locked || workflowBusy) return;
    if (enabled && (!selectedLink || !volumeId || (action === 'submit_review' && !useAi))) {
      setError('请先选择绑定作品、目标卷和送审所需的 AI 声明，再启用工作流自动上传。');
      return;
    }
    setWorkflowBusy(true);
    setError('');
    try {
      const next = await api<Project>(`/projects/${encodeURIComponent(projectId)}/workflow`, {
        method: 'PUT', signal: controller.signal,
        body: JSON.stringify({ workflowId: workflow.id, expectedGraphRevision: workflow.graphRevision ?? 0,
          automationMode: 'automatic', publication: { enabled, linkId: selectedLink?.id || workflow.publication?.linkId || '',
            ...(volumeId ? { volumeId } : {}), action, ...(action === 'submit_review' && useAi ? { useAi: Number(useAi) } : {}) } }),
      });
      if (!controller.signal.aborted) {
        onProjectChange?.(next);
        setNotice(enabled ? '已保存：此工作流成功完成后，将自动上传/送审，无需人工批准。' : '已关闭工作流完成后的远端上传。');
      }
    } catch (failure) { if (!controller.signal.aborted) setError(messageOf(failure)); }
    finally { if (!controller.signal.aborted) setWorkflowBusy(false); }
  };

  return (
    <section className="platform-card">
      <h2>远端上传 / 草稿送审队列</h2>
      <p className="platform-help">
        仅使用已保存的正式章节，不包含编辑器未保存内容或未采用候选；按章节号排序，每批最多 50 章。
        关闭自动审批时，先核对完整预览再人工批准；开启后，点击准备即自动批准并启动上传或送审。
        自动化工作流完成后可自动接续已配置的远端操作。平台审核、验证码与风控不会被绕过。
      </p>
      <p className="platform-help">不会自动勾选 AI、原创性或其他声明。提交审核不等于已发布。</p>
      <p className="platform-help">番茄分离章号/标题编辑器支持“第1章 标题”和“第 1 章 标题”，数字须与本地章号一致；只适配章号格式，不改写正文。</p>
      {!reviewAvailable && (
        <p className="platform-notice">提交审核尚未通过官方精确确认流程核验，目前仅允许保存草稿。</p>
      )}
      {error && (
        <p className="platform-notice" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="platform-success" role="status">
          {notice}
        </p>
      )}
      <div className="platform-form">
        <label className="checkbox-label">
          <input type="checkbox" checked={autoApprove} disabled={locked} onChange={(event) => {
            const enabled = event.target.checked;
            onAutoApproveChange(enabled);
            setApproval('');
          }} />
          自动审批：后续操作跳过本地人工批准，准备后直接上传 / 送审
        </label>
        {autoApprove && <p className="platform-notice">已启用自动授权；仍会核验账号、目标卷、完整正文及重复操作。平台审核不受此开关影响。</p>}
        <label>
          目标绑定作品
          <select value={linkId} disabled={locked} onChange={(event) => setLinkId(event.target.value)}>
            <option value="">请选择准确的账号与作品</option>
            {links
              .filter((link) => link.projectId === projectId)
              .map((link) => (
                <option key={link.id} value={link.id}>
                  {link.title} · {link.providerId} · 账号 {link.accountId} · 作品 {link.remoteWorkId}
                </option>
              ))}
          </select>
        </label>
        {selectedLink && (
          <p className="platform-help">
            连接 ID：{selectedLink.connectionId} · 绑定 ID：{selectedLink.id} · 作品版本：
            {selectedLink.revision}
          </p>
        )}
        <label>
          远端分卷（只读获取；唯一卷自动选中）
          <select value={volumeId} disabled={locked || volumeLoading || !selectedLink} onChange={(event) => setVolumeId(event.target.value)}>
            <option value="">{volumeLoading ? '正在读取番茄分卷…' : '自动定位已有章节；新建章节请选卷'}</option>
            {volumes.map((volume) => <option key={volume.id} value={volume.id}>{volume.name} · {volume.id}</option>)}
          </select>
        </label>
        {volumeError && <p className="platform-notice" role="alert">分卷读取失败：{volumeError}</p>}
        <p className="platform-help">相同章号的可编辑草稿会在预览中标注“覆盖”，保留远端 ID；已发布或审核中章节不会通过草稿流程强行覆盖。</p>
        <label>
          操作
          <select
            value={action}
            disabled={locked}
            onChange={(event) => {
              setAction(event.target.value as PublicationAction);
              setUseAi('');
            }}
          >
            <option value="save_draft">保存草稿（不发布）</option>
            <option value="submit_review" disabled={!reviewAvailable}>
              提交审核（不代表发布）
            </option>
          </select>
        </label>
        {action === 'submit_review' && (
          <label>
            是否使用AI（必选，不设默认值）
            <select
              required
              value={useAi}
              disabled={locked || !reviewAvailable}
              onChange={(event) => setUseAi(event.target.value as '' | '1' | '2')}
            >
              <option value="">请根据实际情况明确选择</option>
              <option value="1">是</option>
              <option value="2">否</option>
            </select>
          </label>
        )}
        <fieldset disabled={locked}>
          <legend>选择已保存章节（{chapterIds.length} / 50）</legend>
          {!savedChapters.length && <p className="platform-empty">暂无已保存章节。</p>}
          {savedChapters.map((chapter) => (
            <label key={chapter.id}>
              <input
                type="checkbox"
                checked={chapterIds.includes(chapter.id)}
                disabled={!chapterIds.includes(chapter.id) && chapterIds.length >= 50}
                onChange={(event) =>
                  setChapterIds((current) =>
                    event.target.checked
                      ? current.includes(chapter.id) || current.length >= 50
                        ? current
                        : [...current, chapter.id]
                      : current.filter((id) => id !== chapter.id),
                  )
                }
              />
              第 {chapter.number} 章 · {chapter.title} · 已保存版本 {chapter.revision}
            </label>
          ))}
        </fieldset>
        {workflow?.id && <div className="platform-notice">
          <strong>自动化工作流远端接续</strong>
          <p>当前工作流：{workflow.name || workflow.id}。启用后，完整工作流成功生成并保存章节，即按下列明确绑定自动上传 / 送审，不再等待人工批准。演示运行、失败或未通过校验的章节不会上传。</p>
          {workflow.publication?.enabled && <p>已配置：绑定 {workflow.publication.linkId} · {actionLabel(workflow.publication.action)} · 分卷 {workflow.publication.volumeId || '按既有章节定位'}</p>}
          <button type="button" className="button secondary" disabled={locked || workflowBusy || !selectedLink || !volumeId || (action === 'submit_review' && !useAi)} onClick={() => void saveWorkflowPublication(true)}>保存当前选择并启用全自动接续</button>
          {workflow.publication?.enabled && <button type="button" className="button secondary" disabled={locked || workflowBusy} onClick={() => void saveWorkflowPublication(false)}>关闭工作流远端接续</button>}
        </div>}
        <button
          className="button primary"
          disabled={
            locked ||
            needsRefresh ||
            hasUnknown ||
            !selectedLink ||
            !selectionValid ||
            (action === 'submit_review' && (!reviewAvailable || !useAi))
          }
          onClick={prepare}
        >
          {autoApprove ? '自动批准并开始上传 / 送审' : '准备全部章节完整预览（不写入远端）'}
        </button>
        <button
          className="button secondary"
          disabled={busy || loading}
          onClick={() => {
            const controller = lifetime.current;
            if (controller && !controller.signal.aborted) {
              setApproval('');
              setLoading(true);
              void refresh(controller.signal);
            }
          }}
        >
          刷新本地队列状态（只读）
        </button>
      </div>
      {workflow && onProjectChange && (
        <div className="platform-notice">
          <strong>自动化工作流接续</strong>
          <p>当前工作流：{workflow.name || workflow.id}。启用后，成功生成并校验的正式章节将按顺序自动上传或送审，跳过人工批准。</p>
          <p>{workflow.publication?.enabled ? `已开启 · 绑定 ${workflow.publication.linkId} · ${actionLabel(workflow.publication.action)}` : '尚未开启远端接续；不会猜测账号、作品或目标卷。'}</p>
          <button className="button secondary" disabled={locked || workflowBusy || !selectedLink || !volumeId || (action === 'submit_review' && !useAi)} onClick={() => void saveWorkflowPublication(true)}>使用上方目标启用 / 更新全自动工作流</button>
          {workflow.publication?.enabled && <button className="button secondary" disabled={locked || workflowBusy} onClick={() => void saveWorkflowPublication(false)}>关闭工作流远端接续</button>}
        </div>
      )}
      {loading && (
        <p className="platform-loading" role="status">
          正在读取本地队列…
        </p>
      )}
      {busy && (
        <p className="platform-loading" role="status">
          正在处理人工请求，不会自动重试…
        </p>
      )}
      <div className="platform-list">
        {!loading && !batches.length && <p className="platform-empty">暂无批次。</p>}
        {batches.map((batch) => (
          <article className="platform-row" key={batch.id}>
            <div className="platform-row-content">
              <strong>
                {batch.preview.target.workTitle} · {actionLabel(batch.preview.action)}
              </strong>
              <p className="platform-help">
                批次 {batch.id} · {batchLabels[batch.state]} · {batch.items.length} 章
              </p>
              {batch.approval && <p className="platform-help">审批方式：{batch.approval.mode === 'automatic' ? '自动审批' : '人工审批'} · {new Date(batch.approval.approvedAt).toLocaleString('zh-CN')}</p>}
              {batch.pauseRequested && (
                <p className="platform-notice">已请求暂停：当前一章结束后停止，不会撤销已开始的写入。</p>
              )}
              {batch.error && <p role="alert">{batch.error}</p>}
              {uncertain(batch) && (
                <p className="platform-notice">
                  存在未知结果。请到官方作者页只读核对，禁止盲目重试、重新建批补发或恢复。
                </p>
              )}
              <ol>
                {[...batch.items]
                  .sort((a, b) => a.snapshot.number - b.snapshot.number)
                  .map((item) => (
                    <li key={item.id}>
                      第 {item.snapshot.number} 章 · {item.snapshot.title}：{itemLabels[item.state]}
                      {item.remoteDraftId && <> · 远端草稿 ID：{item.remoteDraftId}</>}
                      {item.error && <p role="alert">{item.error}</p>}
                    </li>
                  ))}
              </ol>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  setSelectedId(batch.id);
                  setApproval('');
                }}
              >
                查看全部快照与批准
              </button>
              {uncertain(batch) && (
                <button className="button secondary" disabled={locked || needsRefresh} onClick={() => void post(`/${encodeURIComponent(batch.id)}/reconcile`, {}, crypto.randomUUID())}>
                  只读核对远端结果（不重发）
                </button>
              )}
              {active(batch) && (
                <button
                  className="button secondary"
                  disabled={locked || batch.pauseRequested || needsRefresh}
                  onClick={() => void post(`/${encodeURIComponent(batch.id)}/pause`, {}, crypto.randomUUID())}
                >
                  当前一章后暂停
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {selected && (
        <div className="platform-form">
          <h3>完整预览 · {actionLabel(selected.preview.action)}</h3>
          <p>
            平台：{selected.preview.target.providerId}
            <br />
            账号：{selected.preview.target.accountName}（{selected.preview.target.accountId}）<br />
            作品：{selected.preview.target.workTitle}（{selected.preview.target.remoteWorkId}）<br />
            项目 ID：{selected.preview.target.projectId}
            <br />
            连接 ID：{selected.preview.target.connectionId}
            <br />
            绑定 ID：{selected.preview.target.linkId}
            <br />
            作品版本：{selected.preview.target.workRevision}
          </p>
          {selected.preview.action === 'submit_review' && (
            <p className="platform-notice">
              本批送审声明 · 是否使用AI：
              {selected.preview.useAi === 1
                ? '是'
                : selected.preview.useAi === 2
                  ? '否'
                  : '未选择（禁止送审，请重新准备）'}
              。此声明与预览哈希绑定。
            </p>
          )}
          <p className="platform-help">
            预览 ID：{selected.preview.id} · 快照生成时间：
            {new Date(selected.preview.createdAt).toLocaleString('zh-CN')} · 批准哈希：{selected.preview.hash}
          </p>
          {[...selected.preview.chapters]
            .sort((a, b) => a.number - b.number)
            .map((snapshot) => (
              <div className="platform-form" key={snapshot.chapterId}>
                <h4>
                  第 {snapshot.number} 章 · 已保存版本 {snapshot.revision}
                </h4>
                {selected.preview.remotePlan?.filter((plan) => plan.chapterId === snapshot.chapterId).map((plan) => (
                  <p className="platform-notice" key={plan.chapterId}>
                    分卷：{plan.volumeName}（{plan.volumeId}） · 操作：{plan.mode === 'overwrite' ? '覆盖已有草稿' : plan.mode === 'reuse' ? '复用已一致草稿' : '新建草稿'}
                    {plan.mode !== 'create' && <> · 远端章节 ID：{plan.remoteDraftId} · 覆盖前指纹：{plan.expectedRemoteFingerprint}</>}
                  </p>
                ))}
                <label>
                  完整标题
                  <input readOnly value={snapshot.title} />
                </label>
                <label>
                  完整正文
                  <textarea rows={18} readOnly value={snapshot.content} />
                </label>
                <p className="platform-help">
                  章节 ID：{snapshot.chapterId} · 内容 SHA-256：{snapshot.contentHash}
                </p>
              </div>
            ))}
          {(selected.state === 'preview' || selected.state === 'paused') && !uncertain(selected) && (
            <>
              {reviewBlocked && (
                <p className="platform-notice">官方提交确认未核验或缺少明确 AI 声明，禁止启动或恢复送审。</p>
              )}
              {!autoApprove && <label>
                <input
                  type="checkbox"
                  checked={approval === approvalKey}
                  disabled={locked || needsRefresh || hasUnknown || reviewBlocked}
                  onChange={(event) => setApproval(event.target.checked ? approvalKey : '')}
                />
                我已逐章核对上述账号、目标作品、章节顺序、全部标题与完整正文，明确批准本批次
                {actionLabel(selected.preview.action)}；不会自动同意任何 AI 或原创性声明。
              </label>}
              <button
                className="button primary"
                disabled={
                  locked ||
                  needsRefresh ||
                  hasUnknown ||
                  reviewBlocked ||
                  (!autoApprove && approval !== approvalKey) ||
                  selected.preview.chapters.length === 0 ||
                  selected.preview.chapters.length > 50
                }
                onClick={() => execute(selected, selected.state === 'paused' ? 'resume' : 'start')}
              >
                {autoApprove ? (selected.state === 'paused' ? '自动批准并恢复剩余队列' : '自动批准并启动此批次') : (selected.state === 'paused' ? '人工批准恢复剩余队列' : '人工批准并启动此批次')}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
