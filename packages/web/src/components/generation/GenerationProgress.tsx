import type { Chapter, Run, RunChapterProgress } from '../../../../../shared/types';
import { useLocale } from '../../locals/useLocale';
import { createTranslator, type Locale } from '../../locals/core';

export interface GenerationProgressProps {
  run?: Run;
  savedChapters?: number;
  /** Complete current manuscript identities, not a filtered page. Omit while unknown/loading. */
  savedChapterEvidence?: readonly Pick<Chapter, 'id'>[];
  onRetry?: (number: number, mode: 'create' | 'regenerate') => void;
}

/** A chapter number can be reused after deletion; only the saved identity proves presence. */
export function completedChapterPresence(
  chapter: Pick<RunChapterProgress, 'status' | 'chapterId'>,
  savedChapterEvidence?: GenerationProgressProps['savedChapterEvidence'],
): 'present' | 'absent' | 'unknown' | 'not-completed' {
  if (chapter.status !== 'done') return 'not-completed';
  if (!chapter.chapterId || savedChapterEvidence === undefined) return 'unknown';
  return savedChapterEvidence.some((saved) => saved.id === chapter.chapterId) ? 'present' : 'absent';
}

/** Presentation-only view; the locale hook remains in the public component. */
export function GenerationProgressView({
  run,
  savedChapters = 0,
  savedChapterEvidence,
  onRetry,
  locale,
}: GenerationProgressProps & { locale: Locale }) {
  const t = createTranslator(locale);
  const en = locale === 'en';
  const chapterName = (number: number) => (t("第 {value0} 章", { value0: number }));
  const generationLabels = { pending: t('等待'), running: t('生成中'), done: t('本次运行已完成'), candidate: t('候选待确认'), error: t('失败'), cancelled: t('已取消') };
  const validationLabels = { pending: t('待校验'), passed: t('通过'), failed: t('未通过') };
  const reviewLabels = { pending: t('待审校'), done: t('已有建议'), 'not-configured': t('未配置') };
  const count = savedChapterEvidence?.length ?? savedChapters;
  if (!run?.chapters?.length)
    return (
      <p className="muted">
        {t("还没有逐章运行记录。正式章节目录只统计已保存内容（当前 {value0} 章）。", { value0: count })}
      </p>
    );
  const visibleChapters = run.chapters.filter(
    (chapter) => completedChapterPresence(chapter, savedChapterEvidence) !== 'absent',
  );
  const absentChapters = run.chapters.filter(
    (chapter) => completedChapterPresence(chapter, savedChapterEvidence) === 'absent',
  );
  const renderChapter = (chapter: RunChapterProgress) => {
    const presence = completedChapterPresence(chapter, savedChapterEvidence);
    const failed =
      chapter.status !== 'done' &&
      (chapter.status === 'error' || chapter.validationStatus === 'failed');
    const label =
      presence === 'present'
        ? t("正文已保存 · 在当前书稿中")
        : presence === 'absent'
          ? t("已从书稿删除 / 不在当前书稿")
          : presence === 'unknown'
            ? t("本次运行已完成 · 当前书稿状态未核实")
            : generationLabels[chapter.status];
    return (
      <li key={chapter.number}>
        <strong>
          {chapterName(chapter.number)} · {label}
        </strong>
        <span>
          {t("原文校验：")}
          {validationLabels[chapter.validationStatus]}
          {t(" · 审校：")}
          {reviewLabels[chapter.reviewStatus]}
        </span>
        {failed && (
          <span className="generation-warning">
            {t("目标{value0}失败，未新增已保存章节。", { value0: chapterName(chapter.number) })}
          </span>
        )}
        {chapter.error && <span className="generation-warning">{chapter.error}</span>}
        {chapter.issues.length > 0 && (
          <span className="generation-warning">{chapter.issues.join(en ? '; ' : '；')}</span>
        )}
        {failed && onRetry && (
          <button
            type="button"
            className="text-button"
            disabled={run.status === 'running'}
            onClick={() =>
              onRetry(chapter.number, run.generationMode || run.request?.mode || 'create')
            }
          >
            {t("重试{value0}", { value0: chapterName(chapter.number) })}
          </button>
        )}
      </li>
    );
  };
  return (
    <div className="generation-progress">
      <p>
        {run.status === 'running'
          ? t("当前目标：{value0}", { value0: chapterName(run.currentChapter ?? run.targets?.[0] ?? 0) })
          : t("最近一次运行历史")}
        {run.mode === 'demo' ? (t(" · 演示模板")) : ''}
      </p>
      <p className="muted">
        {t("正式章节目录：{value0} 章。下方是本次运行历史，不代表当前书稿；删除章节不会删除运行记录。", { value0: count })}
      </p>
      <details open>
        <summary>
          {t("运行记录（可折叠 / 展开，仅影响显示）")}
        </summary>
        {visibleChapters.length > 0 && <ul>{visibleChapters.map(renderChapter)}</ul>}
        {absentChapters.length > 0 && (
          <details>
            <summary>
              {t("已从书稿删除 / 不在当前书稿的历史（{value0} 章，默认收起）", { value0: absentChapters.length })}
            </summary>
            <ul>{absentChapters.map(renderChapter)}</ul>
          </details>
        )}
      </details>
      <p className="muted">
        {t("审校是建议，不是自动批准；文学语义与风格仍待作者确认。")}
      </p>
    </div>
  );
}

export default function GenerationProgress(props: GenerationProgressProps) {
  const { locale } = useLocale();
  return <GenerationProgressView {...props} locale={locale} />;
}
