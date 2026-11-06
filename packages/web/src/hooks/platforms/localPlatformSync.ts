/** Schedules local GET snapshots only. Callers supply an explicit local-only reader. */
export function startLocalPlatformSync({
  read, active, paused, schedule = (run, delay) => setTimeout(run, delay),
  cancel = (timer) => clearTimeout(timer),
}: {
  read: (signal: AbortSignal, isCurrent: () => boolean) => Promise<void>;
  active: () => boolean;
  paused: () => boolean;
  schedule?: (run: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  const controller = new AbortController();
  let revision = 0;
  let inFlight = false;
  let requested = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const plan = (delay: number) => {
    if (controller.signal.aborted) return;
    if (timer !== undefined) cancel(timer);
    timer = schedule(() => { timer = undefined; void refresh(); }, delay);
  };
  const refresh = async () => {
    if (controller.signal.aborted) return;
    if (inFlight) { requested = true; return; }
    if (paused()) { plan(active() ? 1500 : 5000); return; }
    inFlight = true;
    const captured = revision;
    const isCurrent = () => !controller.signal.aborted && captured === revision && !paused();
    try {
      await read(controller.signal, isCurrent);
    } catch {
      // Background errors must not replace a user's explicit action error or its recovery controls.
      // A later local read retries; initial/manual load errors remain visible in the panel.
    } finally {
      inFlight = false;
      const delay = requested ? 0 : active() ? 1500 : 5000;
      requested = false;
      plan(delay);
    }
  };
  plan(1000);
  return {
    refresh: () => { void refresh(); },
    invalidate: () => { revision++; },
    stop: () => {
      controller.abort();
      if (timer !== undefined) cancel(timer);
    },
  };
}
