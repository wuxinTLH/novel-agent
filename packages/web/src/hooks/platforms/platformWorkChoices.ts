import { runtimeT } from "../../locals/runtimeTranslate";
import type { PlatformWork, ProjectPlatformWorkLink } from '../../../../../shared/platforms';

export function platformWorkChoices(
  connectionId: string,
  works: readonly PlatformWork[],
  links: readonly ProjectPlatformWorkLink[],
  format?: (bound: boolean, title: string, id: string) => string,
): Array<{ value: string; label: string }> {
  if (!connectionId) return [];
  const bound = links.filter((link) => link.connectionId === connectionId);
  const boundIds = new Set(bound.map((link) => link.remoteWorkId));
  return [
    ...bound.map((link) => ({ value: `link:${link.id}`, label: runtimeT("已绑定 · {x0} · {x1}", { x0: link.title, x1: link.remoteWorkId }) })),
    ...works.filter((work) => !boundIds.has(work.id)).map((work) => ({
      value: `work:${work.id}`, label: runtimeT("未绑定 · {x0} · {x1}", { x0: work.title, x1: work.id }),
    })),
  ];
}
