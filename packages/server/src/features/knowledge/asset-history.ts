import type { Project, Asset } from '../../../../../shared/types.js';
import { normalizeAssetHistory, restoreAssetRevision as restore, type AssetRevision } from '../../../../../shared/asset-history.js';
import { inputError } from '../projects/project-operations.js';

type VersionedAsset = Asset & { revision?: number; revisions?: AssetRevision[] };
export function archiveAssetRevision(asset: Asset): void {
  const value = asset as VersionedAsset;
  value.revisions = normalizeAssetHistory([{
    revision: value.revision || 1, name: asset.name, category: asset.category, content: asset.content,
    mime: asset.mime, size: asset.size, updatedAt: new Date().toISOString(),
  }, ...(value.revisions || [])]);
  value.revision = (value.revision || 1) + 1;
}
export function restoreAssetRevision(project: Project, assetId: string, expectedRevision: number, revision: number): Asset {
  try { return restore(project, assetId, expectedRevision, revision); }
  catch (error) {
    if (error && typeof error === 'object' && 'status' in error) throw error;
    throw inputError(409, 'ASSET_REVISION_CONFLICT', '资料版本冲突，请刷新后重试。');
  }
}
export function assetRevisions(project: Project, assetId: string): AssetRevision[] {
  const asset = project.assets.find((item) => item.id === assetId) as VersionedAsset | undefined;
  if (!asset) throw inputError(404, 'ASSET_NOT_FOUND', '资料不存在。');
  return normalizeAssetHistory(asset.revisions);
}
