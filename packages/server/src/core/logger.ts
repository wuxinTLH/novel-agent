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

/** Only explicitly classified catalog codes reach the operational log sink. Never pass message text. */
import type { OperationalEventCode } from '../../../../shared/operational-logs.js';
let operationalSink: ((code: OperationalEventCode) => void) | undefined;
export function installOperationalLogSink(sink: (code: OperationalEventCode) => void): () => void {
  operationalSink = sink;
  return () => { if (operationalSink === sink) operationalSink = undefined; };
}
export function emitOperationalEvent(code: OperationalEventCode): void {
  try { operationalSink?.(code); }
  catch { /* Operational telemetry must not turn a successful business action into a retry. */ }
}
// Hostile requests must not amplify into an unbounded synchronous disk-write stream.
const boundaryEventTimes = new Map<OperationalEventCode, number>();
export function emitBoundaryEvent(code: OperationalEventCode): void {
  const now = Date.now();
  const previous = boundaryEventTimes.get(code);
  if (previous !== undefined && now - previous < 60_000) return;
  boundaryEventTimes.set(code, now);
  emitOperationalEvent(code);
}
// Explicit wrapper, not a global console patch: CLI JSON and third-party output stay intact.
export const logger = {
  info(message: string, code?: OperationalEventCode) { console.log(`[${formatLogTime()}] [INFO] ${message}`); if (code) emitOperationalEvent(code); },
  warn(message: string, code?: OperationalEventCode) { console.warn(`[${formatLogTime()}] [WARN] ${message}`); if (code) emitOperationalEvent(code); },
  error(message: string, code?: OperationalEventCode) { console.error(`[${formatLogTime()}] [ERROR] ${message}`); if (code) emitOperationalEvent(code); },
};
