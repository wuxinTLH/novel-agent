import fs from 'node:fs';
import path from 'node:path';
import { type ModelProfile } from '../../../../../shared/types.js';
import { normalizeProtocol, type RuntimeSettings } from '../generation/engine.js';
import { ModelSecretStore } from '../../infrastructure/security/secrets.js';
import { readDocumentFile, writeDocumentFile } from '../../infrastructure/storage/document-storage.js';
export function createModelProvider(dir: string, inheritEnvironment = true) {
  const env = inheritEnvironment ? process.env : {};
  const models = new Map<string, RuntimeSettings>();
  const modelSecrets = new ModelSecretStore(dir);
  const defaultModelId = 'default';
  const modelsFile = path.join(dir, 'models.json');
  const savedModelState = (() => {
    const source = readDocumentFile(modelsFile);
    if (source === null) return { models: [] as RuntimeSettings[], activeModelId: '' };
    try {
      const parsed = JSON.parse(source) as
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
    baseUrl: savedDefault?.baseUrl || env.MODEL_BASE_URL || 'https://api.openai.com/v1',
    model: savedDefault?.model || env.MODEL_NAME || 'gpt-4.1-mini',
    apiKey: '',
    hasKey: false,
    mode: savedDefault?.mode || (env.MODEL_API_KEY ? 'live' : 'demo'),
    activeModelId: savedModelState.activeModelId || savedDefault?.id || defaultModelId,
    protocol: normalizeProtocol(savedDefault?.protocol || env.MODEL_PROTOCOL),
  };
  if (!savedModels.length) models.set(defaultModelId, { ...settings, id: defaultModelId, name: '默认模型' });
  for (const model of savedModels) {
    const id = model.id || defaultModelId;
    const restoredKey = modelSecrets.get(id) || (id === defaultModelId ? env.MODEL_API_KEY || '' : '');
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
    writeDocumentFile(modelsFile, JSON.stringify(safe, null, 2));
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
