/** Supported LTS lines with the reviewed security patch baseline. Keep engines in sync. */
export const supportedNodeRange = '^22.23.4 || ^24.22.2';

export function isSupportedNodeVersion(version: string): boolean {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match || match[0] !== version) return false;
  const [, major, minor, patch] = match.map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;
  if (major === 22) return minor > 23 || (minor === 23 && patch >= 4);
  if (major === 24) return minor > 22 || (minor === 22 && patch >= 2);
  return false;
}

export function assertSupportedNodeVersion(version = process.versions.node): void {
  if (!isSupportedNodeVersion(version)) {
    throw new Error(`NODE_RUNTIME_UNSUPPORTED: require ${supportedNodeRange}; received ${version}`);
  }
}
