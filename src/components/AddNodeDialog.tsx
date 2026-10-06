import { useConfirm } from './AppDialog';
import { useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import Modal from './Modal';

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
  const [kind, setKind] = useState('world');
  const [fields, setFields] = useState(() => ({ ...presets.world }));
  const [edited, setEdited] = useState<Partial<Record<keyof NodeFields, boolean>>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [attempted, setAttempted] = useState(false);
  const gate = useRef(false);
  const locked = busy || pending;
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
      close={onClose}
      wide
      busy={locked}
      dirty={Object.values(edited).some(Boolean)}
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
        <fieldset className="node-presets" disabled={locked}>
          <legend>节点类型</legend>
          <div className="node-preset-grid">
            {Object.entries(presets).map(([value, preset]) => (
              <label key={value} className={`node-preset-card ${kind === value ? 'active' : ''}`}>
                <input
                  type="radio"
                  name="kind"
                  value={value}
                  checked={kind === value}
                  onChange={() => {
                    setKind(value);
                    setFields((current) => applyNodePreset(current, preset, edited));
                  }}
                />
                <span>
                  <strong>{preset.title || '自定义 Agent'}</strong>
                  <small>{preset.subtitle}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="preset-hint">
          <span>切换类型会保留你编辑过的字段。</span>
          <button
            type="button"
            className="text-button"
            disabled={locked}
            onClick={async () => {
              if (
                Object.values(edited).some(Boolean) &&
                !(await confirmDialog('应用此预设将替换名称、说明和创作指令，是否继续？'))
              )
                return;
              setFields({ ...presets[kind] });
              setEdited({});
              setAttempted(false);
            }}
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
          <button
            type="button"
            className="button secondary"
            disabled={locked}
            onClick={async () => {
              if (
                !Object.values(edited).some(Boolean) ||
                (await confirmDialog('有未保存的修改，确定取消吗？'))
              )
                onClose();
            }}
          >
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
