# SQLconnect: optional SQL connection infrastructure

[English documentation index](en/README.md) · [English operating guide](en/user-guide.md#sql-and-maintenance) · [中文使用手册](使用手册.md#sqlconnect-数据库连接可选)

SQLconnect prepares and tests connections to MySQL, PostgreSQL and Microsoft SQL Server (`mssql` is an alias for `sqlserver`). **Local JSON remains the default.** Saving this legacy connection or initializing its reserved schema does not migrate data, switch storage or enable authentication. The current v3 relational repository is configured separately with `storage-profiles.json` and activated only by offline `maintenance migrate-all` below. The old PostgreSQL v2 `admin migrate-sql` command remains legacy. MySQL / SQL Server repository adapters currently have mocked coverage only, not proven live-server compatibility.

## Integration

```ts
// From packages/server/src/index.ts:
import { SQLConnectService, createSQLconnectRouter } from './infrastructure/database/sqlconnect.js';
const sqlconnect = new SQLConnectService({ dataDir, appRoot });
// Apply the application's local-origin, authentication and CSRF guards first.
app.use('/api/sqlconnect', createSQLconnectRouter(sqlconnect));
// During application shutdown:
await sqlconnect.close();
```

`dataDir` is the existing private application data directory. `appRoot` is the deployment root containing the workspace manifest and source or compiled `packages/server/src/infrastructure/storage/sql` resources. Constructor loads configuration only; it never opens a database connection or initializes anything. A corrupt config degrades only this optional service: status reports `available:false,errorCode:'SQLCONNECT_CONFIG_UNAVAILABLE'` and the local JSON application may continue. Connection operations and saves fail closed so malformed files are not overwritten. Stop the application, repair or explicitly remove the bad config file, then restart to recover. Dependency injection accepts `drivers: SQLConnectDriverMap`, whose adapters implement `connect(config, signal)` returning `{execute(sql), close()}`. Adapters must honor cancellation and bound their own connection/query/close work.

Mount the factory behind the same protections as other local settings mutations. The factory does not itself implement sessions or CSRF policy, and must not be exposed directly to the public Internet. It sets `Cache-Control: no-store` and returns only sanitized errors. The application must also use bounded JSON request-body parsing and must not log request bodies containing credentials.

### API

- `GET /api/sqlconnect/status`: `{configured,config,busy,storage:'local-json',schemaVersion:1,available,errorCode?}`. `config` is `null` before setup; afterwards it contains nonsecret connection settings and `hasPassword`, never `password`.
- `GET /api/sqlconnect/drivers`: `{drivers:[{id,aliases,defaultPort}]}`. IDs: `mysql` (3306), `postgresql` (5432), `sqlserver` (1433), with `mssql` accepted and normalized.
- `PUT /api/sqlconnect/config`: a full replacement of nonsecret settings, with optional password. Unknown fields are rejected. Returns the redacted status.
- `POST /api/sqlconnect/test`: JSON `{}`. Opens a connection, runs the fixed `SELECT 1`, and closes it. It never initializes the schema.
- `POST /api/sqlconnect/initialize`: JSON `{ "confirmDatabase": "novel_db" }`. Confirmation must exactly match the saved database name. Opens a connection and explicitly runs the bundled dialect script. Returns `{ok:true,database,initialized:true,schemaVersion:1}`; testing returns the same shape with `initialized:false`.

Example config request:

```json
{
  "driver": "postgresql",
  "host": "localhost",
  "port": 5432,
  "database": "novel_db",
  "user": "novel_user",
  "password": "replace-with-your-own-secret",
  "tls": "verify",
  "timeoutMs": 10000
}
```

Omitting `password` preserves the existing saved password. Sending `password:""` explicitly clears it. Do not send `hasPassword` back in a PUT. `tls` defaults to `verify`: real adapters verify TLS certificates and do not implicitly trust self-signed certificates. Explicit `tls:'off'` is permitted only for loopback host literals (`localhost`, `127.0.0.1`, `::1`, `[::1]`). Non-loopback insecure connections are rejected. The timeout defaults to 10 seconds and must be 1–30 seconds. Database names must match `[a-zA-Z_][a-zA-Z0-9_]*` and be at most 63 characters; this intentionally conservative subset works across dialects and forbids SQL identifier injection.

Credentials are persisted in `dataDir/sqlconnect.json` by writing an exclusive temporary file with mode `0600` and atomically renaming it. Existing config files are hardened to mode `0600` on load. Passwords are plaintext at rest, not encrypted: protect the data directory, OS account, backup copies and filesystem ACLs. POSIX mode bits alone do not establish Windows ACL isolation. No raw driver errors, SQL text, connection strings, or passwords are returned to clients.

## Explicit schema initialization

Create the target database out of band, and grant only the required permissions. Scripts operate exclusively inside that preexisting configured database. They never issue `CREATE DATABASE`, switch databases, erase data, or accept user-supplied SQL or script paths. PostgreSQL uses the `public` schema and SQL Server uses `dbo` explicitly. The table prefix is `novel_agent_`:

- `novel_agent_metadata`: schema version marker (`schema_version = 1`).
- `novel_agent_users`: user/owner identity key and display name.
- `novel_agent_projects`: owner-indexed project identity, title and future payload.
- `novel_agent_chapters`: project and owner keys, indexed owner, unique project/chapter number.
- `novel_agent_assets`: owner-indexed project assets and future payload.
- `novel_agent_settings`: per-owner setting keys and future payload.
- `novel_agent_platform_bindings`: owner-indexed project/platform/external-work identifiers, never browser-session credentials.

Project-scoped tables enforce a composite `(owner_id, project_id)` foreign key against the same composite unique project key to prohibit cross-owner linkage. MySQL tables explicitly use InnoDB and utf8mb4 for Chinese text. These database constraints do not provide authentication or SQL-backed application storage.

Scripts are idempotent for this version: rerunning creates only absent objects and preserves existing metadata/data. They are not a general migration or schema repair system; conflicting existing objects can fail safely. Schema version is a module capability marker in status, **not a claim that the configured database has already been initialized**. MySQL DDL may implicitly commit, and initialization is not globally transactional across dialects. Timeout, permissions failure, server restart, or cancellation can leave a partial schema. Fix the cause and explicitly retry initialization with confirmation.

Only one connection operation may run per service instance. Config writes and overlapping operations are rejected with `409` while busy. Every operation attempts to close its connection in `finally`, and aborts when its total operation deadline expires. A timed-out uncooperative adapter keeps the operation lock until it really settles, preventing unsafe overlapping DDL. Shutdown aborts ongoing work and waits at most one additional second; real drivers also have bounded connection/request timeouts. Locks are per process: do not run multiple application processes with the same data directory or initialize the same target concurrently from different processes.

## Build and deployment assets

TypeScript does not copy SQL resources by itself. The root and server workspace build commands run `scripts/copy-server-assets.mjs`, copying all four bundled SQL files from `packages/server/src/infrastructure/storage/sql/` to `build/packages/server/src/infrastructure/storage/sql/`. Deploy the complete `build/` tree with these resources; do not copy only JavaScript. By default the service resolves the sibling SQL directory from its own module, independently of the current working directory. An explicit `appRoot` resolves source or compiled resources beneath the deployment root. Missing resources fail explicit initialization with a sanitized error; no arbitrary SQL path is accepted.

## v3 storage-profiles

The private data directory's `storage-profiles.json` is a version 3 configuration. For example (passwords are placeholders; supply real credentials locally, never commit them):

```json
{
  "version": 3,
  "defaultProfileId": "primary",
  "profiles": [
    {
      "id": "primary",
      "label": "Primary PostgreSQL",
      "connection": {
        "driver": "postgresql",
        "host": "localhost",
        "port": 5432,
        "database": "novel_db",
        "user": "novel_user",
        "password": "REPLACE_LOCALLY_NOT_A_REAL_PASSWORD",
        "tls": "verify",
        "timeoutMs": 10000
      }
    }
  ],
  "ownerProfiles": [
    { "ownerId": "REPLACE_WITH_EXISTING_OWNER_UUID", "profileId": "primary" }
  ]
}
```

Profile IDs and explicit owner bindings must be unique and reference existing profiles; unmapped owners use `defaultProfileId`. Add further profiles with the same connection shape and driver `mysql` / `sqlserver` as needed (usual ports 3306 / 1433). These credentials are plaintext secrets: protect ACLs and backups. The administration database view redacts passwords; omitting a saved password preserves it only when the connection identity is unchanged. Active storage configuration cannot be changed online. A connection check is not migration or live acceptance of a repository adapter.

Create databases separately. Stop **all** runtimes sharing the targets, choose a nonexistent backup destination outside the data tree, and explicitly run:

```powershell
npm run maintenance -- migrate-all --owner <UUID> --destination <EXTERNAL_BACKUP> --confirm
```

Append `--data-dir <PATH>` for a nondefault directory. The maintenance CLI loads the application-root `.env`, but does not infer the service's `DATA_DIR`; explicitly select nondefault data with `--data-dir`. The destination safety backup is mandatory. The operation checks all tenant mappings, imports into empty v3 targets, verifies readback, then activates; no automatic switch and no fallback to JSON after activation. It does not enable authentication. See [the operating guide](使用手册.md#全量迁移到-v3-关系存储) for legacy-owner and recovery precautions.

The `novel_agent_v3_*` repository uses canonical project / chapter / asset / workflow entity tables, document structure and revisions, owner revisions and import receipts. Reading / snapshot export reconstructs complete project documents from entities rather than treating duplicate whole-project JSON as a second canonical copy. Commits use transactions and revision CAS. Database Workers retain persistent pools. A tenant Worker synchronously waits for acknowledged COMMIT, preserving same-tenant ordering while isolating other tenant / control-plane event loops; the runtime cap is 32. A per-profile repository gate serializes snapshot-related operations and writes for consistency, trading throughput for correctness. Authentication control-plane SQL persistence still uses a bounded synchronous wait on the main thread. External platform-account locks are coordinated by the application's main thread across tenant Workers and main-thread runtimes. Verified provider/account identity is HMAC-scoped across tenants; unknown manual login takes a provider-wide lease. Leases have no automatic TTL, and Worker ownership is released only on actual exit or explicit completion. This is a single-process guarantee, not cross-process or cross-host exclusion; independently running applications and manual website edits still require coordination. This is still single-application-instance infrastructure, not distributed scheduling, cross-host publication safety or a measured performance claim.

### Full application backup and restore

```powershell
npm run maintenance -- backup --destination <PATH> --confirm
# Local-only backup restore: no database-config needed
npm run maintenance -- restore --source <PATH> --data-dir <NEW> --confirm
# SQL backup restore: explicit trusted target profiles are mandatory
npm run maintenance -- restore --source <PATH> --database-config <EXPLICIT_TARGET_PROFILES> --data-dir <NEW> --confirm
```

A backup contains the safe complete data tree (binary files and empty directories included), plus all configured v3 repositories' owners, documents, reconstructed entities, revisions and receipts. **It is not an entire database dump**: unrelated tables, DB users / grants and server configuration are outside scope. At every tree level it excludes `.instance.lock`, `.instance.lock.recovery`, `admin-backups`, `.maintenance-journal.json`, `*.tmp` and `.maintenance-*`; symlinks, hardlinks and unsafe paths are rejected. External environment secrets `MODEL_SECRETS_KEY` / `PLATFORM_SECRETS_KEY` are not included: retain and supply them securely. Local secrets and browser state inside the backup still require strict ACLs.

A legacy version 1 SQL activation manifest is explicitly unsupported by maintenance backup: independently use `pg_dump` plus the entire local data directory and external keys. The old partial `admin-backups` facility is not a replacement.

Restore defaults to new / empty files and an empty v3 application repository. SQL restore never trusts backed-up database addresses: provide explicit target profiles covering the source profile IDs / owner mappings. Existing local files have a rollback copy, but multiple database commits are not automatically rolled back. A failure journal `.maintenance-journal.json` blocks startup until manual safe reconciliation of files, committed DB states and backup; do not simply delete it or assume cross-database atomic rollback. Restore revokes authentication sessions, does not replay remote publication, and does not lift the single-instance restriction.

## Verification

After `npm run build`, `node scripts/smoke-administration.mjs` exercises the production API / browser administration UI with disposable local data and no real database. Optional live v3 PostgreSQL acceptance is `npx tsx scripts/test-relational-storage.ts`: explicitly provide `PGHOST`, `PGPORT`, `PGDATABASE=novel_test`, `PGUSER`, `PGPASSWORD` securely. TLS verification is the default; `PGSSLMODE=disable` is allowed only for loopback. It creates schema and retains unique `test-v3-*` rows without destructive cleanup, so use the dedicated test DB with schema privileges. This v3 live script has not been executed here; prior v2 PostgreSQL acceptance is not v3 proof, and MySQL / SQL Server remain mock-only.

`npx tsx --test packages/server/src/infrastructure/database/sqlconnect.test.ts` uses injected adapters and a loopback HTTP server; no live database, credentials or network DB are needed. It checks redaction/persistence, strict validation, aliases, explicit confirmation, dialect script selection/GO splitting, concurrency, deadline cancellation and late close, safe errors, offline startup and absence of arbitrary SQL routes. It does not prove vendor-server syntax/permissions or connectivity in a particular deployment; perform optional integration tests against disposable real databases before production use.
