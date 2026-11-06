# Web Frontend

[中文](README.md) | English

npm workspace package: `space.syjx.agent.novel.web`. This package owns the React UI, browser interactions and theme loading. Server implementation belongs to a different workspace and is not imported directly by the frontend.

## Source layers

- [Entry point](src/main.tsx): React mounting, confirmation provider, authentication gate and global styles.
- [Application](src/app/App.tsx): composition and page navigation. Existing inline workflow, chapter and settings implementations remain together to avoid changing behavior during directory migration.
- `components/` is organized by feature:
  - `common`: shared dialogs, confirmations and errors.
  - `auth`: login and account security.
  - `administration`: management console.
  - `workflow`: workflow-node interactions.
  - `generation`: generation configuration, candidate prose and progress.
  - `chapters`: manual chapter entry.
  - `platforms`: platform bindings and publication batches.
  - `settings`: model and database settings.
  - `projects`: novel project settings.
- `hooks/`: grouped into `generation`, `chapters`, `workflow` and `platforms`; includes domain-level pure functions and nearby tests as well as React hooks.
- [Services](src/services/api.ts): same-origin API requests, session tokens and error handling.
- [Theme loader](src/lib/themes/themes-load.ts): registry validation and concurrency-safe stylesheet loading.
- [Global Sass](src/styles/styles.scss); [administration styles](src/styles/administration.scss) are shared by management and account security.
- [Localization](src/locals/README.md): incremental Chinese/English adoption, not a fully translated application. The language selector uses a themed custom button/menu with radio items rather than a native select; keyboard navigation, Escape and focus restoration are implemented.

## Deliberately retained root boundaries

- [Public theme resources](../../public/themes/README_en.md) remain in root `public/`, referenced through `publicDir` in [Vite configuration](vite.config.ts). Themes still use `/themes/`, and the icon remains `/favicon.svg`; deployment URLs do not change.
- [Shared types](../../shared/types.ts) and validators remain in root `shared/`. Frontend imports them relatively instead of duplicating definitions.
- Build output remains root `dist/`, compatible with the server's static hosting, not a package-local `dist/`.
- Development proxies `/api` and `/uploads` to `http://127.0.0.1:3001`. Directory organization does not change browser routes or API URLs.

## Routes and browser preferences

- `/assets/knowledge` independently hosts knowledge editing with existing type/search, tags/chapter links, revision conflicts and API boundaries. Unsaved edits prompt before replacing an editor, creating a new record, leaving in-app or switching projects; refresh/close uses a browser warning, not autosave.
- The node picker has grid/list/detailed-menu views, persisted in same-origin localStorage as `novel-agent.node-picker.view`. Invalid/unavailable reads default to grid; write failure does not prevent in-session switching. This is unrelated to canvas layout or runtime concurrency.
- Root `npm run build:web` independently builds this frontend. A separate static server may host complete `dist/` (including themes and frontend SPA fallback) with backend `SERVE_WEB=false`; proxy browser `/api` and `/uploads` on the same origin, never rewrite API errors to HTML or add cross-origin business CORS/CSRF bypasses. Integrated backend hosting remains default; `WEB_DIST_DIR` changes its trusted build directory. See [deployment instructions](../../docs/en/user-guide.md#separate-builds-and-same-origin-deployment).

### v0.0.4a authoring and shell updates

- **World stages:** create, rename and filter groups for worldbuilding text, uploaded references and map images; move records between a stage and Ungrouped. Existing assets remain ungrouped. Grouping organizes the library only: it does not filter generation context, and an empty node asset selection still references all assets. Choose explicit node references to limit context. Only empty stages can be deleted.
- **Chapter paging and bulk deletion:** choose 20 / 50 / 100 chapters per page. Bulk mode defaults off, requires its explicit button, and resets on project switch/unmount. Select-all affects the current page only; explicitly selected chapters remain selected across pages with a total count, never an implicit whole-project selection. Selections pin revisions. Save or discard unsaved drafts for every selected chapter, including cached drafts, before deleting. The server atomically checks permissions, running state and all revisions; stale items reject the whole batch without partial deletion. Each batch permits at most 500 chapters. Deletion removes local canonical chapters and their embedded history, invalidates related workflow output, and preserves the chapter-number high-water mark: survivors are not renumbered and deleted numbers are not automatically reused. It never deletes remote platform text or withdraws in-flight remote requests.
- **Shell and workflow families:** mode/account status sits below the sidebar logo; the permission-gated administration entry sits below the guide. Language is left of the theme control in the top bar. Creation buttons and dialogs match the current novel/character/worldbuilding family (创建小说流 / 创建人物流 / 创建世界观流), preserving matching templates and active family selections. Shared dialogs animate entry, exit and resize, respecting reduced motion while retaining focus, busy-state and dirty-edit safeguards.

## Commands

Run from the repository root after installing dependencies with root npm:

```bash
npm run dev --workspace space.syjx.agent.novel.web
npm run build --workspace space.syjx.agent.novel.web
npm run typecheck --workspace space.syjx.agent.novel.web
```

`dev` starts only the frontend (default port 5173); start the server separately. `build` type-checks the frontend and builds static resources, not the server. Use root scripts for repository-wide testing and integration.

Workflow concurrency settings allow 1–8 dependency-ready nodes, defaulting to 1 when unset. The default chapter template remains planning → writer → audit; optional added nodes do not become mandatory. Documentation describes the current source, not live browser or production acceptance.
