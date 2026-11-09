/** Display-only fixed UTC+8 formatting; never use for API/storage timestamps. */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(time)) return '—';
  const date = new Date(time + 8 * 60 * 60 * 1000);
  if (!Number.isFinite(date.getTime())) return '—';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${String(date.getUTCFullYear()).padStart(4, '0')}:${pad(date.getUTCMonth() + 1)}:${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/** Calendar bucket labels are not instants: do not shift their day or invent a time. */
export function formatCalendarDate(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.replaceAll('-', ':') : '—';
}
