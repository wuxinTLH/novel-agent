import test from 'node:test';
import assert from 'node:assert/strict';
import { validateModelRuntime, resolveModelRuntime, preflightModel, modelUsage } from './model-runtime.js';
test('old configs retain defaults and explicit zero values survive', () => {
  assert.equal(resolveModelRuntime({}).maxOutputTokens, 6000);
  assert.equal(resolveModelRuntime({}).timeoutMs, 180000);
  assert.equal(resolveModelRuntime({ temperature: 0, maxImages: 0 }).temperature, 0);
});
test('runtime numeric limits reject invalid or inconsistent configuration', () => {
  for (const value of [{ timeoutMs: 0 }, { maxOutputTokens: 1.1 }, { temperature: NaN }, { inputPricePerMillion: -1 }, { contextWindow: 100 }, { vision: 'yes' }])
    assert.ok(validateModelRuntime(value as any).length);
  assert.deepEqual(validateModelRuntime({ maxOutputTokens: 100, contextWindow: 100, inputPricePerMillion: 0 }), []);
});
test('preflight rejects disabled model, vision mismatch, image/context excess', () => {
  for (const [config, count] of [[{ enabled: false }, 0], [{ vision: false }, 1], [{ maxImages: 0 }, 1], [{ contextWindow: 6001 }, 0]] as const)
    assert.throws(() => preflightModel(config, 'hello', count));
  assert.equal(preflightModel({}, 'abc', 0).estimatedInputTokens, 3);
  assert.throws(() => preflightModel({ protocol: 'anthropic-messages', temperature: 1.5 }, '', 0));
});
test('per-call token and cost budgets are optional, reserve max output and reject missing prices', () => {
  assert.equal(preflightModel({}, 'abc', 0).estimatedTotalTokens, 6003);
  assert.throws(() => preflightModel({ perCallBudgetTokens: 6002 }, 'abc', 0), /token 预算/);
  assert.equal(preflightModel({ perCallBudgetTokens: 6003 }, 'abc', 0).estimatedTotalTokens, 6003);
  assert.throws(() => preflightModel({ maxEstimatedCostPerCall: 0 }, '', 0), /同时配置/);
  assert.throws(() => preflightModel({ maxEstimatedCostPerCall: 0, inputPricePerMillion: 0, outputPricePerMillion: 1 }, '', 0), /费用预算/);
  assert.equal(preflightModel({ maxEstimatedCostPerCall: 0, inputPricePerMillion: 0, outputPricePerMillion: 0 }, 'abc', 0).estimatedCost, 0);
  assert.equal(preflightModel({ maxOutputTokens: 10, maxEstimatedCostPerCall: 0.000023, inputPricePerMillion: 1, outputPricePerMillion: 2 }, 'abc', 0).estimatedCost, 0.000023);
  assert.ok(validateModelRuntime({ perCallBudgetTokens: 1.1 }).length);
  assert.ok(validateModelRuntime({ maxEstimatedCostPerCall: -1 }).length);
});
test('usage only prices known prices, free prices remain valid', () => {
  assert.equal(modelUsage(10, 2, false).estimatedCost, undefined);
  assert.equal(modelUsage(10, 2, false, { inputPricePerMillion: 0, outputPricePerMillion: 0 }).estimatedCost, 0);
});
