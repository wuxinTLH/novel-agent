/** Global operational metadata only; no tenant, project, prompt or credential fields. */
export interface TokenUsageMetrics {
  requests: number; succeeded: number; failed: number; pending: number;
  inputTokens: number; outputTokens: number; totalTokens: number; estimatedRequests: number;
  rpm: { average: number; peak: number };
  tokenPm: { average: number; peak: number };
}
export interface TokenUsageResponse {
  range: { from: string; to: string; timeZone: 'UTC' };
  windowMinutes: number;
  models: string[];
  totals: TokenUsageMetrics;
  byModel: Array<TokenUsageMetrics & { model: string }>;
  daily: Array<TokenUsageMetrics & { day: string }>;
  coverage: { startedAt: string; retentionDays: number; earliestDay: string; complete: false };
}
export const TOKEN_USAGE_MAX_DAYS = 31;
