import { useConfirm } from '../common/AppDialog';
import { useRef, useState } from 'react';
import { Plus, Search, List, LayoutGrid, PanelsTopLeft, ChevronRight } from 'lucide-react';
import { nodeCatalog } from './nodeCatalog';
import { readNodeView, saveNodeView, type NodeView } from './nodeViewPreference';

import Modal from '../common/Modal';
import { useLocale } from '../../locals/useLocale';
import { translate } from '../../locals/core';

export type NodeFields = { title: string; subtitle: string; prompt: string };
export function applyNodePreset(
  current: NodeFields,
  preset: NodeFields,
  edited: Partial<Record<keyof NodeFields, boolean>>,
): NodeFields {
  return {
    title: edited.title ? current.title : preset.title,
    subtitle: edited.subtitle ? current.subtitle : preset.subtitle,
    prompt: edited.prompt ? current.prompt : preset.prompt,
  };
}
export async function runNodeConfirmation(
  gate: { current: boolean },
  approve: () => Promise<boolean>,
  apply: () => void,
  setConfirming: (value: boolean) => void,
): Promise<void> {
  if (gate.current) return;
  gate.current = true;
  setConfirming(true);
  try {
    if (await approve()) apply();
  } finally {
    gate.current = false;
    setConfirming(false);
  }
}

export default function AddNodeDialog({
  presets,
  busy,
  onClose,
  onAdd,
}: {
  presets: Record<string, NodeFields>;
  busy: boolean;
  onClose: () => void;
  onAdd: (values: NodeFields & { kind: string }) => Promise<void>;
}) {
  const confirmDialog = useConfirm();
  const { locale, t } = useLocale();
  const [view, setView] = useState<NodeView>(() => readNodeView());
  const changeView = (next: NodeView) => {
    if (gate.current) return;
    setView(next);
    saveNodeView(next);
  };
  const [query, setQuery] = useState('');
  const [categoryTitle, setCategoryTitle] = useState('设定与人物');
  const [groupTitle, setGroupTitle] = useState('世界设定');
  const catalog = nodeCatalog(presets, query, (text) => translate(locale, text));
  const category = catalog.find((item) => item.title === categoryTitle) || catalog[0];
  const group = category?.groups.find((item) => item.title === groupTitle) || category?.groups[0];
  const visibleKinds =
    view === 'menu'
      ? group?.kinds || []
      : catalog.flatMap((item) => item.groups.flatMap((group) => group.kinds));
  const count = catalog.reduce(
    (total, item) => total + item.groups.reduce((size, group) => size + group.kinds.length, 0),
    0,
  );
  const [kind, setKind] = useState('world');
  const [fields, setFields] = useState(() => ({ ...presets.world }));
  const [edited, setEdited] = useState<Partial<Record<keyof NodeFields, boolean>>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [attempted, setAttempted] = useState(false);
  const gate = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const locked = busy || pending || confirming;
  const requestConfirmation = (message: string, apply: () => void) => {
    if (locked || gate.current) return;
    void runNodeConfirmation(
      gate,
      async () => !Object.values(edited).some(Boolean) || (await confirmDialog(message)),
      apply,
      setConfirming,
    ).catch(setError);
  };
  const requestClose = () => requestConfirmation('有未保存的修改，确定关闭并丢弃吗？', onClose);
  const limits = { title: 100, subtitle: 300, prompt: 12000 };
  const labels = { title: '节点名称', subtitle: '节点说明', prompt: '创作指令' };
  const errors = Object.fromEntries(
    (Object.keys(fields) as (keyof NodeFields)[]).map((field) => [
      field,
      !fields[field].trim()
        ? `请填写${labels[field]}。`
        : fields[field].length > limits[field]
          ? `最多 ${limits[field]} 个字符。`
          : '',
    ]),
  );
  return (
    <Modal
      title="新增工作流节点"
      description="选择节点职责，再补充它在故事中的任务。添加后可在画布连接上下游。"
      close={requestClose}
      wide
      busy={locked}
      error={error}
      className="add-node-modal"
    >
      <form
        noValidate
        onSubmit={async (event) => {
          event.preventDefault();
          setAttempted(true);
          if (locked || gate.current || Object.values(errors).some(Boolean)) return;
          gate.current = true;
          setPending(true);
          setError(undefined);
          try {
            await onAdd({ ...fields, kind });
          } catch (failure) {
            setError(failure);
          } finally {
            gate.current = false;
            setPending(false);
          }
        }}
      >
        <div className="node-workflow-guide">
          <strong>{t('默认章节顺序：章节规划 → 正文生成 → 一致性审校。')}</strong>
          <details>
            <summary>{t('剧情节点选用建议')}</summary>
            <p>
              {t(
                '可选剧情设计参考：剧情编排 → 冲突设计 → 伏笔安排 → 反转设计 → 高潮编排 → 章节规划。按故事需要选用，不必全部添加或每章运行；连接后才会参与执行，每个运行节点会增加模型调用。',
              )}
            </p>
          </details>
        </div>
        <fieldset className="node-presets" disabled={locked}>
          <legend>节点类型</legend>
          <div className="node-catalog-toolbar">
            <div className="node-catalog-search">
              <Search size={15} aria-hidden="true" />
              <input
                aria-label={t('搜索节点')}
                placeholder={t('搜索名称、用途或分类')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query && (
                <button type="button" aria-label={t('清空搜索')} onClick={() => setQuery('')}>
                  ×
                </button>
              )}
            </div>
            <div className="node-view-switch" role="group" aria-label={t('节点展示方式')}>
              {(
                [
                  { value: 'list', label: '列表展示', text: '列表', Icon: List },
                  { value: 'grid', label: '网格展示', text: '网格', Icon: LayoutGrid },
                  { value: 'menu', label: '分级菜单展示', text: '分级菜单', Icon: PanelsTopLeft },
                ] as const
              ).map((item) => (
                <button
                  type="button"
                  key={item.value}
                  aria-label={t(item.label)}
                  aria-pressed={view === item.value}
                  onClick={() => changeView(item.value)}
                >
                  <item.Icon size={15} aria-hidden="true" />
                  <span>{t(item.text)}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="node-catalog-status" role="status">
            {t('找到 {count} 个节点', { count })} · {t('已选节点')}：
            {translate(locale, presets[kind]?.title || kind)}
          </div>
          <div className={`node-catalog node-catalog--${view}`}>
            {view === 'menu' && category && (
              <>
                <nav className="node-category-nav" aria-label={t('创作阶段')}>
                  {catalog.map((item) => (
                    <button
                      type="button"
                      key={item.title}
                      aria-pressed={category.title === item.title}
                      onClick={() => {
                        setCategoryTitle(item.title);
                        setGroupTitle(item.groups[0].title);
                      }}
                    >
                      {translate(locale, item.title)}
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                  ))}
                </nav>
                <nav className="node-group-nav" aria-label={t('任务分组')}>
                  {category.groups.map((item) => (
                    <button
                      type="button"
                      key={item.title}
                      aria-pressed={group?.title === item.title}
                      onClick={() => setGroupTitle(item.title)}
                    >
                      {translate(locale, item.title)}
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                  ))}
                </nav>
              </>
            )}
            <div className={`node-preset-grid node-preset-grid--${view}`}>
              {visibleKinds.map((value) => {
                const preset = presets[value];
                return (
                  <label key={value} className={`node-preset-card ${kind === value ? 'active' : ''}`}>
                    <input
                      type="radio"
                      name="kind"
                      value={value}
                      checked={kind === value}
                      onChange={() => {
                        if (locked || gate.current) return;
                        setKind(value);
                        const owner = catalog.find((item) =>
                          item.groups.some((group) => group.kinds.includes(value)),
                        );
                        const ownerGroup = owner?.groups.find((group) => group.kinds.includes(value));
                        if (owner && ownerGroup) {
                          setCategoryTitle(owner.title);
                          setGroupTitle(ownerGroup.title);
                        }
                        setFields((current) => applyNodePreset(current, preset, edited));
                      }}
                    />
                    <span>
                      <strong>{translate(locale, preset.title || '自定义 Agent')}</strong>
                      <small>{translate(locale, preset.subtitle)}</small>
                    </span>
                  </label>
                );
              })}
              {!count && <div className="node-catalog-empty">{t('没有匹配的节点，请尝试其他关键词。')}</div>}
            </div>
          </div>
        </fieldset>
        <div className="preset-hint">
          <span>切换类型会保留你编辑过的字段。</span>
          <button
            type="button"
            className="text-button"
            disabled={locked}
            onClick={() =>
              requestConfirmation('应用此预设将替换名称、说明和创作指令，是否继续？', () => {
                setFields({ ...presets[kind] });
                setEdited({});
                setAttempted(false);
              })
            }
          >
            应用此预设
          </button>
        </div>
        {(Object.keys(fields) as (keyof NodeFields)[]).map((field) => (
          <label key={field} htmlFor={`new-node-${field}`}>
            {labels[field]}{' '}
            <small>
              {fields[field].length} / {limits[field]}
            </small>
            {field === 'prompt' ? (
              <textarea
                id={`new-node-${field}`}
                rows={6}
                value={fields[field]}
                disabled={locked}
                aria-invalid={attempted && !!errors[field]}
                aria-describedby={attempted && errors[field] ? `new-node-${field}-error` : undefined}
                onChange={(event) => {
                  if (locked || gate.current) return;
                  setFields({ ...fields, [field]: event.target.value });
                  setEdited({ ...edited, [field]: true });
                }}
              />
            ) : (
              <input
                id={`new-node-${field}`}
                value={fields[field]}
                disabled={locked}
                aria-invalid={attempted && !!errors[field]}
                aria-describedby={attempted && errors[field] ? `new-node-${field}-error` : undefined}
                onChange={(event) => {
                  if (locked || gate.current) return;
                  setFields({ ...fields, [field]: event.target.value });
                  setEdited({ ...edited, [field]: true });
                }}
              />
            )}
            {attempted && errors[field] && (
              <span className="field-error" id={`new-node-${field}-error`}>
                {errors[field]}
              </span>
            )}
          </label>
        ))}
        <div className="modal-actions">
          <button type="button" className="button secondary" disabled={locked} onClick={requestClose}>
            取消
          </button>
          <button className="button primary" disabled={locked}>
            <Plus size={16} />
            {pending ? '正在添加…' : '添加节点'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
