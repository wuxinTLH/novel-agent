import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Trash2 } from 'lucide-react';
import type { Chapter } from '../../../../../shared/types';
import {
  CHAPTER_PAGE_SIZES,
  chapterPage,
  chapterSelectedPage,
  chapterSelectionStale,
  toggleChapterSelection,
  type ChapterSelection,
} from '../../hooks/chapters/chapterCatalog';
import './chapter-catalog.scss';

export default function ChapterCatalog({
  chapters,
  selectedId,
  disabled,
  onSelect,
  onDelete,
  onDeleteSelected,
}: {
  chapters: Chapter[];
  selectedId: string;
  disabled: boolean;
  onSelect: (chapter: Chapter) => void;
  onDelete: (chapter: Chapter) => void;
  onDeleteSelected: (selection: ChapterSelection) => Promise<boolean>;
}) {
  const [size, setSize] = useState(20);
  const [requestedPage, setPage] = useState(() => chapterSelectedPage(chapters, selectedId, size));
  const [batch, setBatch] = useState(false);
  const [selection, setSelection] = useState<ChapterSelection>([]);
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  const requestPending = useRef(false);
  const rows = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setPage(chapterSelectedPage(chapters, selectedId, size));
  }, [selectedId, size]);
  const { page, pages, start, end } = chapterPage(chapters.length, requestedPage, size);
  useEffect(() => {
    rows.current?.scrollTo({ top: 0 });
  }, [page, size]);
  const visible = chapters.slice(start, end);
  const ids = new Set(selection.map((chapter) => chapter.id));
  const pageSelected = visible.filter((chapter) => ids.has(chapter.id)).length;
  const stale = chapterSelectionStale(selection, chapters);
  const locked = disabled || pending;
  const exit = () => {
    setBatch(false);
    setSelection([]);
  };
  const remove = async () => {
    if (locked || requestPending.current || !selection.length || stale) return;
    requestPending.current = true;
    setPending(true);
    try {
      if ((await onDeleteSelected(selection.map((item) => ({ ...item })))) && mounted.current) exit();
    } finally {
      requestPending.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return (
    <section className="chapter-catalog" aria-label="章节目录管理">
      <div className="chapter-catalog-actions">
        {!batch ? (
          <button
            type="button"
            className="text-button"
            disabled={locked || !chapters.length}
            onClick={() => {
              setSelection([]);
              setBatch(true);
            }}
          >
            批量删除
          </button>
        ) : (
          <>
            <strong>批量删除模式</strong>
            <button type="button" className="text-button" disabled={pending} onClick={exit}>
              退出批量删除
            </button>
          </>
        )}
      </div>
      {batch && (
        <div className="chapter-batch-controls">
          <label>
            <input
              type="checkbox"
              aria-label="选择本页全部章节"
              checked={visible.length > 0 && pageSelected === visible.length}
              ref={(input) => {
                if (input) input.indeterminate = pageSelected > 0 && pageSelected < visible.length;
              }}
              disabled={locked || !visible.length}
              onChange={(event) =>
                setSelection((current) => toggleChapterSelection(current, visible, event.target.checked))
              }
            />
            本页全选
          </label>
          <span role="status">
            已选 {selection.length} 章（本页 {pageSelected} · 其他页 {selection.length - pageSelected}）
          </span>
          <button
            type="button"
            className="text-button"
            disabled={locked || !selection.length}
            onClick={() => setSelection([])}
          >
            清空选择
          </button>
          <button
            type="button"
            className="button danger"
            disabled={locked || !selection.length || selection.length > 500 || stale}
            onClick={() => void remove()}
          >
            <Trash2 size={14} />
            删除所选（{selection.length}）
          </button>
          {stale && <p role="alert">所选章节已变更或删除，请清空选择后重新选择。</p>}
          {selection.length > 500 && <p role="alert">一次最多删除 500 章，请减少选择。</p>}
        </div>
      )}
      <div className="chapter-catalog-pagination" aria-label="章节目录分页">
        <label>
          每页{' '}
          <select
            aria-label="每页章节数"
            value={size}
            disabled={pending}
            onChange={(event) => setSize(Number(event.target.value))}
          >
            {CHAPTER_PAGE_SIZES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <span>
          {chapters.length ? start + 1 : 0}–{end} / {chapters.length} 章
        </span>
        <div>
          <button
            type="button"
            aria-label="目录上一页"
            disabled={page === 0 || pending}
            onClick={() => setPage(page - 1)}
          >
            上一页
          </button>
          <span aria-live="polite">
            {page + 1} / {pages}
          </span>
          <button
            type="button"
            aria-label="目录下一页"
            disabled={page + 1 >= pages || pending}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </button>
        </div>
      </div>
      <div className="chapter-catalog-rows" ref={rows}>
        {visible.map((chapter) => (
          <div
            key={chapter.id}
            className={`chapter-row ${selectedId === chapter.id ? 'active' : ''} ${ids.has(chapter.id) ? 'checked' : ''}`}
          >
            {batch && (
              <input
                type="checkbox"
                aria-label={`选择第 ${chapter.number} 章 ${chapter.title}`}
                checked={ids.has(chapter.id)}
                disabled={locked}
                onChange={(event) =>
                  setSelection((current) => toggleChapterSelection(current, [chapter], event.target.checked))
                }
              />
            )}
            <button
              type="button"
              className="chapter-row-open"
              aria-current={selectedId === chapter.id ? 'true' : undefined}
              disabled={locked}
              onClick={() => onSelect(chapter)}
            >
              <span>{String(chapter.number).padStart(2, '0')}</span>
              <div>
                <strong>{chapter.title}</strong>
                <small>
                  {chapter.content.length.toLocaleString()} 字符 ·{' '}
                  {!!chapter.manualRequestId ? '手动书稿' : chapter.mode === 'demo' ? '演示草稿' : 'AI 初稿'}{' '}
                  · v{chapter.revision}
                </small>
              </div>
              <ChevronRight size={14} />
            </button>
            {!batch && (
              <button
                type="button"
                className="icon-button delete"
                aria-label={`删除 ${chapter.title}`}
                disabled={locked}
                onClick={() => onDelete(chapter)}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ))}
        {!chapters.length && <p className="muted chapter-list-empty">还没有章节</p>}
      </div>
    </section>
  );
}
