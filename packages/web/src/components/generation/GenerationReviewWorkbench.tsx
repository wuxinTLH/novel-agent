import type { ReactNode } from 'react';
import { useLocale } from '../../locals/useLocale';
import './generation-review.scss';

/** Local disclosure only: collapsing review never unmounts polling or author decisions. */
export default function GenerationReviewWorkbench({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  return (
    <details className="generation-review-workbench" open>
      <summary className="generation-review-heading">
        <span>{t('生成与书稿审阅工作台')}</span>
        <small>{t('收起后专注章节编辑 · 展开查看生成结果与候选稿')}</small>
      </summary>
      <div className="generation-review-content">{children}</div>
    </details>
  );
}
