import { useConfirm } from './AppDialog';
import { useState } from 'react';
import { Check, Download, Trash2 } from 'lucide-react';
import type { ChapterCandidate, Project } from '../../shared/types';
import { candidateBlockReason } from '../hooks/generationState';
import { download } from '../api';

type RecoveryCandidate = ChapterCandidate & {
  recoveryStatus?: 'pending-review' | 'review-failed' | 'ready';
  graphRevision?: number;
  errorCode?: string;
  error?: string;
};
export default function GenerationCandidates({
  project,
  busy,
  dirty,
  onAccept,
  onDiscard,
}: {
  project: Project;
  busy: boolean;
  dirty: boolean;
  onAccept: (candidate: ChapterCandidate) => void;
  onDiscard: (candidate: ChapterCandidate) => void;
}) {
  const confirmDialog = useConfirm();
  const [expanded, setExpanded] = useState('');
  const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({});
  const candidates = [...(project.candidates || [])].sort(
    (a, b) => a.number - b.number || b.createdAt.localeCompare(a.createdAt),
  );
  if (!candidates.length) return null;
  return (
    <section className="generation-candidates">
      <h3>
        可恢复内容与候选稿 <small>{candidates.length} 份 · 不计入已保存章节 · 原稿不会自动替换</small>
      </h3>
      {candidates.map((raw) => {
        const candidate = raw as RecoveryCandidate;
        const original = project.chapters.find((chapter) => chapter.id === candidate.chapterId);
        const graph = project.workflows?.find((graph) => graph.id === candidate.workflowId);
        const revision =
          graph?.workflow.graphRevision ??
          (candidate.workflowId === project.activeWorkflowId ? project.workflow?.graphRevision : undefined);
        const pendingReview = candidate.recoveryStatus === 'pending-review';
        const reviewFailed = candidate.recoveryStatus === 'review-failed';
        const reason = pendingReview
          ? '正文已留存，审校尚未完成，暂不能采用。'
          : candidate.graphRevision !== undefined && revision !== candidate.graphRevision
            ? '工作流版本已变化，不能采用旧运行的恢复稿；可先导出。'
            : candidateBlockReason(candidate, project.chapters);
        return (
          <article className="generation-candidate" key={candidate.id}>
            <div className="candidate-heading">
              <div>
                <strong>
                  第 {candidate.number} 章 · {candidate.title}
                </strong>
                <p>
                  {candidate.mode === 'demo' ? '演示模板' : '模型候选稿'} ·{' '}
                  {candidate.issues.length ? '硬性校验未通过' : '硬性校验通过'} · 语义待作者确认
                  {candidate.baseRevision ? ` · 基于原稿 v${candidate.baseRevision}` : ''}
                </p>
              </div>
              <button
                className="button secondary"
                onClick={() => setExpanded(expanded === candidate.id ? '' : candidate.id)}
              >
                {expanded === candidate.id ? '收起' : original ? '对比原稿' : '审校与采用'}
              </button>
            </div>
            {candidate.recoveryStatus && (
              <p className={reviewFailed || pendingReview ? 'generation-warning' : 'info-note'}>
                {pendingReview
                  ? '已保留写作结果，等待审校；这不是已保存的正式章节。'
                  : reviewFailed
                    ? '审校失败，但正文已保留。可导出备份；采用前请自行检查并明确确认。'
                    : '正文与校验结果已就绪，仍需作者确认。'}
                {candidate.error ? ` ${candidate.error}` : ''}
                {candidate.errorCode ? `（${candidate.errorCode}）` : ''}
              </p>
            )}
            {candidate.issues.length > 0 && (
              <ul className="generation-warning">
                {candidate.issues.map((issue, index) => (
                  <li key={index}>{issue}</li>
                ))}
              </ul>
            )}
            <div className="candidate-saved">
              <h4>已保存正文{pendingReview ? ' · 尚未审校' : ''}</h4>
              <strong>{candidate.title}</strong>
              <pre>{candidate.content}</pre>
            </div>
            <div className="candidate-actions candidate-actions-visible">
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  download(
                    `${project.title}-第${candidate.number}章-恢复稿.md`,
                    `${candidate.title}\n\n${candidate.content}`,
                  )
                }
              >
                <Download size={14} />
                导出此稿
              </button>
              <button
                className="button secondary"
                disabled={busy}
                onClick={async () => {
                  if (await confirmDialog('放弃此候选 / 恢复稿？已保存原稿不会改变。')) onDiscard(candidate);
                }}
              >
                <Trash2 size={14} />
                放弃此稿
              </button>
            </div>
            {expanded === candidate.id && (
              <>
                <div className="candidate-compare">
                  <section>
                    <h4>{original ? `当前原稿 v${original.revision}` : '暂无正式原稿'}</h4>
                    <strong>{original?.title}</strong>
                    <pre>{original?.content || '采用合格候选后才会形成正式本地章节。'}</pre>
                  </section>
                  <section>
                    <h4>候选 / 恢复新稿</h4>
                    <strong>{candidate.title}</strong>
                    <pre>{candidate.content}</pre>
                  </section>
                </div>
                {candidate.reviewOutput && (
                  <details>
                    <summary>审校建议（不等于批准）</summary>
                    <pre>{candidate.reviewOutput}</pre>
                  </details>
                )}
                {reason && <p className="generation-warning">{reason}</p>}
                {reviewFailed && (
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={!!acknowledged[candidate.id]}
                      onChange={(event) =>
                        setAcknowledged((current) => ({ ...current, [candidate.id]: event.target.checked }))
                      }
                    />
                    我已知晓审校失败，将自行审阅并承担采用此稿的确认责任。
                  </label>
                )}
                <div className="candidate-actions">
                  <button
                    className="button primary"
                    disabled={busy || dirty || !!reason || (reviewFailed && !acknowledged[candidate.id])}
                    title={reason || (dirty ? '请先保存或处理当前编辑稿' : '已阅读后显式采用')}
                    onClick={async () => {
                      if (
                        await confirmDialog(
                          `确认采用第 ${candidate.number} 章候选稿？${reviewFailed ? '审校尚未成功，' : ''}语义和文学质量由你确认，原稿修订历史将保留。`,
                        )
                      )
                        onAccept(candidate);
                    }}
                  >
                    <Check size={14} />
                    采用新稿
                  </button>
                </div>
              </>
            )}
          </article>
        );
      })}
    </section>
  );
}
