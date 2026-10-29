/** A disconnected response cancels work; only completed work returns its admission slot. */
export interface UploadLease {
  readonly signal: AbortSignal;
  handoff(): boolean;
  disconnect(): void;
  release(): void;
}
export function createUploadLease(returnSlot: () => void): UploadLease {
  const controller = new AbortController();
  let handedOff = false, released = false;
  const release = () => {
    if (released) return;
    released = true;
    returnSlot();
  };
  return {
    signal: controller.signal,
    handoff() {
      if (released || controller.signal.aborted) return false;
      handedOff = true;
      return true;
    },
    disconnect() {
      controller.abort();
      if (!handedOff) release();
    },
    release,
  };
}
