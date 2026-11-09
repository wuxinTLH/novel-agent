/** Runtime log rendering only. Never change process TZ or persisted/API timestamps. */
export function readLogTimeZone(env: NodeJS.ProcessEnv = process.env): string {
  const zone = env.LOG_TIME_ZONE?.trim() || 'Asia/Shanghai';
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(0); }
  catch { throw new Error('LOG_TIME_ZONE_INVALID'); }
  return zone;
}

export function formatLogTime(value = new Date(), timeZone = readLogTimeZone()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(value);
  const part = (name: string) => parts.find(item => item.type === name)?.value;
  return `${part('year')}:${part('month')}:${part('day')} ${part('hour')}:${part('minute')}`;
}

// Explicit wrapper, not a global console patch: CLI JSON and third-party output stay intact.
export const logger = {
  info(message: string) { console.log(`[${formatLogTime()}] [INFO] ${message}`); },
  warn(message: string) { console.warn(`[${formatLogTime()}] [WARN] ${message}`); },
  error(message: string) { console.error(`[${formatLogTime()}] [ERROR] ${message}`); },
};
