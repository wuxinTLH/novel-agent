const UTC_DAY_MS = 86_400_000;

/** Strict UTC calendar parsing: Date.parse alone normalizes impossible dates. */
export function utcDay(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const stamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value ? stamp : undefined;
}

export function inclusiveUtcDays(from: string, to: string): number | undefined {
  const start = utcDay(from);
  const end = utcDay(to);
  if (start === undefined || end === undefined) return undefined;
  return (end - start) / UTC_DAY_MS + 1;
}

export function validTokenUsageRange(from: string, to: string): boolean {
  const days = inclusiveUtcDays(from, to);
  return days !== undefined && days >= 1 && days <= 31;
}

export function defaultTokenUsageRange(now = new Date()): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  return { from: new Date(Date.parse(`${to}T00:00:00Z`) - 6 * UTC_DAY_MS).toISOString().slice(0, 10), to };
}

export function tokenUsageQuery(from: string, to: string, model: string): string {
  if (!validTokenUsageRange(from, to)) throw new RangeError('UTC range must contain 1–31 inclusive calendar days');
  const params = new URLSearchParams({ from, to });
  if (model) params.set('model', model);
  return `/admin/token-usage?${params}`;
}

export interface ChartDatum { label: string; value: number }
export const TOKEN_CHART_COLORS = ['#4f8ff7', '#a77beb', '#22b8a4', '#edaa48', '#e27892', '#6eabc5', '#a0ad58', '#cc8e6b'];

/** Only finite positive values enter WebGL geometry. Never alter the semantic source data. */
export function positiveChartData(data: readonly ChartDatum[]): ChartDatum[] {
  return data.filter((item) => Number.isFinite(item.value) && item.value > 0);
}

/** Retain exact top models and explicitly group the remainder (never silently truncate). */
export function modelChartData(data: readonly ChartDatum[], otherLabel: string, limit = 7): ChartDatum[] {
  const sorted = positiveChartData(data).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  if (sorted.length <= limit) return sorted;
  return [...sorted.slice(0, limit), { label: otherLabel, value: sorted.slice(limit).reduce((sum, item) => sum + item.value, 0) }];
}
