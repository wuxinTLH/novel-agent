import fs from 'node:fs';
import path from 'node:path';
import { type ModelProfile } from '../../shared/types.js';
import { normalizeProtocol, type RuntimeSettings } from '../engine.js';
import { ModelSecretStore } from '../secrets.js';
export function createModelProvider(dir: string) {
  const models = new Map<string, RuntimeSettings>();
  const modelSecrets = new ModelSecretStore(dir);
  const defaultModelId = 'default';
  const modelsFile = path.join(dir, 'models.json');
  const savedModelState = (() => {
    if (!fs.existsSync(modelsFile)) return { models: [] as RuntimeSettings[], activeModelId: '' };
    try {
      const parsed = JSON.parse(fs.readFileSync(modelsFile, 'utf8')) as
        RuntimeSettings[] | { models?: RuntimeSettings[]; activeModelId?: string };
      if (Array.isArray(parsed)) return { models: parsed, activeModelId: '' };
      return {
        models: Array.isArray(parsed.models) ? parsed.models : [],
        activeModelId: parsed.activeModelId || '',
      };
    } catch {
      return { models: [] as RuntimeSettings[], activeModelId: '' };
    }
  })();
  const savedModels = savedModelState.models;
  const savedDefault = savedModels.find((model) => (model.id || defaultModelId) === defaultModelId);
  const settings: RuntimeSettings = {
    baseUrl: savedDefault?.baseUrl || process.env.MODEL_BASE_URL || 'https://api.openai.com/v1',
    model: savedDefault?.model || process.env.MODEL_NAME || 'gpt-4.1-mini',
    apiKey: '',
    hasKey: false,
    mode: savedDefault?.mode || (process.env.MODEL_API_KEY ? 'live' : 'demo'),
    activeModelId: savedModelState.activeModelId || savedDefault?.id || defaultModelId,
    protocol: normalizeProtocol(savedDefault?.protocol || process.env.MODEL_PROTOCOL),
  };
  if (!savedModels.length) models.set(defaultModelId, { ...settings, id: defaultModelId, name: '默认模型' });
  for (const model of savedModels) {
    const id = model.id || defaultModelId;
    const restoredKey =
      modelSecrets.get(id) || (id === defaultModelId ? process.env.MODEL_API_KEY || '' : '');
    models.set(id, {
      ...model,
      id,
      protocol: normalizeProtocol(model.protocol),
      apiKey: restoredKey,
      hasKey: !!restoredKey,
      mode: model.mode || settings.mode,
    });
  }
  {
    const active = models.get(settings.activeModelId || '') || models.values().next().value;
    if (active)
      Object.assign(settings, active, {
        apiKey: active.apiKey,
        hasKey: !!active.apiKey,
        activeModelId: active.id,
      });
  }
  const saveModels = () => {
    const safe = {
      activeModelId: settings.activeModelId,
      models: Array.from(models.values()).map(({ apiKey: _apiKey, ...model }) => model),
    };
    fs.writeFileSync(modelsFile + '.tmp', JSON.stringify(safe, null, 2));
    fs.renameSync(modelsFile + '.tmp', modelsFile);
  };
  const publicModel = (m: RuntimeSettings): ModelProfile => ({
    id: m.id || defaultModelId,
    name: m.name || '未命名模型',
    baseUrl: m.baseUrl,
    model: m.model,
    protocol: normalizeProtocol(m.protocol),
    hasKey: !!m.apiKey,
    enabled: m.enabled !== false,
    createdAt: m.createdAt || new Date().toISOString(),
  });
  const publicSettings = () => ({
    baseUrl: settings.baseUrl,
    model: settings.model,
    mode: settings.mode,
    protocol: normalizeProtocol(settings.protocol),
    hasKey: !!settings.apiKey,
    activeModelId: settings.activeModelId || defaultModelId,
    models: Array.from(models.values()).map(publicModel),
  });
  return { models, settings, modelSecrets, saveModels, publicSettings };
}
export type ModelProvider = ReturnType<typeof createModelProvider>;
