import type { AuthStatus } from '../../../../../shared/auth';

// Compare server identity/authorization, never an origin's localStorage marker.
function identity(session: AuthStatus): string {
  if (!session.enabled) return 'auth-disabled';
  if (!session.authenticated || !session.user) return 'anonymous';
  const { id, role, username, disabled } = session.user;
  return JSON.stringify([id, role, username, disabled]);
}

/** Latest-check-wins and disposal also guard readers that do not honor abort. */
export function createSessionRevalidator(options: {
  read: (signal: AbortSignal) => Promise<AuthStatus>;
  initial: (session: AuthStatus) => void;
  changed: () => void;
  error: (error: unknown) => void;
  checking: () => void;
}) {
  let disposed = false;
  let version = 0;
  let current: string | undefined;
  let controller: AbortController | undefined;
  const dispose = () => {
    disposed = true;
    version++;
    controller?.abort();
  };
  return {
    dispose,
    async check() {
      if (disposed) return;
      const request = ++version;
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      options.checking();
      try {
        const session = await options.read(signal);
        if (disposed || request !== version || signal.aborted) return;
        const next = identity(session);
        if (current === undefined) {
          current = next;
          options.initial(session);
        } else if (next !== current) {
          dispose();
          options.changed();
        }
        // No React state replacement for unchanged sessions: keep dirty drafts mounted.
      } catch (error) {
        if (!disposed && request === version && !signal.aborted) options.error(error);
      }
    },
  };
}
