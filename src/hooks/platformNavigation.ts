import { platformIds, type PlatformId } from '../../shared/platforms';

/** Only known platform IDs may appear in a second-level platform URL. */
export function platformFromPath(pathname: string): PlatformId | null {
  const match = /^\/platforms\/([^/]+)$/.exec(pathname);
  return match && platformIds.includes(match[1] as PlatformId) ? match[1] as PlatformId : null;
}

export function platformPath(platform: PlatformId): string {
  return `/platforms/${platform}`;
}
