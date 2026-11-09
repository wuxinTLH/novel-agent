import { useLocale } from '../../locals/useLocale';
import { useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import type { Asset } from '../../../../../shared/types';
import Modal from '../common/Modal';
import { useConfirm } from '../common/AppDialog';
import './world-stages.scss';

type Stage = { id: string; name: string };
export default function WorldStagePanel({ stages, assets, selected, disabled, onSelect, onSave, onDelete }: {
  stages: Stage[]; assets: Asset[]; selected: string; disabled: boolean;
  onSelect: (id: string) => void;
  onSave: (name: string, id?: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const { t } = useLocale();
  const confirm = useConfirm();
  const [editor, setEditor] = useState<{ id?: string; name: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const current = stages.find((stage) => stage.id === selected);
  const count = (id: string) => assets.filter((asset) => asset.category === 'world' && (asset.worldStageId || '') === id).length;
  return <section className="world-stages" aria-label={t("世界观阶段")}>
    <div className="world-stages-heading">
      <div><h3>{t("世界观阶段")}</h3><p>{t("按故事阶段分别整理世界观、地图等资料。分组仅用于整理，不会自动改变生成时的资料引用。")}</p></div>
      <button className="button secondary" disabled={disabled || pending || stages.length >= 50} onClick={() => { setError(''); setEditor({ name: '' }); }}><Plus size={15} />{t("新增阶段")}</button>
    </div>
    <div className="world-stage-tabs">
      <button className={selected === 'all' ? 'active' : ''} onClick={() => onSelect('all')}>{t("全部阶段")}</button>
      <button className={selected === '' ? 'active' : ''} onClick={() => onSelect('')}>{t("未分组")}<span>{count('')}</span></button>
      {stages.map((stage) => <button key={stage.id} aria-pressed={selected === stage.id} className={selected === stage.id ? 'active' : ''} onClick={() => onSelect(stage.id)}>{stage.name} <span>{count(stage.id)}</span></button>)}
    </div>
    {current && <div className="world-stage-actions">
      <span>{t("当前阶段：")}{current.name} · {count(current.id)} {t("份资料")}</span>
      <button className="button" disabled={disabled || pending} onClick={() => { setError(''); setEditor(current); }}><Pencil size={14} />{t("重命名阶段")}</button>
      <button className="button" disabled={disabled || pending || count(current.id) > 0} title={count(current.id) ? t("请先将本阶段资料移出或删除，再删除空阶段") : undefined} onClick={async () => {
        const id = current.id;
        if (!(await confirm(t("确定删除空阶段「{value0}」吗？不会删除任何资料。", { value0: current.name })))) return;
        setPending(true); setError('');
        try { await onDelete(id); } catch (cause) { setError(cause instanceof Error ? cause.message : t("删除阶段失败")); } finally { setPending(false); }
      }}><Trash2 size={14} />{t("删除阶段")}</button>
    </div>}
    {error && !editor && <p role="alert">{error}</p>}
    {editor && <Modal title={editor.id ? t("重命名阶段") : t("新增世界观阶段")} busy={pending} error={error} close={() => setEditor(null)}>
      <form onSubmit={async (event) => {
        event.preventDefault(); if (pending || disabled) return;
        setPending(true); setError('');
        try { await onSave(editor.name.trim(), editor.id); setEditor(null); } catch (cause) { setError(cause instanceof Error ? cause.message : t("保存阶段失败")); } finally { setPending(false); }
      }}>
        <label>{t("阶段名称")}<input autoFocus required maxLength={80} value={editor.name} placeholder={t("例如：凡人阶段、修仙阶段")} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></label>
        <button className="button primary full" disabled={pending || disabled || !editor.name.trim()}>{t("保存阶段")}</button>
      </form>
    </Modal>}
  </section>;
}
