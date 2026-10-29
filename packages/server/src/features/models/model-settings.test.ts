import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { runtimeFields, assertRuntimeConfiguration } from './model-runtime-schema.js';
import { modelSettingsService } from './model-settings.js';
function routes() {
  const handlers = new Map<string, Function>();
  const models = new Map<string, any>([
    ['one', { id: 'one', name: 'one', baseUrl: 'https://example.com', model: 'a', protocol: 'chat-completions', apiKey: 'secret', hasKey: true, mode: 'live', temperature: 0.1 }],
    ['two', { id: 'two', name: 'two', baseUrl: 'https://example.com', model: 'b', protocol: 'chat-completions', apiKey: '', hasKey: false, mode: 'live' }],
  ]);
  const settings: any = { ...models.get('one'), activeModelId: 'one' };
  const provider = { models, settings, modelSecrets: new Map([['one', 'secret']]), saveModels() {}, publicSettings: () => ({ ...settings, apiKey: undefined, models: [...models.values()].map(({ apiKey, ...v }) => v) }) };
  const app = Object.fromEntries(['get', 'put', 'post', 'patch', 'delete'].map(method => [method, (path: string, handler: Function) => handlers.set(`${method} ${path}`, handler)]));
  modelSettingsService.register(app as any, { modelProvider: provider } as any);
  const call = (route: string, body: unknown, modelId = 'one') => {
    let result: any;
    const res = { json(v: unknown) { result = v; return res; }, status() { return res; } };
    handlers.get(route)!({ body, params: { modelId } }, res);
    return result;
  };
  return { call, provider };
}
test('runtime API schema rejects coercion and jointly validates partial changes', () => {
  const schema = z.object(runtimeFields);
  assert.throws(() => schema.parse({ maxOutputTokens: '20' }));
  assert.throws(() => schema.parse({ timeoutMs: 1 }));
  assert.throws(() => assertRuntimeConfiguration({ maxOutputTokens: 100, contextWindow: 50 }));
  assert.throws(() => assertRuntimeConfiguration({ protocol: 'anthropic-messages', temperature: 1.5 }));
});
test('model route updates validate before mutation, preserve keys and clear old options on switch', () => {
  const { call, provider } = routes();
  assert.throws(() => call('patch /api/models/:modelId', { temperature: 3 }));
  assert.equal(provider.models.get('one').temperature, 0.1);
  call('patch /api/models/:modelId', { temperature: 0, maxOutputTokens: 32 });
  assert.equal(provider.models.get('one').temperature, 0);
  assert.equal(provider.models.get('one').apiKey, 'secret');
  call('patch /api/models/:modelId', { inputPricePerMillion: 2, outputPricePerMillion: 0 });
  call('patch /api/models/:modelId', { clearInputPrice: true });
  assert.equal(provider.settings.inputPricePerMillion, undefined);
  assert.equal(provider.settings.outputPricePerMillion, 0);
  call('post /api/models/:modelId/select', {}, 'two');
  assert.equal(provider.settings.temperature, undefined);
  assert.equal(provider.settings.maxOutputTokens, undefined);
});
test('budget edits validate merged prices and can clear budget with prices atomically', () => {
  const { call, provider } = routes();
  assert.throws(() => call('patch /api/models/:modelId', { maxEstimatedCostPerCall: 0 }));
  call('patch /api/models/:modelId', { inputPricePerMillion: 0, outputPricePerMillion: 0, maxEstimatedCostPerCall: 0, perCallBudgetTokens: 10000 });
  assert.equal(provider.settings.maxEstimatedCostPerCall, 0);
  assert.throws(() => call('patch /api/models/:modelId', { clearInputPrice: true }));
  assert.equal(provider.settings.inputPricePerMillion, 0);
  call('patch /api/models/:modelId', { clearCostBudget: true, clearTokenBudget: true, clearInputPrice: true });
  assert.equal(provider.settings.maxEstimatedCostPerCall, undefined);
  assert.equal(provider.settings.perCallBudgetTokens, undefined);
  assert.equal(provider.settings.inputPricePerMillion, undefined);
});
test('capability preflight route validates images and never returns secrets', () => {
  const { call } = routes();
  call('patch /api/models/:modelId', { vision: false });
  const denied = call('post /api/models/:modelId/preflight', { imageCount: 1 });
  assert.match(denied.error, /视觉/);
  const allowed = call('post /api/models/:modelId/preflight', { text: 'hello' });
  assert.equal(allowed.ok, true); assert.equal(allowed.estimatedInputTokens, 5);
  assert.ok(!JSON.stringify(allowed).includes('secret'));
});
