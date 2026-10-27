import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { modelProtocols } from '../../../../../shared/types.js';
import { assertPublicModelUrl, type RuntimeSettings } from '../generation/engine.js';
import type { FeatureService } from '../../core/context.js';
const protocolSchema = z.enum(modelProtocols);
export const modelSettingsService: FeatureService = {
  id: 'model-settings',
  register(app, context) {
    const { modelProvider } = context;
    const { models, settings, modelSecrets, saveModels, publicSettings } = modelProvider;
    app.get('/api/settings', (_req, res) => res.json(publicSettings()));
    app.put('/api/settings', (req, res) => {
      const v = z
        .object({
          baseUrl: z
            .url()
            .refine((value) => /^https?:\/\//.test(value))
            .refine((value) => {
              assertPublicModelUrl(value);
              return true;
            }),
          model: z.string().trim().min(1).max(100),
          mode: z.enum(['demo', 'live']),
          protocol: protocolSchema.optional(),
          apiKey: z.string().max(1000).optional(),
          clearKey: z.boolean().optional(),
          activeModelId: z.string().optional(),
        })
        .parse(req.body);
      const targetId =
        v.activeModelId && models.has(v.activeModelId) ? v.activeModelId : settings.activeModelId;
      const target = targetId ? models.get(targetId) : undefined;
      if (!target) return res.status(404).json({ error: '当前模型不存在，请先添加模型。' });
      settings.activeModelId = target.id;
      target.baseUrl = v.baseUrl.replace(/\/$/, '');
      target.model = v.model;
      target.mode = v.mode;
      if (v.protocol) target.protocol = v.protocol;
      if (v.clearKey) {
        target.apiKey = '';
        modelSecrets.delete(target.id!);
      } else if (v.apiKey) {
        target.apiKey = v.apiKey;
        modelSecrets.set(target.id!, v.apiKey);
      }
      target.hasKey = !!target.apiKey;
      Object.assign(settings, target, { activeModelId: target.id });
      saveModels();
      res.json(publicSettings());
    });
    app.get('/api/models', (_req, res) => res.json(publicSettings().models));
    app.post('/api/models', (req, res) => {
      const v = z
        .object({
          name: z.string().trim().min(1).max(100),
          baseUrl: z
            .url()
            .refine((value) => /^https?:\/\//.test(value))
            .refine((value) => {
              assertPublicModelUrl(value);
              return true;
            }),
          model: z.string().trim().min(1).max(100),
          protocol: protocolSchema.default('chat-completions'),
          apiKey: z.string().max(1000).optional(),
          enabled: z.boolean().default(true),
        })
        .parse(req.body);
      const id = randomUUID();
      const profile: RuntimeSettings = {
        ...v,
        id,
        createdAt: new Date().toISOString(),
        hasKey: !!v.apiKey,
        mode: 'live',
        apiKey: v.apiKey || '',
      };
      models.set(id, profile);
      if (v.apiKey) modelSecrets.set(id, v.apiKey);
      saveModels();
      res.status(201).json(publicSettings().models.find((m) => m.id === id));
    });
    app.patch('/api/models/:modelId', (req, res) => {
      const existing = models.get(req.params.modelId);
      if (!existing) return res.status(404).json({ error: '模型不存在。' });
      const v = z
        .object({
          name: z.string().trim().min(1).max(100).optional(),
          baseUrl: z.string().url().optional(),
          model: z.string().trim().min(1).max(100).optional(),
          protocol: protocolSchema.optional(),
          apiKey: z.string().max(1000).optional(),
          clearKey: z.boolean().optional(),
          enabled: z.boolean().optional(),
        })
        .parse(req.body);
      if (v.name !== undefined) existing.name = v.name;
      if (v.baseUrl !== undefined) existing.baseUrl = v.baseUrl.replace(/\/$/, '');
      if (v.model !== undefined) existing.model = v.model;
      if (v.protocol !== undefined) existing.protocol = v.protocol;
      if (v.enabled !== undefined) existing.enabled = v.enabled;
      if (v.clearKey) {
        existing.apiKey = '';
        modelSecrets.delete(existing.id!);
      } else if (v.apiKey) {
        existing.apiKey = v.apiKey;
        modelSecrets.set(existing.id!, v.apiKey);
      }
      existing.hasKey = !!existing.apiKey;
      if (settings.activeModelId === existing.id) Object.assign(settings, existing);
      saveModels();
      res.json(publicSettings().models.find((m) => m.id === existing.id));
    });
    app.delete('/api/models/:modelId', (req, res) => {
      if (!models.delete(req.params.modelId)) return res.status(404).json({ error: '模型不存在。' });
      modelSecrets.delete(req.params.modelId);
      if (settings.activeModelId === req.params.modelId) {
        const next = models.values().next().value;
        if (next) Object.assign(settings, next, { activeModelId: next.id });
        else settings.activeModelId = undefined;
      }
      saveModels();
      res.json(publicSettings().models);
    });
    app.post('/api/models/:modelId/select', (req, res) => {
      const model = models.get(req.params.modelId);
      if (!model) return res.status(404).json({ error: '模型不存在。' });
      Object.assign(settings, model, { activeModelId: model.id });
      saveModels();
      res.json(publicSettings());
    });
  },
};
