import { useId, useMemo, useState } from 'react';
import { ArrowRight, BookOpen, Check, Clock3, LibraryBig, Plus, Search, Settings2, X } from 'lucide-react';
import type { Project } from '../../../../../shared/types';
import './projects-library.scss';

export interface ProjectsLibraryProps {
  projects: readonly Project[];
  currentId?: string | null;
  disabled?: boolean;
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
  onCreate: () => void;
}

type SortOrder = 'updated' | 'title';

const titleCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

function updatedTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function ProjectCover({ project }: { project: Project }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <div className="projects-library__cover" aria-hidden="true">
      {project.coverUrl && failedUrl !== project.coverUrl ? (
        <img
          src={project.coverUrl}
          alt=""
          loading="lazy"
          onError={() => setFailedUrl(project.coverUrl ?? null)}
        />
      ) : (
        <div className="projects-library__cover-placeholder">
          <BookOpen size={32} strokeWidth={1.25} />
          <span>{project.title.trim() || '未命名作品'}</span>
          <small>NOVEL / 创作手稿</small>
        </div>
      )}
    </div>
  );
}

/** Presentational library: project selection and all mutations belong to the parent. */
export default function ProjectsLibrary({
  projects,
  currentId,
  disabled = false,
  onOpen,
  onEdit,
  onCreate,
}: ProjectsLibraryProps) {
  const headingId = useId();
  const [query, setQuery] = useState('');
  const [genre, setGenre] = useState('all');
  const [sort, setSort] = useState<SortOrder>('updated');
  const genres = useMemo(
    () =>
      [...new Set(projects.map((project) => project.genre.trim()).filter(Boolean))].sort(
        titleCollator.compare,
      ),
    [projects],
  );
  const hasUncategorized = projects.some((project) => !project.genre.trim());
  // If the parent's data changes, an obsolete filter must not hide every project.
  const activeGenre =
    genre === 'uncategorized'
      ? hasUncategorized
        ? genre
        : 'all'
      : genre.startsWith('genre:') && !genres.includes(genre.slice(6))
        ? 'all'
        : genre;
  const visibleProjects = useMemo(() => {
    const search = query.trim().toLocaleLowerCase('zh-CN');
    return projects
      .filter((project) => {
        const projectGenre = project.genre.trim();
        const matchesGenre =
          activeGenre === 'all' ||
          (activeGenre === 'uncategorized' ? !projectGenre : projectGenre === activeGenre.slice(6));
        const matchesSearch =
          !search ||
          [project.title, project.genre, project.description].some((value) =>
            value.toLocaleLowerCase('zh-CN').includes(search),
          );
        return matchesGenre && matchesSearch;
      })
      .sort((a, b) => {
        if (sort === 'updated') {
          const aTime = updatedTimestamp(a.updatedAt);
          const bTime = updatedTimestamp(b.updatedAt);
          if (aTime !== bTime) return aTime > bTime ? -1 : 1;
        }
        return titleCollator.compare(a.title, b.title) || titleCollator.compare(a.id, b.id);
      });
  }, [projects, query, activeGenre, sort]);
  const resetFilters = () => {
    setQuery('');
    setGenre('all');
  };

  return (
    <section className="projects-library" aria-labelledby={headingId}>
      <header className="projects-library__heading">
        <div>
          <span className="projects-library__eyebrow">
            <LibraryBig size={15} aria-hidden="true" /> YOUR CREATIVE LIBRARY
          </span>
          <h2 id={headingId}>
            全部作品<span>{projects.length}</span>
          </h2>
          <p>让每一个灵感，都有属于自己的篇章。选择作品，继续你的创作。</p>
        </div>
        <button
          className="projects-library__button projects-library__button--primary"
          type="button"
          disabled={disabled}
          onClick={onCreate}
        >
          <Plus size={17} aria-hidden="true" /> 新建作品
        </button>
      </header>

      {projects.length > 0 && (
        <div className="projects-library__toolbar" role="search" aria-label="搜索和筛选作品">
          <label className="projects-library__search">
            <Search size={17} aria-hidden="true" />
            <span className="visually-hidden">搜索作品名称、类型或简介</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索作品名称、类型或简介…"
            />
          </label>
          <label className="projects-library__filter">
            <span>类型</span>
            <select aria-label="类型" value={activeGenre} onChange={(event) => setGenre(event.target.value)}>
              <option value="all">全部类型</option>
              {genres.map((value) => (
                <option value={`genre:${value}`} key={value}>
                  {value}
                </option>
              ))}
              {hasUncategorized && <option value="uncategorized">未分类</option>}
            </select>
          </label>
          <label className="projects-library__filter">
            <span>排序</span>
            <select
              aria-label="排序"
              value={sort}
              onChange={(event) => setSort(event.target.value === 'title' ? 'title' : 'updated')}
            >
              <option value="updated">最近更新</option>
              <option value="title">作品名称</option>
            </select>
          </label>
        </div>
      )}

      <div className="projects-library__results">
        <p role="status" aria-live="polite" aria-atomic="true">
          共 {projects.length} 部作品{projects.length > 0 && ` · 显示 ${visibleProjects.length} 部`}
        </p>
        {(query.trim() || activeGenre !== 'all') && (
          <button type="button" className="projects-library__reset" onClick={resetFilters}>
            <X size={14} aria-hidden="true" />
            清除筛选
          </button>
        )}
      </div>

      {visibleProjects.length > 0 ? (
        <ul className="projects-library__grid">
          {visibleProjects.map((project) => {
            const isCurrent = project.id === currentId;
            const title = project.title.trim() || '未命名作品';
            const timestamp = updatedTimestamp(project.updatedAt);
            return (
              <li
                key={project.id}
                className={`projects-library__card${isCurrent ? ' projects-library__card--current' : ''}`}
              >
                <ProjectCover project={project} />
                <div className="projects-library__card-body">
                  <div className="projects-library__tags">
                    <span className="projects-library__genre">{project.genre.trim() || '未分类'}</span>
                    {isCurrent && (
                      <span className="projects-library__current">
                        <Check size={12} aria-hidden="true" />
                        当前作品
                      </span>
                    )}
                  </div>
                  <h3 title={title}>{title}</h3>
                  <p className="projects-library__description">
                    {project.description.trim() || '还没有填写简介，前往作品设置记录你的故事构想。'}
                  </p>
                  <div className="projects-library__metadata">
                    <span>
                      <BookOpen size={13} aria-hidden="true" />
                      {project.chapters.length} 章
                    </span>
                    <span>
                      <Clock3 size={13} aria-hidden="true" />
                      {Number.isFinite(timestamp) ? (
                        <time
                          dateTime={new Date(timestamp).toISOString()}
                          title={`最近更新：${new Date(timestamp).toLocaleString('zh-CN')}`}
                        >
                          {dateFormatter.format(timestamp)}
                        </time>
                      ) : (
                        '更新时间未知'
                      )}
                    </span>
                  </div>
                  <div className="projects-library__card-actions">
                    <button
                      type="button"
                      className="projects-library__button projects-library__button--open"
                      disabled={disabled}
                      onClick={() => onOpen(project.id)}
                      aria-label={`${isCurrent ? '继续创作' : '打开作品'}：${title}`}
                    >
                      {isCurrent ? '继续创作' : '打开作品'}
                      <ArrowRight size={15} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="projects-library__button projects-library__button--settings"
                      disabled={disabled}
                      onClick={() => onEdit(project.id)}
                      aria-label={`编辑作品设置：${title}`}
                      title="作品设置"
                    >
                      <Settings2 size={16} aria-hidden="true" />
                      <span>设置</span>
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="projects-library__empty">
          <div className="projects-library__empty-icon">
            {projects.length ? (
              <Search size={30} aria-hidden="true" />
            ) : (
              <BookOpen size={32} aria-hidden="true" />
            )}
          </div>
          <h3>{projects.length ? '没有找到匹配的作品' : '你的故事，从这里开始'}</h3>
          <p>
            {projects.length
              ? '试试其他关键词或类型，让灵感重新浮现。'
              : '创建第一部作品，整理世界、人物与章节，把灵感写成故事。'}
          </p>
          <button
            type="button"
            className="projects-library__button projects-library__button--primary"
            disabled={!projects.length && disabled}
            onClick={projects.length ? resetFilters : onCreate}
          >
            {projects.length ? (
              <>
                <X size={16} aria-hidden="true" />
                清除筛选
              </>
            ) : (
              <>
                <Plus size={16} aria-hidden="true" />
                新建第一部作品
              </>
            )}
          </button>
        </div>
      )}
    </section>
  );
}
