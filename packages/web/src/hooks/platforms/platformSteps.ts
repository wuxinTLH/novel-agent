export type PlatformStep = 'account' | 'work' | 'setup' | 'review' | 'results';

export function platformStepAccess({ connected, workBound, previewReady }: {
  connected: boolean; workBound: boolean; previewReady: boolean;
}): Record<PlatformStep, boolean> {
  return {
    account: true,
    work: connected,
    setup: connected && workBound,
    review: connected && workBound && previewReady,
    // Always permit read-only recovery, even if a credential expired or a batch is unknown.
    results: true,
  };
}

export function accessiblePlatformStep(step: PlatformStep, access: Record<PlatformStep, boolean>): PlatformStep {
  return access[step] ? step : 'account';
}
