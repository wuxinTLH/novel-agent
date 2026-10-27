# SQLconnect: optional SQL connection infrastructure

SQLconnect prepares and tests connections to MySQL, PostgreSQL and Microsoft SQL Server (`mssql` is an alias for `sqlserver`). **Novel projects and chapters still use the existing local JSON storage.** Saving a connection or initializing the schema does not migrate data, change the active storage backend, enable account management, or upload existing novels. The prepared tables are infrastructure for a future explicitly implemented storage adapter.

## Integration

```ts
import { SQLConnectService, createSQLconnectRouter } from './models/sqlconnect.js';
const sqlconnect = new SQLConnectService({ dataDir, appRoot });
// Apply the application's local-origin, authentication and CSRF guards first.
app.use('/api/sqlconnect', createSQLconnectRouter(sqlconnect));
// During application shutdown:
await sqlconnect.close();
```

`dataDir` is the existing private application data directory. `appRoot` is the deployment root containing `server/models/sql`. Constructor loads configuration only; it never opens a database connection or initializes anything. A corrupt config degrades only this optional service: status reports `available:false,errorCode:'SQLCONNECT_CONFIG_UNAVAILABLE'` and the local JSON application may continue. Connection operations and saves fail closed so malformed files are not overwritten. Stop the application, repair or explicitly remove the bad config file, then restart to recover. Dependency injection accepts `drivers: SQLConnectDriverMap`, whose adapters implement `connect(config, signal)` returning `{execute(sql), close()}`. Adapters must honor cancellation and bound their own connection/query/close work.

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

TypeScript does not copy SQL resources. Package **`server/models/sql/init_mysql.sql`, `server/models/sql/init_postgresql.sql`, and `server/models/sql/init_mssql.sql` at the application root alongside `build/`**. `appRoot` makes resolution explicit. Without it, the service locates the same application-root directory both from source `server/models` and compiled `build/server/models`, independent of the current working directory. Deploying only `build/` without those resources permits config/test but explicit initialization fails with a sanitized error; it never falls back to another SQL path.

## Verification

`npx tsx --test server/models/sqlconnect.test.ts` uses injected adapters and a loopback HTTP server; no live database, credentials or network DB are needed. It checks redaction/persistence, strict validation, aliases, explicit confirmation, dialect script selection/GO splitting, concurrency, deadline cancellation and late close, safe errors, offline startup and absence of arbitrary SQL routes. It does not prove vendor-server syntax/permissions or connectivity in a particular deployment; perform optional integration tests against disposable real databases before production use.
