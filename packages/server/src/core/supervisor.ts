import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';

export const supervisorPolicy = Object.freeze({
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  restartWindowMs: 300_000,
  maxRestarts: 5,
  startupTimeoutMs: 60_000,
  shutdownTimeoutMs: 25_000,
});
export type SupervisorPolicy = { [K in keyof typeof supervisorPolicy]: number };
export type SupervisorEvent = { type: 'starting' | 'ready' | 'restart' | 'stopped'; attempt: number; delayMs?: number };
export interface SupervisorOptions {
  entry: string;
  args?: string[];
  execArgv?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  policy?: SupervisorPolicy;
  signals?: EventEmitter;
  onEvent?: (event: SupervisorEvent) => void;
}

/** No data access: the child alone acquires/releases its ordinary instance lock.
 * Only an unexpected, nonzero post-readiness exit is restartable. Never replay work here.
 * POSIX process groups contain browser/converter descendants; Windows graceful shutdown
 * uses IPC (Node kill(SIGTERM) is not graceful there), with taskkill /T on timeout.
 */
export function supervise(options: SupervisorOptions): Promise<number> {
  const policy = options.policy ?? supervisorPolicy;
  for (const value of Object.values(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('SUPERVISOR_POLICY_INVALID');
  }
  const signals = options.signals ?? process;
  return new Promise(resolve => {
    let child: ChildProcess | undefined;
    let attempt = 0;
    let stopping = false;
    let finished = false;
    let forced = false;
    let cleanup: Promise<void> = Promise.resolve();
    let restartTimer: NodeJS.Timeout | undefined;
    let startupTimer: NodeJS.Timeout | undefined;
    let shutdownTimer: NodeJS.Timeout | undefined;
    const restarts: number[] = [];
    const emit = (type: SupervisorEvent['type'], delayMs?: number) => options.onEvent?.({ type, attempt, ...(delayMs === undefined ? {} : { delayMs }) });
    const clearChildTimers = () => { clearTimeout(startupTimer); clearTimeout(shutdownTimer); };
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(restartTimer);
      clearChildTimers();
      signals.removeListener('SIGINT', interrupt);
      signals.removeListener('SIGTERM', terminate);
      emit('stopped');
      resolve(code);
    };
    const killGroup = (pid: number) => {
      try { process.kill(-pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    };
    const forceStop = () => {
      if (!child?.pid) return;
      forced = true;
      if (process.platform !== 'win32') {
        try { killGroup(child.pid); } catch { child.kill('SIGKILL'); }
      } else {
        // No shell, no user-supplied executable/arguments. Include all still-owned descendants.
        const target = child;
        cleanup = new Promise(done => {
          const killer = spawn('taskkill', ['/pid', String(target.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          killer.on('error', () => { target.kill('SIGKILL'); });
          killer.on('close', code => { if (code !== 0) target.kill('SIGKILL'); done(); });
        });
      }
    };
    const stop = (signal: 'SIGINT' | 'SIGTERM') => {
      if (stopping || finished) return;
      stopping = true;
      clearTimeout(restartTimer);
      clearTimeout(startupTimer);
      if (!child) return finish(0);
      if (process.platform === 'win32') {
        if (child.connected) child.send({ type: 'novel-agent:shutdown', signal }, () => {});
        else forceStop();
      } else child.kill(signal);
      shutdownTimer = setTimeout(forceStop, policy.shutdownTimeoutMs);
    };
    const interrupt = () => stop('SIGINT');
    const terminate = () => stop('SIGTERM');
    signals.on('SIGINT', interrupt);
    signals.on('SIGTERM', terminate);
    const start = () => {
      if (stopping || finished) return;
      let ready = false;
      let orderly = false;
      let startupFailed = false;
      let spawnFailed = false;
      emit('starting');
      const current = spawn(process.execPath, [...(options.execArgv ?? []), options.entry, ...(options.args ?? [])], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      child = current;
      startupTimer = setTimeout(() => {
        startupFailed = true;
        stop('SIGTERM');
      }, policy.startupTimeoutMs);
      current.on('message', message => {
        if (!message || typeof message !== 'object' || !('type' in message)) return;
        if (message.type === 'novel-agent:stopping') orderly = true;
        if (message.type === 'novel-agent:ready' && !stopping && !orderly && !ready) {
          ready = true;
          clearTimeout(startupTimer);
          emit('ready');
        }
      });
      current.on('error', () => { spawnFailed = true; });
      current.on('exit', () => {
        // Kill remaining POSIX descendants even if the leader crashed; do not let a
        // browser or inherited IPC descriptor outlive this generation or hold close open.
        if (process.platform !== 'win32' && current.pid) {
          try { killGroup(current.pid); } catch { startupFailed = true; }
        }
      });
      current.on('close', async (code, signal) => {
        await cleanup;
        child = undefined;
        clearChildTimers();
        const result = code ?? (signal ? 1 : 0);
        if (stopping) return finish(startupFailed || forced ? 1 : result);
        if (process.platform === 'win32' || spawnFailed || startupFailed || !ready || orderly || code === 0 || signal === 'SIGINT' || signal === 'SIGTERM') return finish(spawnFailed ? 1 : result);
        const now = performance.now();
        while (restarts.length && now - restarts[0] >= policy.restartWindowMs) restarts.shift();
        if (restarts.length >= policy.maxRestarts) return finish(1);
        // The rolling budget resets delay only after a genuinely quiet window.
        const delayMs = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** restarts.length);
        restarts.push(now);
        attempt++;
        emit('restart', delayMs);
        restartTimer = setTimeout(start, delayMs);
      });
    };
    start();
  });
}
