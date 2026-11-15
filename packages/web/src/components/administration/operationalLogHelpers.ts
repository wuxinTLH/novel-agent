import { logsQuerySchema, type LogAlertConfig, type LogCategory, type LogLevel } from '../../../../../shared/operational-logs';

export type LogFilters = { level: LogLevel | ''; category: LogCategory | ''; from: string; to: string; search: string };
export const LOG_PAGE_SIZE = 50;
export const emptyLogFilters: LogFilters = { level: '', category: '', from: '', to: '', search: '' };
function day(value: string): boolean {
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function validLogFilters(filters: LogFilters): boolean {
  return (!filters.from || day(filters.from)) && (!filters.to || day(filters.to)) && (!filters.from || !filters.to || filters.from <= filters.to) && filters.search.length <= 100 && !/[\u0000-\u001f\u007f-\u009f]/.test(filters.search);
}
export function operationalLogsQuery(filters: LogFilters, offset = 0): string {
  if (!validLogFilters(filters) || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw new RangeError('Invalid log query');
  const query = new URLSearchParams({ limit: String(LOG_PAGE_SIZE), offset: String(offset) });
  for (const key of ['level', 'category', 'search'] as const) if (filters[key]) query.set(key, filters[key]);
  if (filters.from) query.set('from', new Date(filters.from + 'T00:00:00+08:00').toISOString());
  if (filters.to) query.set('to', new Date(Date.parse(filters.to + 'T00:00:00+08:00') + 86_400_000 - 1).toISOString());
  logsQuerySchema.parse(Object.fromEntries(query));
  return '/admin/logs?' + query;
}
export function alertConfigBody(config: LogAlertConfig) {
  const { revision, ...fields } = config;
  return { ...fields, expectedRevision: revision };
}
