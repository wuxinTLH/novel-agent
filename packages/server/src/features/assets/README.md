# Assets

Asset management routes live here.

World assets may have `worldStageId?: string`, referencing a group in the same project's `worldStages`. JSON create and multipart upload accept an optional `worldStageId`; omitted means ungrouped. Multipart upload accepts only two bounded metadata fields (`category`, `worldStageId`), preserving file scanning and lease cleanup. Invalid/foreign groups or non-world assignments return `INVALID_WORLD_STAGE`/400, and uploads revalidate after asynchronous scanning.

Asset PATCH accepts `worldStageId: string | null` alongside required `expectedRevision`; null removes membership. Omitted membership preserves the existing group. Moving a grouped asset out of category `world` requires explicit null (otherwise 400). Image metadata-only moves are supported; image content editing remains forbidden. Every successful patch archives/increments the asset revision, including membership-only changes; stale revisions return `REVISION_CONFLICT`/409. All responses retain the full Project contract. Legacy absent fields remain valid.
