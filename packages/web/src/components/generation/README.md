# Generation components

## Run history versus the current manuscript

`GenerationProgress` presents per-chapter execution records from `Run.chapters`; these are historical facts, not a second chapter catalog. Deleting manuscript chapters must not mutate the run or enable retry for a completed record. The outer run-history disclosure stays open by default. Completed records whose exact chapter identity is known to be absent are grouped in a nested native disclosure that is **closed by default**, with a count in its summary. Authors can expand it without deleting or restoring history. Present, active, candidate, failed, cancelled and unverified records remain in the visible outer list; unknown evidence is never treated as deletion. Grouping preserves order within each list and is presentation-only.

Callers should pass `savedChapterEvidence={project.chapters}` with the **complete current manuscript** alongside the existing `savedChapters={project.chapters.length}` count. The optional evidence accepts `readonly Pick<Chapter, 'id'>[]`; do not pass a filtered/search/paginated chapter list. Omit evidence while the current manuscript is unknown or loading. `[]` means known empty, not unknown.

Completed records are compared by exact `RunChapterProgress.chapterId` → `Chapter.id` only. A new chapter at the same number does not prove the historical result is still present. An exact match establishes current chapter identity, not that its text or revision remains unchanged. An absent identity is labeled “已从书稿删除 / 不在当前书稿”; without evidence or a historical chapter ID, the view states current presence is unverified, rather than inferring saved/deleted from chapter count. Pending, running, candidate, failed and cancelled records retain their run status. Completed records never gain retry actions merely because their manuscript chapter is absent.

UI-owned text follows `useLocale` with scoped Chinese/English copy. Opaque run errors/issues are shown unchanged. No API calls, chapter mutations, run-history removal, or persistent UI preferences are performed by this component.

## Manuscript review layout

The chapter-page `GenerationReviewWorkbench` groups run history, temporary preview and candidate review in a native disclosure. Collapsing it hides presentation only: children remain mounted, polling cleanup and adoption safeguards are unchanged. The chapter page uses normal page scrolling rather than a fixed viewport split between three 180px cards. Its catalog/editor has an independent usable height below review.

Review panes have a minimum 360px reading height, keyboard focus, wrapped text and a single body scrollbar. The optional complete-body disclosure removes that inner scrollbar. At 390px comparison panes stack, and adoption/export/discard controls wrap inside the card. Candidate bodies stay read-only; explicit confirmation, unsaved-draft protection and revision checks are preserved.

After building both artifacts, run `node scripts/smoke-generation-review.mjs`. It copies production artifacts to a disposable application directory with a whitelisted environment and temporary `DATA_DIR`, then supplies long synthetic project/preview responses through an isolated browser route. No model is called. It verifies measured desktop/390px reading/editor geometry, comparison, full-body reading, collapse/expand, dirty adoption protection, cancelled and explicit mocked adoption, and accessible revision-history controls. Screenshots and geometry evidence are written under ignored `test-results/`; no real data or login profile is loaded.

Focused regression coverage:

```sh
node --import tsx --test packages/web/src/components/generation/GenerationProgress.test.ts
```
