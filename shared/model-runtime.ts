import type { ModelProtocol } from './types.js';

/** Prices are in the configured currency per one million tokens. Unset prices mean unknown. */
export interface ModelRuntimeOptions {
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  contextWindow?: number;
  vision?: boolean;
  maxImages?: number;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  perCallBudgetTokens?: number;
  maxEstimatedCostPerCall?: number;
}
export const modelRuntimeDefaults = {
  temperature: 0.8, maxOutputTokens: 6000, timeoutMs: 180_000,
  contextWindow: 128_000, vision: true, maxImages: 4,
} as const;
export const modelRuntimeNumericRules = {
  temperature: { min: 0, max: 2, integer: false },
  maxOutputTokens: { min: 1, max: 2_000_000, integer: true },
  timeoutMs: { min: 1000, max: 3_600_000, integer: true },
  contextWindow: { min: 1, max: 10_000_000, integer: true },
  maxImages: { min: 0, max: 100, integer: true },
  inputPricePerMillion: { min: 0, max: 1_000_000, integer: false },
  outputPricePerMillion: { min: 0, max: 1_000_000, integer: false },
  perCallBudgetTokens: { min: 1, max: 10_000_000, integer: true },
  maxEstimatedCostPerCall: { min: 0, max: 1_000_000, integer: false },
} as const;
export function validateModelRuntime(value: ModelRuntimeOptions): string[] {
  const errors: string[] = [];
  for (const [key, rule] of Object.entries(modelRuntimeNumericRules)) {
    const n = value[key as keyof typeof modelRuntimeNumericRules];
    if (n !== undefined && (typeof n !== 'number' || !Number.isFinite(n) || n < rule.min || n > rule.max || (rule.integer && !Number.isInteger(n))))
      errors.push(`${key} 必须是 ${rule.min}–${rule.max} 范围内的${rule.integer ? '整数' : '数值'}。`);
  }
  if (value.vision !== undefined && typeof value.vision !== 'boolean') errors.push('vision 必须是布尔值。');
  if ((value.maxOutputTokens ?? modelRuntimeDefaults.maxOutputTokens) > (value.contextWindow ?? modelRuntimeDefaults.contextWindow)) errors.push('最大输出 token 不能超过上下文窗口。');
  if (value.maxEstimatedCostPerCall !== undefined && (value.inputPricePerMillion === undefined || value.outputPricePerMillion === undefined)) errors.push('启用每次预估费用预算时，必须同时配置输入和输出价格。');
  return errors;
}
export function resolveModelRuntime(value: ModelRuntimeOptions = {}) {
  const errors = validateModelRuntime(value);
  if (errors.length) throw new Error(errors.join(' '));
  return {
    temperature: value.temperature ?? modelRuntimeDefaults.temperature,
    maxOutputTokens: value.maxOutputTokens ?? modelRuntimeDefaults.maxOutputTokens,
    timeoutMs: value.timeoutMs ?? modelRuntimeDefaults.timeoutMs,
    contextWindow: value.contextWindow ?? modelRuntimeDefaults.contextWindow,
    vision: value.vision ?? modelRuntimeDefaults.vision,
    maxImages: value.maxImages ?? modelRuntimeDefaults.maxImages,
  };
}
/** Conservative approximation, not a tokenizer; image token costs depend on provider/model. */
export function preflightModel(value: ModelRuntimeOptions & { enabled?: boolean; protocol?: ModelProtocol }, text: string, imageCount: number) {
  const options = resolveModelRuntime(value);
  if (value.enabled === false) throw new Error('该模型已禁用。');
  if (!Number.isInteger(imageCount) || imageCount < 0) throw new Error('图片数量无效。');
  if (imageCount && !options.vision) throw new Error('该模型未启用视觉能力，请移除图片或启用视觉。');
  if (imageCount > options.maxImages) throw new Error(`图片数量超过模型上限 ${options.maxImages}。`);
  const estimatedInputTokens = Array.from(text).length + imageCount * 4096;
  if (estimatedInputTokens + options.maxOutputTokens > options.contextWindow) throw new Error('预计输入和预留输出超过模型上下文窗口，请精简资料或调整模型配置。');
  if (value.protocol === 'anthropic-messages' && options.temperature > 1 && value.temperature !== undefined) throw new Error('Anthropic temperature 必须在 0–1 范围内。');
  const estimatedTotalTokens = estimatedInputTokens + options.maxOutputTokens;
  if (value.perCallBudgetTokens !== undefined && estimatedTotalTokens > value.perCallBudgetTokens)
    throw new Error(`预计输入和预留输出超过每次调用 token 预算 ${value.perCallBudgetTokens}，未发起模型请求。`);
  const estimatedCost = value.inputPricePerMillion !== undefined && value.outputPricePerMillion !== undefined
    ? (estimatedInputTokens * value.inputPricePerMillion + options.maxOutputTokens * value.outputPricePerMillion) / 1_000_000 : undefined;
  if (value.maxEstimatedCostPerCall !== undefined && (estimatedCost === undefined || estimatedCost > value.maxEstimatedCostPerCall))
    throw new Error('预计输入和预留最大输出的费用超过每次调用预估费用预算，未发起模型请求。');
  return { options, estimatedInputTokens, estimatedTotalTokens, estimatedCost, estimated: true as const };
}
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimated: boolean;
  estimatedCost?: number;
}
export function modelUsage(inputTokens: number, outputTokens: number, estimated: boolean, prices: ModelRuntimeOptions = {}): ModelUsage {
  const usage: ModelUsage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimated };
  if (prices.inputPricePerMillion !== undefined && prices.outputPricePerMillion !== undefined)
    usage.estimatedCost = (inputTokens * prices.inputPricePerMillion + outputTokens * prices.outputPricePerMillion) / 1_000_000;
  return usage;
}
