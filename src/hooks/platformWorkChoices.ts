import type { PlatformWork, ProjectPlatformWorkLink } from '../../shared/platforms';

export function platformWorkChoices(
  connectionId: string,
  works: readonly PlatformWork[],
  links: readonly ProjectPlatformWorkLink[],
): Array<{ value: string; label: string }> {
  if (!connectionId) return [];
  const bound = links.filter((link) => link.connectionId === connectionId);
  const boundIds = new Set(bound.map((link) => link.remoteWorkId));
  return [
    ...bound.map((link) => ({ value: `link:${link.id}`, label: `已绑定 · ${link.title} · ${link.remoteWorkId}` })),
    ...works.filter((work) => !boundIds.has(work.id)).map((work) => ({
      value: `work:${work.id}`, label: `未绑定 · ${work.title} · ${work.id}`,
    })),
  ];
}
