import { z } from 'zod';
import { modelRuntimeNumericRules, validateModelRuntime, type ModelRuntimeOptions } from '../../../../../shared/model-runtime.js';
const numeric = (key: keyof typeof modelRuntimeNumericRules) => {
  const rule = modelRuntimeNumericRules[key];
  let schema = z.number().finite().min(rule.min).max(rule.max);
  if (rule.integer) schema = schema.int();
  return schema.optional();
};
export const runtimeFields = {
  clearInputPrice: z.boolean().optional(), clearOutputPrice: z.boolean().optional(),
  clearTokenBudget: z.boolean().optional(), clearCostBudget: z.boolean().optional(),
  perCallBudgetTokens: numeric('perCallBudgetTokens'), maxEstimatedCostPerCall: numeric('maxEstimatedCostPerCall'),
  temperature: numeric('temperature'), maxOutputTokens: numeric('maxOutputTokens'),
  timeoutMs: numeric('timeoutMs'), contextWindow: numeric('contextWindow'),
  vision: z.boolean().optional(), maxImages: numeric('maxImages'),
  inputPricePerMillion: numeric('inputPricePerMillion'), outputPricePerMillion: numeric('outputPricePerMillion'),
};
export function clearRuntimePrices(target: ModelRuntimeOptions, value: { clearInputPrice?: boolean; clearOutputPrice?: boolean; clearTokenBudget?: boolean; clearCostBudget?: boolean }) {
  if (value.clearInputPrice) delete target.inputPricePerMillion;
  if (value.clearOutputPrice) delete target.outputPricePerMillion;
  if (value.clearTokenBudget) delete target.perCallBudgetTokens;
  if (value.clearCostBudget) delete target.maxEstimatedCostPerCall;
}
export function assertRuntimeConfiguration(value: ModelRuntimeOptions & { protocol?: string; clearInputPrice?: boolean; clearOutputPrice?: boolean; clearTokenBudget?: boolean; clearCostBudget?: boolean }) {
  const effective = { ...value };
  clearRuntimePrices(effective, value);
  const issues = validateModelRuntime(effective);
  if (value.protocol === 'anthropic-messages' && value.temperature !== undefined && value.temperature > 1) issues.push('Anthropic temperature 必须在 0–1 范围内。');
  if (issues.length) throw new z.ZodError(issues.map(message => ({ code: 'custom', path: [], message })));
}
export function runtimeValues(value: ModelRuntimeOptions): ModelRuntimeOptions {
  return Object.fromEntries([...Object.keys(modelRuntimeNumericRules), 'vision'].filter(key => value[key as keyof ModelRuntimeOptions] !== undefined).map(key => [key, value[key as keyof ModelRuntimeOptions]]));
}
