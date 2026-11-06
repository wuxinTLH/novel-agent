# Chapters

Chapter management routes live here. Mutations use the existing project lookup, running-workflow/platform-idle guards, HTTP origin/CSRF policy and synchronous `mutateProject` durability/rollback boundary.

## Atomic local bulk deletion

`POST /api/projects/:projectId/chapters/delete` accepts a strict JSON object:

```json
{
  "chapters": [{ "id": "chapter-id", "expectedRevision": 3 }],
  "workflowId": "active-workflow-id"
}
```

- `chapters` contains 1–500 unique chapter IDs. Each item is strict; `id` is a nonempty string and `expectedRevision` is a positive integer. `workflowId` is optional and, when supplied, must be a nonempty string matching the active workflow.
- Unknown fields, duplicates and invalid bounds return `400 INVALID_INPUT`. A missing chapter (including one belonging to another project), stale revision or replay after deletion returns `409 REVISION_CONFLICT`. A changed active workflow returns `409 WORKFLOW_CONFLICT`.
- The complete selection is checked before mutation. On success one synchronous project mutation removes all selected canonical chapters, invalidates the active workflow outputs using the same mechanism as single deletion and returns the updated `Project` with status 200. Validation failure leaves memory/storage unchanged; persistence failure restores the in-memory project and does not return success.
- Chapter numbers are never renumbered or reused by lowering the high watermark. The watermark retains its prior value and any existing canonical/candidate number reservation, even when deleting every chapter. Surviving chapters, candidates and inactive workflows are preserved.
- This is local canonical deletion only. It does not change platform records, publication configuration, remote drafts or published chapters, and does not invoke platform publication/removal APIs.
- The existing single `DELETE /api/projects/:projectId/chapters/:chapterId` contract is unchanged (including its missing-chapter 404).

Regression tests in `chapter-delete.test.ts` run the real Express middleware/route stack in memory against isolated temporary storage without starting a listener or contacting a network. They cover atomic stale/missing/foreign selections, duplicates and strict bounds (including 500/501), workflow/run/platform/CSRF/origin guards, one-save success, rollback, watermark retention, numbering and unrelated project/publication preservation.
