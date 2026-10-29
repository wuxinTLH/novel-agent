import type { Asset, Project } from './types.js';

export const ASSET_HISTORY_LIMIT = 20;
export interface AssetRevision {
  revision: number;
  name: string;
  category: Asset['category'];
  content: string;
  mime?: string;
  size: number;
  updatedAt: string;
}
type VersionedAsset = Asset & { revision?: number; revisions?: AssetRevision[]; updatedAt?: string };

export function normalizeAssetHistory(history: readonly AssetRevision[] = []): AssetRevision[] {
  const unique = new Map<number, AssetRevision>();
  for (const item of history) if (!unique.has(item.revision)) unique.set(item.revision, item);
  return [...unique.values()].sort((a, b) => b.revision - a.revision).slice(0, ASSET_HISTORY_LIMIT);
}
export function assetSnapshot(asset: Asset): AssetRevision {
  const value = asset as VersionedAsset;
  return { revision: value.revision || 1, name: asset.name, category: asset.category, content: asset.content, mime: asset.mime, size: asset.size, updatedAt: value.updatedAt || asset.createdAt };
}
export function archiveAssetRevision(asset: Asset): void {
  const value = asset as VersionedAsset;
  value.revisions = normalizeAssetHistory([assetSnapshot(asset), ...(value.revisions || [])]);
  value.revision = (value.revision || 1) + 1;
  value.updatedAt = new Date().toISOString();
}
export function restoreAssetRevision(project: Project, assetId: string, expectedRevision: number, revision: number): Asset {
  const asset = project.assets.find((item) => item.id === assetId) as VersionedAsset | undefined;
  if (!asset) throw Object.assign(new Error('资料不存在。'), { status: 404, code: 'ASSET_NOT_FOUND' });
  if ((asset.revision || 1) !== expectedRevision) throw Object.assign(new Error('资料已被修改，请刷新后重试。'), { status: 409, code: 'REVISION_CONFLICT' });
  const previous = normalizeAssetHistory(asset.revisions).find((item) => item.revision === revision);
  if (!previous) throw Object.assign(new Error('该资料历史版本不存在。'), { status: 404, code: 'ASSET_REVISION_NOT_FOUND' });
  archiveAssetRevision(asset);
  Object.assign(asset, { name: previous.name, category: previous.category, content: previous.content, mime: previous.mime, size: previous.size });
  return asset;
}
