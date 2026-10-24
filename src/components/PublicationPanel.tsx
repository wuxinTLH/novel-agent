import { useCallback, useEffect, useRef, useState } from 'react';
import { useHiddenPlatformRecords } from '../hooks/useHiddenPlatformRecords';
import { useConfirm } from './AppDialog';
import { api } from '../api';
import type { PlatformChapterChoice, ProjectPlatformWorkLink } from '../../shared/platforms';
import type { Project, WorkflowSettings } from '../../shared/types';
import type { PublicationAction, PublicationBatch, PublicationItem } from '../../shared/publication';
import type { PlatformStep } from '../hooks/platformSteps';

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
  incomingBatch?: PublicationBatch;
  targetLinkId: string;
  selectionVersion: number;
  step: PlatformStep;
  onPreviewReady: () => void;
  onShowResults: () => void;
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

export async function ensureAutoApprovedBatchStarted(
  batch: PublicationBatch,
  autoApprove: boolean,
  start: (batch: PublicationBatch) => Promise<PublicationBatch>,
): Promise<PublicationBatch> {
  // Current servers start during prepare. Never start an already-running or terminal batch again.
  return autoApprove && batch.state === 'preview' ? start(batch) : batch;
}

export function publicationApprovalReady(batch: PublicationBatch, autoApprove: boolean, approval: string): boolean {
  return batch.preview.autoApprove ? autoApprove : approval === `${batch.id}:${batch.preview.hash}`;
}

export const publicationOutcome = (batch: PublicationBatch) => {
  const verified = batch.items.filter((item) => item.state === 'draft_verified').length;
  const submitted = batch.items.filter((item) => item.state === 'submitted').length;
  const counts = `远端回读核实草稿 ${verified} / ${batch.items.length} 章；已提交审核 ${submitted} / ${batch.items.length} 章（不代表已发布）。`;
  return batch.state === 'preview'
    ? `仅已准备 ${batch.items.length} 章本地预览，未启动上传、未提交审核。请核对全部快照后批准启动。${counts}`
    : `${batchLabels[batch.state]}。${counts} 排队、运行、失败或结果未知均不算上传成功。`;
};

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
  incomingBatch,
  targetLinkId,
  selectionVersion,
  step,
  onPreviewReady,
  onShowResults,
}: PublicationPanelProps) {
  const history = useHiddenPlatformRecords(projectId, 'batches');
  const confirmDialog = useConfirm();
  const base = `/projects/${encodeURIComponent(projectId)}/platform-publication-batches`;
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const [batches, setBatches] = useState<PublicationBatch[]>([]);
  const linkId = targetLinkId;
  const [volumes, setVolumes] = useState<{ id: string; name: string }[]>([]);
  const [volumeId, setVolumeId] = useState('');
  const [volumeLoading, setVolumeLoading] = useState(false);
  const [volumeError, setVolumeError] = useState('');
  const [chapterIds, setChapterIds] = useState<string[]>([]);
  const [action, setAction] = useState<PublicationAction>('save_draft');
  const [useAi, setUseAi] = useState<'' | '1' | '2'>('');
  const [selectedId, setSelectedId] = useState('');
  const [approval, setApproval] = useState('');
  const [reconcileIds, setReconcileIds] = useState<Record<string, string>>({});
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
  const targetChanged = !!selected && selected.preview.target.linkId !== targetLinkId;

  useEffect(() => {
    setApproval('');
    setSelectedId('');
    setChapterIds([]);
    setAction('save_draft');
    setUseAi('');
  }, [selectionVersion]);

  useEffect(() => {
    setApproval('');
    setChapterIds([]);
  }, [targetLinkId]);

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

  useEffect(() => {
    if (!incomingBatch || incomingBatch.preview.target.projectId !== projectId) return;
    readVersion.current++;
    setBatches((current) => [incomingBatch, ...current.filter((batch) => batch.id !== incomingBatch.id)]);
    setSelectedId(incomingBatch.id);
    setLoading(false);
    setNeedsRefresh(false);
    setApproval('');
    setNotice(publicationOutcome(incomingBatch));
    history.show(incomingBatch.id);
  }, [incomingBatch, projectId]);

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
      let next = await api<PublicationBatch>(`${base}${path}`, {
        method: 'POST',
        timeoutMs: path === '/prepare' || path.endsWith('/reconcile') ? 180_000 : 30_000,
        signal: controller.signal,
        headers: { 'X-Platform-CSRF': csrfToken, 'Idempotency-Key': key },
        body: JSON.stringify(body),
      });
      if (controller.signal.aborted) return;
      setBatches((current) => [next, ...current.filter((batch) => batch.id !== next.id)]);
      setSelectedId(next.id);
      if (path === '/prepare') {
        next = await ensureAutoApprovedBatchStarted(next, 'autoApprove' in body && body.autoApprove === true, async (batch) => {
          let startKey = startKeys.current.get(batch.id);
          if (!startKey) {
            startKey = crypto.randomUUID();
            startKeys.current.set(batch.id, startKey);
          }
          return api<PublicationBatch>(`${base}/${encodeURIComponent(batch.id)}/start`, {
            method: 'POST', signal: controller.signal,
            headers: { 'X-Platform-CSRF': csrfToken, 'Idempotency-Key': startKey },
            body: JSON.stringify({ approvalHash: batch.preview.hash, autoApprove: true }),
          });
        });
      }
      if (controller.signal.aborted) return;
      setBatches((current) => [next, ...current.filter((batch) => batch.id !== next.id)]);
      history.show(next.id);
      setApproval('');
      setNeedsRefresh(false);
      setNotice(publicationOutcome(next));
      if (next.state === 'preview') onPreviewReady();
      else onShowResults();
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
      !publicationApprovalReady(batch, autoApprove, approval) ||
      batch.preview.target.linkId !== targetLinkId ||
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
      { approvalHash: batch.preview.hash, ...(batch.preview.autoApprove ? { autoApprove: true } : { approved: true }) },
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
    <section className="platform-card" hidden={step !== 'setup' && step !== 'review' && step !== 'results'}>
      <h2>{step === 'setup' ? '选择章节与目标' : step === 'review' ? '完整预览与批准' : '远端队列与结果'}</h2>
      <p className="platform-help">选择作品、分卷和章节后生成预览；核对无误再启动。草稿不会发布，送审也不代表已发布。</p>
      {!reviewAvailable && (
        <p className="platform-notice">提交审核尚未通过官方精确确认流程核验，目前仅允许保存草稿。</p>
      )}
      {error && (
        <p className="platform-notice" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="platform-notice" role="status">
          {notice}
        </p>
      )}
      {step === 'setup' && <div className="platform-form">
        <label className="checkbox-label">
          <input type="checkbox" checked={autoApprove} disabled={locked} onChange={(event) => {
            const enabled = event.target.checked;
            onAutoApproveChange(enabled);
            setApproval('');
          }} />
          自动审批：后续操作跳过本地人工批准，准备后直接上传 / 送审
        </label>
        {autoApprove ? <p className="platform-notice">
          已启用自动授权；仍会核验账号、目标卷、完整正文及重复操作。平台审核不受此开关影响。
          <button type="button" className="button secondary" disabled={busy} onClick={() => { onAutoApproveChange(false); setApproval(''); }}>
            切换为手动预览与批准（不会上传）
          </button>
        </p> : <p className="platform-help">手动批准模式：先准备完整预览，再到批次底部勾选核对并批准启动。</p>}
        {hasUnknown && <p className="platform-notice" role="status">
          历史批次存在未知结果，新建或恢复上传暂不可用。这不是批准失败；请先使用该批次的“只读核对远端结果（不重发）”。切换审批模式不会解除未知保护。
        </p>}
        <p className="platform-notice">本次目标：{selectedLink ? `${selectedLink.title} · 账号 ${selectedLink.accountId} · 作品 ${selectedLink.remoteWorkId}` : '请先到“绑定作品”步骤明确选择目标'}</p>
        <label>
          目标分卷
          <select value={volumeId} disabled={locked || volumeLoading || !selectedLink} onChange={(event) => setVolumeId(event.target.value)}>
            <option value="">{volumeLoading ? '正在读取番茄分卷…' : '自动定位已有章节；新建章节请选卷'}</option>
            {volumes.map((volume) => <option key={volume.id} value={volume.id}>{volume.name} · {volume.id}</option>)}
          </select>
        </label>
        {volumeError && <p className="platform-notice" role="alert">分卷读取失败：{volumeError}</p>}
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
          <legend>选择正文（{chapterIds.length}/50）</legend>
          <div className="publication-selection-actions">
            <span>按章节顺序上传，单批最多 50 章</span>
            <div>
              <button type="button" className="button secondary" disabled={!savedChapters.length || chapterIds.length === Math.min(savedChapters.length, 50)} onClick={() => setChapterIds(savedChapters.slice(0, 50).map(chapter => chapter.id))}>选择前 50 章</button>
              <button type="button" className="button secondary" disabled={!chapterIds.length} onClick={() => setChapterIds([])}>清空选择</button>
            </div>
          </div>
          {!savedChapters.length && <p className="platform-empty">暂无已保存章节。</p>}
          {savedChapters.map((chapter) => (
            <label className="publication-chapter-option" key={chapter.id}>
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
        <details className="platform-advanced">
          <summary>高级设置：工作流自动上传</summary>
          {workflow?.id && <div className="platform-notice">
            <strong>自动化工作流远端接续</strong>
            <p>完整工作流成功生成并保存章节后，按此处配置自动上传或送审；失败或未通过校验的章节不会上传。</p>
            {workflow.publication?.enabled && <p>已配置：绑定 {workflow.publication.linkId} · {actionLabel(workflow.publication.action)} · 分卷 {workflow.publication.volumeId || '按既有章节定位'}</p>}
            <button type="button" className="button secondary" disabled={locked || workflowBusy || !selectedLink || !volumeId || (action === 'submit_review' && !useAi)} onClick={() => void saveWorkflowPublication(true)}>保存当前选择并启用全自动接续</button>
            {workflow.publication?.enabled && <button type="button" className="button secondary" disabled={locked || workflowBusy} onClick={() => void saveWorkflowPublication(false)}>关闭工作流远端接续</button>}
          </div>}
          {workflow && !workflow.id && <p className="platform-help">先选择一个工作流，才能配置自动上传。</p>}
          <p className="platform-help">平台审核、验证码与风控不会被此设置绕过。</p>
        </details>
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
          {autoApprove ? '自动批准并启动上传 / 送审' : '生成上传预览'}
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
      </div>}
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
      {step === 'results' && <div className="platform-list">
        {!loading && !batches.length && <p className="platform-empty">暂无批次。</p>}
        {history.hiddenIds.length > 0 && <p className="platform-notice">已隐藏 {batches.filter(batch => history.hiddenIds.includes(batch.id)).length} 个批次；未知结果仍会阻止重发。<button className="button secondary" onClick={history.restore}>恢复显示全部批次</button></p>}
        {batches.filter(batch => !history.hiddenIds.includes(batch.id)).map((batch) => (
          <article className="platform-row" key={batch.id}>
            <div className="platform-row-content">
              <strong>
                {batch.preview.target.workTitle} · {actionLabel(batch.preview.action)}
              </strong>
              <p className="platform-help">
                批次 {batch.id} · {batchLabels[batch.state]} · {batch.items.length} 章
              </p>
              <p className="platform-notice" role="status">{publicationOutcome(batch)}</p>
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
                  onPreviewReady();
                }}
              >
                查看全部快照与批准
              </button>
              {!active(batch) && <button className="button secondary" onClick={async () => {
                if (await confirmDialog('仅隐藏本地批次和暂存预览，不删除本地正文或远端章节；审计、已批准记录及未知防重复限制保留。可以恢复显示。是否继续？')) {
                  history.hide(batch.id);
                  if (selectedId === batch.id) { setSelectedId(''); setApproval(''); }
                }
              }}>移出本地暂存列表</button>}
              {uncertain(batch) && (
                <div className="platform-form">
                  {batch.items.filter(item => item.state === 'unknown' && !item.remoteDraftId && !batch.preview.remotePlan?.some(plan => plan.chapterId === item.snapshot.chapterId && plan.mode !== 'create')).map(item => (
                    <label key={item.id}>
                      第 {item.snapshot.number} 章缺少远端 ID：从官方后台该章编辑链接复制章节 ID（不是作品 ID）
                      <input value={reconcileIds[item.id] || ''} placeholder="准确的远端章节 ID；不会据此重新上传" disabled={locked} onChange={event => setReconcileIds(previous => ({ ...previous, [item.id]: event.target.value.trim() }))} />
                    </label>
                  ))}
                  <p className="platform-help">仅核对这批历史快照，不能用当前改稿替代。账号、作品、分卷、标题及完整正文必须一致；不存在或不同仍保持未知，不会重发。若旧稿已被人工删除，此入口不能证明原操作结果。</p>
                  <button className="button secondary" disabled={locked || needsRefresh} onClick={() => void post(`/${encodeURIComponent(batch.id)}/reconcile`, { candidates: Object.fromEntries(batch.items.filter(item => item.state === 'unknown' && reconcileIds[item.id]).map(item => [item.id, reconcileIds[item.id]])) }, crypto.randomUUID())}>
                    只读核对远端结果（不重发）
                  </button>
                </div>
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
      </div>}
      {step === 'review' && !selected && <p className="platform-empty">请先在“选择章节”步骤准备批次；完整预览生成后，才能逐章核对并批准。</p>}
      {step === 'results' && selected && <button className="button secondary" type="button" onClick={onPreviewReady}>查看所选批次完整快照</button>}
      {step === 'review' && selected && (
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
          {selected.approval?.mode === 'automatic' && <p className="platform-notice">本批次属于自动审批记录；切换为手动模式不会将它变为人工核对的预览。</p>}
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
          {targetChanged && <p className="platform-notice" role="alert">预览目标与本次所选作品不同。此处仅供核对历史快照；如需继续，请回到作品步骤重新确认目标。</p>}
          {(selected.state === 'preview' || selected.state === 'paused') && !uncertain(selected) && (
            <>
              {reviewBlocked && (
                <p className="platform-notice">官方提交确认未核验或缺少明确 AI 声明，禁止启动或恢复送审。</p>
              )}
              {!selected.preview.autoApprove && <label>
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
                  targetChanged ||
                  reviewBlocked ||
                  !publicationApprovalReady(selected, autoApprove, approval) ||
                  selected.preview.chapters.length === 0 ||
                  selected.preview.chapters.length > 50
                }
                onClick={() => execute(selected, selected.state === 'paused' ? 'resume' : 'start')}
              >
                {selected.preview.autoApprove ? (selected.state === 'paused' ? '自动批准并恢复剩余队列' : '自动批准并启动此批次') : (selected.state === 'paused' ? '人工批准恢复剩余队列' : '人工批准并启动此批次')}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
