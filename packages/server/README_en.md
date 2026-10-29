# Novel Writing Workbench Backend

[中文](README.md) | English

Workspace package: `space.syjx.agent.novel.server`. Source lives in `src/`; installation, development, tests and builds are coordinated by the root workspace.

## Layout and responsibilities

- `src/index.ts`: process entry, environment loading, data-directory lock, service composition, listening and shutdown.
- `src/core/`: application composition, HTTP policy, feature registration and application-root discovery.
  - `tenancy/`: user scopes, tenant applications and isolated tenant Workers; not a separately deployed service.
- `src/infrastructure/`: technical capabilities reused by features.
  - `storage/`: document-store boundaries, storage configuration, PostgreSQL and relational persistence, synchronization bridge and database Worker.
  - `storage/sql/`: initialization and migration resources, copied into the matching compiled output directory during builds.
  - `database/`: SQLconnect settings, database probes, explicit initialization entry points and dialect drivers.
  - `security/`: local encrypted credential persistence for models and platforms.
- `src/features/`: business responsibilities, with routes, implementation and tests kept together where possible.
  - `auth/`: authentication, sessions and user identity boundaries.
  - `administration/`: local management API, administrator CLI, full-application backup/restore and maintenance CLI.
  - `projects/`: defaults, project data and migrations, project APIs and mutations.
  - `assets/`: reference material and uploaded-file APIs.
  - `chapters/`: chapter editing and manual creation.
  - `workflow/`: workflow APIs, graph validation and post-completion publication continuation.
  - `generation/`: model-call execution and generation validation; `routes/` keeps the HTTP generation API separate.
  - `models/`: model library, runtime settings and providers.
  - `platforms/`: adapters, browser/extension bridges, sessions, publication previews and persistent publication queues.

## Cross-directory boundaries

- Shared frontend/backend protocols remain in root `shared/`; do not duplicate their definitions.
- Root `public/` contains frontend static sources. Root `dist/` contains production frontend output served by the backend.
- `.env`, default `data/` and relative `DATA_DIR` resolve from the workspace/deployment root, not the current process directory or backend package. Existing user data does not need to move.
- Compiled backend output lives in root `build/packages/server/src/`. Tenant/database Workers retain their relative position to calling modules. SQL resources are copied to `infrastructure/storage/sql/` in that output.
- Root discovery walks upward for a manifest named `novel-agent` containing `workspaces`. Retain that root manifest in production; do not infer data paths from the current directory alone.
- Administration and maintenance still use root commands `npm run admin -- ...` and `npm run maintenance -- ...`. The layout does not change authentication, data formats or publication safety boundaries.

## Workflow defaults and concurrency

New chapter templates keep three creative nodes: planning (`plan`) → writing (`draft`, kind `writer`) → consistency review (`review`, kind `audit`), between system start/end nodes. Worldbuilding and outlining remain available separately. Optional author-added nodes do not change this default.

`maxParallelNodes` accepts integers from 1 to 8; an omitted setting runs serially (1). The generation engine bounds execution to 8 and schedules only dependency-ready nodes; a higher cap does not make a linear graph run in parallel. These are source-level contracts, not a claim of live deployment acceptance.
