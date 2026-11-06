# Projects library and account toolbar

- The sidebar **全部作品** entry and the breadcrumb open the dedicated `/projects` route. The current work remains selected until a card is opened; selection respects the unsaved chapter warning and running/busy safeguards.
- The library displays only the current user's `/api/projects` results, with cover/placeholder, chapter count, update time, searchable title/type/description, genre filter and sorting. **打开作品** continues the workflow; **设置** opens that project's settings; **新建作品** retains the existing form.
- Mode/account status sits below the sidebar logo; the administration entry is below the guide and remains permission-gated (local administrator availability or authenticated admin permission). Language is left of the theme menu in the top bar. Native local authentication still defaults off; server requires it enabled offline.
- `WorldStagePanel` organizes worldbuilding references, including text/uploads/map images, into named stages or Ungrouped. Legacy assets remain ungrouped; only empty stages can be deleted. Stage filtering is library presentation, not generation-reference filtering: empty node selection still means all assets. Moving an asset uses its expected revision.
- Novel/character/worldbuilding creation buttons and dialogs use the current workflow family and preserve its selected active workflow; no silent family conversion is implied.

For isolated UI acceptance, run `npm run build && node scripts/smoke-projects-library.mjs`. The script creates only temporary local data and saves viewport screenshots under ignored `.tmp-build/projects-ui`.
