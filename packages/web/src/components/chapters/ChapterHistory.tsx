import { useState } from 'react';
import type { Chapter } from '../../../../../shared/types';
import { normalizeChapterHistory, CHAPTER_HISTORY_LIMIT } from '../../../../../shared/chapter-history';
import Modal from '../common/Modal';
import { useConfirm } from '../common/AppDialog';

export default function ChapterHistory({ chapter, editor, disabled, restore }: {
  chapter: Chapter;
  editor: { title: string; content: string };
  disabled: boolean;
  restore: (revision: number, expectedRevision: number) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const confirm = useConfirm();
  const history = normalizeChapterHistory(chapter.revisions);
  const version = history.find((item) => item.revision === selected) || history[0];
  return <>
    <button type="button" className="button secondary" onClick={() => { setError(''); setOpen(true); }}>章节历史（{history.length}）</button>
    {open && <Modal title="章节历史比较" description={`保留最近 ${CHAPTER_HISTORY_LIMIT} 个历史版本。恢复会创建新版本，并保留当前正式稿。`} close={() => setOpen(false)} wide busy={pending} error={error}>
      {!version ? <p>尚无历史版本。保存或替换正文后可在此浏览。</p> : <>
        <label>历史版本 <select aria-label="历史版本" disabled={pending} value={version.revision} onChange={(event) => setSelected(Number(event.target.value))}>
          {history.map((item) => <option key={item.revision} value={item.revision}>v{item.revision} · {item.updatedAt} · {item.title}</option>)}
        </select></label>
        <p>当前正式版本 v{chapter.revision}；下方左侧包含编辑器中尚未保存的修改。</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 16 }}>
          <section><h3>当前编辑器：{editor.title}</h3><pre tabIndex={0} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '50vh', overflow: 'auto' }}>{editor.content}</pre></section>
          <section><h3>历史 v{version.revision}：{version.title}</h3><pre tabIndex={0} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '50vh', overflow: 'auto' }}>{version.content}</pre></section>
        </div>
        <p>标题{editor.title === version.title ? '相同' : '不同'} · 正文{editor.content === version.content ? '相同' : '不同'} · 字符变化 {version.content.length - editor.content.length}</p>
        <button type="button" className="button primary" disabled={disabled || pending} onClick={async () => {
          if (pending || disabled) return;
          setPending(true); setError('');
          try {
            if (!(await confirm(`恢复历史 v${version.revision} 为新版本？当前正式稿将保留在历史中。请先保存或导出未提交的修改。`))) return;
            if (await restore(version.revision, chapter.revision)) setOpen(false);
            else setError('恢复未完成，请检查当前草稿或刷新章节后重试。');
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : '恢复失败，请重试。');
          } finally { setPending(false); }
        }}>{pending ? '正在恢复…' : '恢复此版本'}</button>
        {disabled && <p>请先保存或处理当前草稿，并等待正在运行的任务完成后恢复。</p>}
      </>}
    </Modal>}
  </>;
}
