# Projects library and account toolbar

- The sidebar **全部作品** entry and the breadcrumb open the dedicated `/projects` route. The current work remains selected until a card is opened; selection respects the unsaved chapter warning and running/busy safeguards.
- The library displays only the current user's `/api/projects` results, with cover/placeholder, chapter count, update time, searchable title/type/description, genre filter and sorting. **打开作品** continues the workflow; **设置** opens that project's settings; **新建作品** retains the existing form.
- The account/local status toolbar uses theme colors and responsive spacing. Login authentication remains disabled by default; the administration button is available only when the local admin session says it is available.

For isolated UI acceptance, run `npm run build && node scripts/smoke-projects-library.mjs`. The script creates only temporary local data and saves viewport screenshots under ignored `.tmp-build/projects-ui`.
