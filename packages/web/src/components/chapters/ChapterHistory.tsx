import { formatDateTime } from '../../lib/dateTime';
import { useState } from 'react';
import type { Chapter } from '../../../../../shared/types';
import { normalizeChapterHistory, CHAPTER_HISTORY_LIMIT } from '../../../../../shared/chapter-history';
import Modal from '../common/Modal';
import { useConfirm } from '../common/AppDialog';
import { useLocale } from '../../locals/useLocale';

export default function ChapterHistory({ chapter, editor, disabled, restore }: {
  chapter: Chapter;
  editor: { title: string; content: string };
  disabled: boolean;
  restore: (revision: number, expectedRevision: number) => Promise<boolean>;
}) {
  const { t } = useLocale();

  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const confirm = useConfirm();
  const history = normalizeChapterHistory(chapter.revisions);
  const version = history.find((item) => item.revision === selected) || history[0];
  return <>
    <button type="button" className="button secondary" onClick={() => { setError(''); setOpen(true); }}>{t("章节历史（{value0}）", { value0: history.length })}</button>
    {open && <Modal title={t("章节历史比较")} description={t("保留最近 {value0} 个历史版本。恢复会创建新版本，并保留当前正式稿。", { value0: CHAPTER_HISTORY_LIMIT })} close={() => setOpen(false)} wide busy={pending} error={error}>
      {!version ? <p>{t("尚无历史版本。保存或替换正文后可在此浏览。")}</p> : <>
        <label>{t("历史版本")} <select aria-label={t("历史版本")} disabled={pending} value={version.revision} onChange={(event) => setSelected(Number(event.target.value))}>
          {history.map((item) => <option key={item.revision} value={item.revision}>v{item.revision} · {formatDateTime(item.updatedAt)} · {item.title}</option>)}
        </select></label>
        <p>{t("当前正式版本 v{value0}；下方左侧包含编辑器中尚未保存的修改。", { value0: chapter.revision })}</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 16 }}>
          <section><h3>{t("当前编辑器：")}{editor.title}</h3><pre tabIndex={0} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '50vh', overflow: 'auto' }}>{editor.content}</pre></section>
          <section><h3>{t("历史")} v{version.revision}: {version.title}</h3><pre tabIndex={0} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '50vh', overflow: 'auto' }}>{version.content}</pre></section>
        </div>
        <p>{t("标题")} {editor.title === version.title ? t("相同") : t("不同")} · {t("正文")} {editor.content === version.content ? t("相同") : t("不同")} · {t("字符变化")} {version.content.length - editor.content.length}</p>
        <button type="button" className="button primary" disabled={disabled || pending} onClick={async () => {
          if (pending || disabled) return;
          setPending(true); setError('');
          try {
            if (!(await confirm(t("恢复历史 v{value0} 为新版本？当前正式稿将保留在历史中。请先保存或导出未提交的修改。", { value0: version.revision })))) return;
            if (await restore(version.revision, chapter.revision)) setOpen(false);
            else setError(t("恢复未完成，请检查当前草稿或刷新章节后重试。"));
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : t("恢复失败，请重试。"));
          } finally { setPending(false); }
        }}>{pending ? t("正在恢复…") : t("恢复此版本")}</button>
        {disabled && <p>{t("请先保存或处理当前草稿，并等待正在运行的任务完成后恢复。")}</p>}
      </>}
    </Modal>}
  </>;
}
