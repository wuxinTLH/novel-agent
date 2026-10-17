import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BookOpen, Check, ImagePlus, Save } from 'lucide-react';
import type { Project } from '../../shared/types';

export default function ProjectSettingsPanel({
  project,
  busy,
  error,
  onSave,
  onUploadCover,
  onError,
}: {
  project: Project;
  busy: boolean;
  error: string;
  onSave: (values: { title: string; genre: string; description: string }) => void;
  onUploadCover: (file: File) => void;
  onError: (message: string) => void;
}) {
  const coverRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(project.title);
  const [genre, setGenre] = useState(project.genre);
  const [description, setDescription] = useState(project.description);

  useEffect(() => {
    setTitle(project.title);
    setGenre(project.genre);
    setDescription(project.description);
  }, [project.id, project.title, project.genre, project.description]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!nextTitle) {
      onError('小说名称不能为空。');
      return;
    }
    onSave({ title: nextTitle, genre: genre.trim(), description });
  };

  return (
    <div className="project-settings-page">
      <div className="project-settings-heading">
        <div>
          <span className="eyebrow">NOVEL SETTINGS</span>
          <h2>小说设置</h2>
          <p>集中管理这部小说的名称、类型、简介和封面，设置会同步到当前作品。</p>
        </div>
        <span className="project-settings-badge"><Check size={15} /> 当前作品</span>
      </div>
      <form className="project-settings-card" onSubmit={submit}>
        <section className="project-settings-section" aria-labelledby="project-basic-settings">
          <div className="project-settings-section-heading">
            <div><h3 id="project-basic-settings">基本信息</h3><p>这些内容会用于作品列表、工作流上下文和后续创作提示。</p></div>
            <BookOpen size={19} />
          </div>
          <div className="project-cover-editor">
            <div className="project-cover-preview">
              {project.coverUrl ? <img src={project.coverUrl} alt="当前小说封面" /> : <BookOpen size={30} />}
            </div>
            <div className="project-cover-copy">
              <strong>小说封面</strong>
              <p>支持 PNG、JPG、WebP，最大 4 MiB。封面只属于当前作品。</p>
              <input ref={coverRef} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) onUploadCover(file); event.target.value = ''; }} />
              <button type="button" className="button secondary" onClick={() => coverRef.current?.click()} disabled={busy}><ImagePlus size={15} /> {project.coverUrl ? '更换封面' : '上传封面'}</button>
            </div>
          </div>
          <label>
            小说名称
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={80} required />
          </label>
          <label>
            小说类型
            <input value={genre} onChange={(event) => setGenre(event.target.value)} maxLength={40} placeholder="例如：东方幻想" />
          </label>
          <label>
            小说简介
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} rows={6} placeholder="写下这部小说的核心冲突、人物关系或创作方向。" />
            <small>{description.length} / 2000 字</small>
          </label>
        </section>
        {error && <p className="project-settings-error" role="alert">{error}</p>}
        <div className="project-settings-actions">
          <span><Save size={15} />修改后保存，新的设定会立即生效。</span>
          <button type="submit" className="button primary" disabled={busy}><Save size={15} /> 保存小说设置</button>
        </div>
      </form>
    </div>
  );
}
