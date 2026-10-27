import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  Check,
  Pencil,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  WandSparkles,
  X,
} from 'lucide-react';
import { api } from '../api';
import DatabaseSettings from './DatabaseSettings';
import { useConfirm } from './AppDialog';
import type { ModelProtocol, ModelSettings } from '../../shared/types';
import { protocolLabels } from '../../shared/types';

type ModelView = 'switch' | 'add' | 'edit';
type ModelForm = {
  name: string;
  baseUrl: string;
  model: string;
  protocol: ModelProtocol;
  apiKey: string;
  clearKey: boolean;
};

const emptyForm: ModelForm = {
  name: '',
  baseUrl: 'https://api.openai.com/v1',
  model: '',
  protocol: 'chat-completions',
  apiKey: '',
  clearKey: false,
};

function formForModel(settings: ModelSettings, id: string): ModelForm {
  const model = settings.models?.find((item) => item.id === id);
  return model
    ? {
        name: model.name,
        baseUrl: model.baseUrl,
        model: model.model,
        protocol: model.protocol,
        apiKey: '',
        clearKey: false,
      }
    : emptyForm;
}

export default function ModelSettingsPanel({
  settings,
  busy,
  onSave,
  onSettingsChange,
  onError,
}: {
  settings: ModelSettings;
  busy: boolean;
  onSave: (values: object) => void;
  onSettingsChange: (settings: ModelSettings) => void;
  onError: (message: string) => void;
}) {
  const confirmDialog = useConfirm();
  const models = settings.models || [];
  const [view, setView] = useState<ModelView>('switch');
  const [editingId, setEditingId] = useState('');
  const [form, setForm] = useState<ModelForm>(emptyForm);
  const [mode, setMode] = useState(settings.mode);
  const [modelBusy, setModelBusy] = useState(false);

  const activeModel = useMemo(
    () => models.find((model) => model.id === settings.activeModelId),
    [models, settings.activeModelId],
  );

  useEffect(() => setMode(settings.mode), [settings.mode]);

  const mutate = async (action: () => Promise<ModelSettings>, message?: string) => {
    if (modelBusy || busy) return;
    setModelBusy(true);
    onError('');
    try {
      onSettingsChange(await action());
      if (message) setView('switch');
    } catch (error) {
      onError(error instanceof Error ? error.message : '模型设置失败');
    } finally {
      setModelBusy(false);
    }
  };

  const openAdd = () => {
    setForm(emptyForm);
    setEditingId('');
    setView('add');
  };

  const openEdit = (id: string) => {
    setEditingId(id);
    setForm(formForModel(settings, id));
    setView('edit');
  };

  const closeForm = () => {
    setEditingId('');
    setForm(emptyForm);
    setView('switch');
  };

  const update = (field: keyof ModelForm, value: string | boolean) =>
    setForm((current) => ({ ...current, [field]: value }));

  const submitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form.name.trim() || !form.baseUrl.trim() || !form.model.trim()) return;
    const payload = {
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      model: form.model.trim(),
      protocol: form.protocol,
      ...(form.apiKey ? { apiKey: form.apiKey } : {}),
      ...(view === 'edit' ? { clearKey: form.clearKey } : {}),
    };
    void mutate(
      async () => {
        if (view === 'add') {
          await api('/models', { method: 'POST', body: JSON.stringify(payload) });
        } else {
          await api(`/models/${editingId}`, { method: 'PATCH', body: JSON.stringify(payload) });
        }
        return api<ModelSettings>('/settings');
      },
      view === 'add' ? '模型已添加' : '模型已更新',
    );
  };

  const selectModel = (id: string) =>
    void mutate(() => api<ModelSettings>(`/models/${id}/select`, { method: 'POST' }));

  const deleteModel = async (id: string, name: string) => {
    if (!(await confirmDialog(`确定删除模型「${name}」吗？`, { danger: true, confirmText: '删除' }))) return;
    void mutate(async () => {
      await api(`/models/${id}`, { method: 'DELETE' });
      return api<ModelSettings>('/settings');
    });
  };

  if (view === 'add' || view === 'edit') {
    const editingModel = models.find((model) => model.id === editingId);
    return (
      <div className="model-settings-page">
        <div className="model-page-heading">
          <button type="button" className="button secondary model-back" onClick={closeForm} disabled={modelBusy || busy}>
            <ArrowLeft size={16} /> 返回模型切换
          </button>
          <div>
            <span className="eyebrow">MODEL CONFIGURATION</span>
            <h2>{view === 'add' ? '新增模型' : '修改模型'}</h2>
            <p>{view === 'add' ? '保存一个新的模型连接配置。' : `正在修改：${editingModel?.name || '模型配置'}`}</p>
          </div>
        </div>
        <form className="model-editor-page" onSubmit={submitForm}>
          <div className="model-editor-heading">
            <Sparkles size={20} />
            <div>
              <h3>{view === 'add' ? '模型连接信息' : '编辑连接信息'}</h3>
              <p>密钥只用于本机服务进程，不会写入浏览器存储。</p>
            </div>
          </div>
          <label>
            显示名称
            <input value={form.name} onChange={(event) => update('name', event.target.value)} required maxLength={100} placeholder="例如：工作室 Qwen" />
          </label>
          <label>
            服务地址 <span>Base URL</span>
            <input type="url" value={form.baseUrl} onChange={(event) => update('baseUrl', event.target.value)} required placeholder="https://api.openai.com/v1" />
          </label>
          <label>
            接口协议
            <select value={form.protocol} onChange={(event) => update('protocol', event.target.value as ModelProtocol)}>
              {(Object.keys(protocolLabels) as ModelProtocol[]).map((protocol) => (
                <option key={protocol} value={protocol}>{protocolLabels[protocol]}</option>
              ))}
            </select>
          </label>
          <label>
            模型 ID
            <input value={form.model} onChange={(event) => update('model', event.target.value)} required maxLength={100} placeholder="gpt-4.1-mini" />
          </label>
          <label>
            API Key
            <input type="password" autoComplete="off" value={form.apiKey} onChange={(event) => update('apiKey', event.target.value)} placeholder={view === 'edit' ? '留空以保留原密钥' : '输入 API Key'} />
          </label>
          {view === 'edit' && editingModel?.hasKey && (
            <label className="checkbox-label">
              <input type="checkbox" checked={form.clearKey} onChange={(event) => update('clearKey', event.target.checked)} />
              清除当前密钥
            </label>
          )}
          <p className="info-note">{form.protocol === 'anthropic-messages' ? 'Anthropic 使用 x-api-key 与 anthropic-version。' : form.protocol === 'responses' ? 'Responses API 使用 /responses 与 input。' : 'Chat Completions 使用 /chat/completions 与 messages。'}</p>
          <div className="model-editor-actions">
            <button type="button" className="button secondary" onClick={closeForm} disabled={modelBusy || busy}><X size={15} /> 取消</button>
            <button type="submit" className="button primary" disabled={modelBusy || busy}><Check size={15} /> {view === 'add' ? '保存模型' : '保存修改'}</button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="model-settings-page">
      <div className="model-page-heading model-switch-heading">
        <div>
          <span className="eyebrow">MODEL SETTINGS</span>
          <h2>切换模型</h2>
          <p>选择当前创作使用的模型，或进入独立页面管理模型配置。</p>
        </div>
        <div className="model-page-actions">
          <button type="button" className="button secondary" onClick={openAdd} disabled={modelBusy || busy}><Plus size={15} /> 新增模型</button>
          <button type="button" className="button primary" onClick={() => activeModel && openEdit(activeModel.id)} disabled={!activeModel || modelBusy || busy}><Pencil size={15} /> 修改模型</button>
        </div>
      </div>
      <section className="model-switch-card" aria-labelledby="model-switch-title">
        <div className="model-section-heading">
          <div><h3 id="model-switch-title">已保存模型</h3><p>点击“切换使用”后，新的配置会立即用于后续工作流。</p></div>
          <span className="subtle-tag">{models.length} 个配置</span>
        </div>
        <div className="model-switch-list">
          {models.map((model) => (
            <article className={`model-switch-item ${settings.activeModelId === model.id ? 'active' : ''}`} key={model.id}>
              <div className="model-switch-icon"><Sparkles size={17} /></div>
              <div className="model-list-copy"><strong>{model.name}</strong><small>{protocolLabels[model.protocol] || model.protocol} · {model.model} · {model.baseUrl}</small></div>
              <div className="model-list-actions">
                <button type="button" className="button secondary" disabled={settings.activeModelId === model.id || modelBusy || busy} onClick={() => selectModel(model.id)}>{settings.activeModelId === model.id ? '当前使用' : '切换使用'}</button>
                <button type="button" className="icon-button" aria-label={`修改模型 ${model.name}`} disabled={modelBusy || busy} onClick={() => openEdit(model.id)}><Pencil size={14} /></button>
                <button type="button" className="icon-button delete" aria-label={`删除模型 ${model.name}`} disabled={modelBusy || busy} onClick={() => void deleteModel(model.id, model.name)}><Trash2 size={14} /></button>
              </div>
            </article>
          ))}
        </div>
      </section>
      <section className="model-mode-card" aria-labelledby="model-mode-title">
        <div className="model-section-heading"><div><h3 id="model-mode-title">运行模式</h3><p>演示模式不请求外部服务，连接模型会使用上方当前配置。</p></div><ShieldCheck size={19} /></div>
        <div className="mode-options">
          <button type="button" className={mode === 'demo' ? 'active' : ''} onClick={() => setMode('demo')}><WandSparkles size={18} /><strong>演示模式</strong><small>无需密钥，体验创作流程</small>{mode === 'demo' && <Check size={15} />}</button>
          <button type="button" className={mode === 'live' ? 'active' : ''} onClick={() => setMode('live')}><Sparkles size={18} /><strong>连接模型</strong><small>使用当前模型生成小说内容</small>{mode === 'live' && <Check size={15} />}</button>
        </div>
        {mode !== settings.mode && activeModel && <button type="button" className="button primary model-mode-save" onClick={() => onSave({ mode, baseUrl: activeModel.baseUrl, model: activeModel.model, protocol: activeModel.protocol, activeModelId: activeModel.id })} disabled={busy || modelBusy}><Check size={15} /> 保存运行模式</button>}
      </section>
      <DatabaseSettings />
    </div>
  );
}
