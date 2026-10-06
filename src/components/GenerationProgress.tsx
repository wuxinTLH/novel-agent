import type { Run } from '../../shared/types';

const generationLabels = {
  pending: '等待',
  running: '生成中',
  done: '正文已保存',
  candidate: '候选待确认',
  error: '失败',
  cancelled: '已取消',
};
const validationLabels = { pending: '待校验', passed: '通过', failed: '未通过' };
const reviewLabels = { pending: '待审校', done: '已有建议', 'not-configured': '未配置' };
export default function GenerationProgress({
  run,
  savedChapters = 0,
  onRetry,
}: {
  run?: Run;
  savedChapters?: number;
  onRetry?: (number: number, mode: 'create' | 'regenerate') => void;
}) {
  if (!run?.chapters?.length)
    return (
      <p className="muted">还没有逐章运行记录。正式章节目录只统计已保存内容（当前 {savedChapters} 章）。</p>
    );
  return (
    <div className="generation-progress">
      <p>
        {run.status === 'running'
          ? `当前目标：第 ${run.currentChapter ?? run.targets?.[0]} 章`
          : '最近一次运行结果'}
        {run.mode === 'demo' ? ' · 演示模板' : ''}
      </p>
      <p className="muted">正式章节目录：{savedChapters} 章。下方是本次运行记录，不计入已保存章节。</p>
      <ul>
        {run.chapters.map((chapter) => {
          const failed = chapter.status === 'error' || chapter.validationStatus === 'failed';
          return (
            <li key={chapter.number}>
              <strong>
                第 {chapter.number} 章 · {generationLabels[chapter.status]}
              </strong>
              <span>
                原文校验：{validationLabels[chapter.validationStatus]} · 审校：
                {reviewLabels[chapter.reviewStatus]}
              </span>
              {failed && (
                <span className="generation-warning">目标第 {chapter.number} 章失败，未新增已保存章节。</span>
              )}
              {chapter.error && <span className="generation-warning">{chapter.error}</span>}
              {chapter.issues.length > 0 && (
                <span className="generation-warning">{chapter.issues.join('；')}</span>
              )}
              {failed && onRetry && (
                <button
                  type="button"
                  className="text-button"
                  disabled={run.status === 'running'}
                  onClick={() => onRetry(chapter.number, run.generationMode || run.request?.mode || 'create')}
                >
                  重试第 {chapter.number} 章
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="muted">审校是建议，不是自动批准；文学语义与风格仍待作者确认。</p>
    </div>
  );
}
