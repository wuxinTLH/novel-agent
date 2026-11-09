import { useEffect, useRef, useState } from 'react';
import type { PublicationDeletionBlockers } from '../../../../../shared/publication';
import { api } from '../../services/api';
import { useLocale } from '../../locals/useLocale';
import { useConfirm } from '../common/AppDialog';
import Modal from '../common/Modal';

export function deletionCancellationBody(batch: PublicationDeletionBlockers['batches'][number]) {
  return batch.canCancel && batch.state !== 'unknown' && batch.state !== 'cancelled' &&
    batch.items.every(item => !item.mutationStarted && !item.hasRemoteDraftId && !['unknown', 'draft_verified', 'submitted'].includes(item.state)) &&
    /^[a-f0-9]{64}$/i.test(batch.approvalHash)
    ? { confirmed: true as const, approvalHash: batch.approvalHash }
    : undefined;
}

export function deletionPreservingRecordsBody(diagnostic: PublicationDeletionBlockers | undefined, optedIn = false) {
  return optedIn && diagnostic?.canDeletePreservingRecords === true && !diagnostic.busy
    ? { confirmed: true as const, preservePlatformRecords: true as const }
    : undefined;
}

export interface ProjectDeletionBlockersProps {
  projectId: string;
  projectTitle: string;
  initial?: PublicationDeletionBlockers;
  deletionError?: unknown;
  close: () => void;
  onOpenResults: () => void;
  onRetryDelete: () => void;
  onDeletePreservingRecords: () => Promise<void>;
}

export default function ProjectDeletionBlockers({ projectId, projectTitle, initial, deletionError, close, onOpenResults, onRetryDelete, onDeletePreservingRecords }: ProjectDeletionBlockersProps) {
  const { t } = useLocale();
  const confirm = useConfirm();
  const [diagnostic, setDiagnostic] = useState(initial);
  useEffect(() => { setDiagnostic(initial); }, [initial]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const controller = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const refresh = async (signal: AbortSignal) => {
    const next = await api<PublicationDeletionBlockers>(`${base}/platform-deletion-blockers`, { signal });
    if (!signal.aborted) setDiagnostic(next);
  };
  useEffect(() => {
    const lifetime = new AbortController();
    controller.current = lifetime;
    if (!initial) {
      pending.current = true;
      setBusy(true);
      void refresh(lifetime.signal).catch(failure => { if (!lifetime.signal.aborted) setError(failure); })
        .finally(() => { if (!lifetime.signal.aborted) { pending.current = false; setBusy(false); } });
    }
    return () => lifetime.abort();
  }, [projectId]);
  const perform = async (batch?: PublicationDeletionBlockers['batches'][number]) => {
    const lifetime = controller.current;
    if (!lifetime || lifetime.signal.aborted || pending.current) return;
    const body = batch ? deletionCancellationBody(batch) : undefined;
    if (batch && !body) return;
    if (batch && !(await confirm(t('确定安全取消批次 {id}？仅终止尚未开始远端写入的本地队列，不删除远端内容，也不会继续删除作品。', { id: batch.id })))) return;
    if (lifetime.signal.aborted || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    // Discard stale permissions before a mutation or a failed refresh.
    setDiagnostic(undefined);
    try {
      if (batch) await api(`${base}/platform-publication-batches/${encodeURIComponent(batch.id)}/cancel`, {
        method: 'POST', signal: lifetime.signal, body: JSON.stringify(body),
      });
      await refresh(lifetime.signal);
    } catch (failure) {
      if (!lifetime.signal.aborted) setError(failure);
    } finally {
      if (!lifetime.signal.aborted) { pending.current = false; setBusy(false); }
    }
  };
  const deletePreservingRecords = async () => {
    const lifetime = controller.current;
    if (!lifetime || lifetime.signal.aborted || pending.current || !deletionPreservingRecordsBody(diagnostic, true)) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await onDeletePreservingRecords();
    } catch (failure) {
      if (!lifetime.signal.aborted) setError(failure);
    } finally {
      if (!lifetime.signal.aborted) { pending.current = false; setBusy(false); }
    }
  };
  return <Modal wide title={t('作品删除被平台记录阻止')} description={t('正在检查作品「{title}」的本地平台记录。诊断不会访问远端、重发章节或清除未知结果。', { title: projectTitle })} close={close} busy={busy} error={error ?? deletionError} className="project-deletion-blockers">
    <p>{t('继续平台操作前，未知结果仍需使用准确的远端章节 ID 只读核对；缺少 ID 时请从官方后台该章编辑链接取得，不能用作品 ID 代替。仅删除本地作品可选择保留平台记录，无需补齐远端 ID。')}</p>
    {busy && <p role="status">{t('正在刷新删除诊断…')}</p>}
    {diagnostic?.busy && <p role="status">{t('平台操作仍在进行，请等待其结束后刷新诊断。')}</p>}
    <div className="project-deletion-blockers__list">
      {diagnostic?.batches.map(batch => <article key={batch.id}>
        <h3>{t('批次 {id} · 状态 {state}', { id: batch.id, state: batch.state })}</h3>
        {(batch.failureStage || batch.errorCode) && <p>{t('错误阶段：{stage}；错误码：{code}', { stage: batch.failureStage || '—', code: batch.errorCode || '—' })}</p>}
        <ul>{batch.items.map((item, index) => <li key={`${item.number}:${index}`}>
          {t('第 {number} 章 · 状态 {state} · {remoteId}', { number: item.number, state: item.state, remoteId: item.hasRemoteDraftId ? t('已有准确远端 ID') : t('缺少准确远端 ID') })}
          {' · '}{item.mutationStarted ? t('已进入远端写入流程，结果需核对') : t('未记录远端写入开始')}
        </li>)}</ul>
        {deletionCancellationBody(batch) && <button className="button secondary" type="button" disabled={busy} onClick={() => void perform(batch)}>{t('安全取消未写入批次')}</button>}
      </article>)}
      {diagnostic?.legacyOperations.map(operation => <article key={operation.id}>
        <h3>{t('历史平台操作 {id} · 状态 {state}', { id: operation.id, state: operation.state })}</h3>
        <p>{t('请进入该作品的平台结果页只读核对；此处不会取消或清除历史未知操作。')}</p>
      </article>)}
    </div>
    {diagnostic?.removable && <p role="status">{t('当前未发现删除阻塞。不会自动删除作品；如仍需删除，请再次显式点击并确认。')}</p>}
    <p>{t('如需危险的备份后清空，请从设置中的数据库与存储入口查看原有流程；此弹窗不会调用清空，也不会以清空代替未知结果核对。')}</p>
    <div className="project-deletion-blockers__actions">
      <button className="button secondary" type="button" disabled={busy} onClick={() => void perform()}>{t('刷新删除诊断')}</button>
      <button className="button secondary" type="button" disabled={busy} onClick={onOpenResults}>{t('打开该作品的平台结果')}</button>
      <button className="button danger" type="button" disabled={busy || !diagnostic?.removable || diagnostic.busy} onClick={onRetryDelete}>{t('再次尝试删除作品')}</button>
      {!busy && deletionPreservingRecordsBody(diagnostic, true) && <button className="button danger" type="button" onClick={() => void deletePreservingRecords()}>{t('保留平台记录并删除本地作品')}</button>}
    </div>
  </Modal>;
}
