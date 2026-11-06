# Projects

Project routes and shared project operations live here.

## World stage grouping

`Project.worldStages?: { id: string; name: string }[]` stores optional ordered worldbuilding groups. Legacy projects may omit it. POST `/api/projects/:projectId/world-stages` with `{name}` creates a server-generated ID (201); PATCH `.../world-stages/:stageId` with `{name}` renames (200); DELETE `.../world-stages/:stageId` removes only an empty group (200, `WORLD_STAGE_OCCUPIED`/409 otherwise). All return the full updated Project and retain the existing project/run/platform mutation guards and tenant HTTP boundary. Missing groups return 404. Names are trimmed, nonempty, at most 80 characters and unique case-sensitively after trimming (`WORLD_STAGE_NAME_CONFLICT`/409); each project permits at most 50 groups (`WORLD_STAGE_LIMIT`/400).

Stored-document validation rejects duplicate IDs/names, excessive groups, non-world membership and missing/cross-project references without changing the source. Normalization preserves optional absence; current JSON restart and relational canonical project/asset projections plus document/snapshot imports retain both fields. No SQL table migration is needed: stage metadata lives in the canonical project body and membership in the canonical asset body. Focused regression: `world-stages.test.ts`; relational coverage uses simulated adapters for all three dialects, not live databases.

`defaults.ts` keeps the default chapter template to planning (`plan`) → writing (`draft`, kind `writer`) → consistency review (`review`, kind `audit`), between system start/end nodes. Worldbuilding and outlining remain separately available, and author-added optional nodes do not become mandatory defaults. Creating a graph without the template flag creates only the system boundaries, not the three-node chapter template. Existing graphs are not automatically expanded to include optional nodes.
