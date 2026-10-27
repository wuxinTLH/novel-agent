import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import mysql from 'mysql2/promise';
import mssql from 'mssql';
import { z } from 'zod';
import { sqlConnectConfigSchema, type SQLConnectConfig } from '../../../../../shared/sqlconnect.js';
import {
  storageConfigSchema,
  type AsyncDocumentStorage,
  type ImportDocument,
  type ImportDocumentsResult,
  type StorageConfig,
  type StorageSnapshot,
  type StoredDocument,
} from '../../../../../shared/storage.js';

type Row = Record<string, unknown>;
export type RelationalDialect = SQLConnectConfig['driver'];
/** Parameters use ? markers internally; adapters bind them, never interpolate values. */
export interface RelationalTransaction {
  query(sql: string, parameters?: readonly unknown[]): Promise<Row[]>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(broken?: boolean): void;
}
export interface RelationalAdapter {
  readonly dialect: RelationalDialect;
  begin(): Promise<RelationalTransaction>;
  close(): Promise<void>;
}
export class RelationalStorageError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RelationalStorageError';
  }
}
const fail = (code: string): never => {
  throw new RelationalStorageError(code, `Relational storage: ${code}.`);
};
// SQL Server and MySQL compare trailing spaces as equal even with binary collations.
// Reject those ambiguous identities rather than silently aliasing owners or document/entity keys.
const identifier = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !value.includes('\0') && !value.endsWith(' '));
const documentKey = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !value.includes('\0') && !value.endsWith(' '));
const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const bodySchema = z.string().refine((value) => !value.includes('\0'));
const importSchema = z.object({ key: documentKey, content: bodySchema }).strict();
const receiptSchema = z
  .object({ sourceHash: z.string().regex(/^[a-f0-9]{64}$/), documentCount: revisionSchema })
  .strict();
export const storageSnapshotSchema = z
  .object({
    version: z.literal(3),
    owners: z.array(
      z
        .object({
          ownerId: identifier,
          revision: revisionSchema,
          documents: z.array(importSchema.extend({ revision: revisionSchema.refine((value) => value > 0) })),
          receipts: z.array(receiptSchema),
        })
        .strict(),
    ),
  })
  .strict();
const tables = {
  gate: 'novel_agent_v3_repository',
  owners: 'novel_agent_v3_owners',
  documents: 'novel_agent_v3_documents',
  receipts: 'novel_agent_v3_receipts',
  projects: 'novel_agent_v3_projects',
  chapters: 'novel_agent_v3_chapters',
  assets: 'novel_agent_v3_assets',
  workflows: 'novel_agent_v3_workflows',
} as const;
type EntityTable = 'projects' | 'chapters' | 'assets' | 'workflows';
const entityTables: EntityTable[] = ['projects', 'chapters', 'assets', 'workflows'];
function number(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fail('REVISION_OVERFLOW');
  return parsed;
}
function validate<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  return result.success ? result.data : fail('INVALID_INPUT');
}
/** Lazily connected persistent pools. No credentials/env/files are read implicitly. */
export function createRelationalAdapter(input: SQLConnectConfig): RelationalAdapter {
  const config = sqlConnectConfigSchema.parse(input);
  if (config.driver === 'postgresql') {
    const pool = new Pool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      ssl: config.tls === 'verify' ? { rejectUnauthorized: true } : false,
      connectionTimeoutMillis: config.timeoutMs,
      statement_timeout: config.timeoutMs,
      max: 4,
    });
    return {
      dialect: config.driver,
      close: () => pool.end(),
      async begin() {
        const client = await pool.connect();
        try {
          // The repository gate/owner locks provide write and snapshot serialization.
          // READ COMMITTED observes the preceding lock holder's durable CAS revision.
          await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        } catch (error) {
          client.release(true);
          throw error;
        }
        return {
          async query(sql, parameters = []) {
            let index = 0;
            return (
              await client.query(
                sql.replace(/\?/g, () => `$${++index}`),
                [...parameters],
              )
            ).rows as Row[];
          },
          async commit() {
            await client.query('COMMIT');
          },
          async rollback() {
            await client.query('ROLLBACK');
          },
          release(broken) {
            client.release(broken);
          },
        };
      },
    };
  }
  if (config.driver === 'mysql') {
    const pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      ssl: config.tls === 'verify' ? { rejectUnauthorized: true, verifyIdentity: true } : undefined,
      connectTimeout: config.timeoutMs,
      connectionLimit: 4,
      supportBigNumbers: true,
      bigNumberStrings: true,
      charset: 'utf8mb4',
      multipleStatements: false,
    });
    return {
      dialect: config.driver,
      close: () => pool.end(),
      async begin() {
        const client = await pool.getConnection();
        try {
          await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
          await client.beginTransaction();
        } catch (error) {
          client.destroy();
          throw error;
        }
        return {
          async query(sql, parameters = []) {
            const [rows] = await client.execute(
              sql,
              parameters.map((value) => (typeof value === 'number' ? value : String(value))),
            );
            return Array.isArray(rows) ? (rows as Row[]) : [];
          },
          async commit() {
            await client.commit();
          },
          async rollback() {
            await client.rollback();
          },
          release(broken) {
            if (broken) client.destroy();
            else client.release();
          },
        };
      },
    };
  }
  const pool = new mssql.ConnectionPool({
    server: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionTimeout: config.timeoutMs,
    requestTimeout: config.timeoutMs,
    pool: { max: 4, min: 0 },
    options: {
      encrypt: config.tls === 'verify',
      trustServerCertificate: false,
      abortTransactionOnError: true,
    },
  });
  let connecting: Promise<mssql.ConnectionPool> | undefined;
  return {
    dialect: config.driver,
    async close() {
      if (connecting) {
        await connecting;
        await pool.close();
      }
    },
    async begin() {
      connecting ??= pool.connect().catch((error) => {
        connecting = undefined;
        throw error;
      });
      await connecting;
      const transaction = new mssql.Transaction(pool);
      await transaction.begin(mssql.ISOLATION_LEVEL.SERIALIZABLE);
      return {
        async query(sql, parameters = []) {
          const request = new mssql.Request(transaction);
          parameters.forEach((value, index) => {
            if (typeof value === 'number') request.input(`p${index}`, mssql.BigInt, value);
            else request.input(`p${index}`, mssql.NVarChar(mssql.MAX), value as string);
          });
          let index = 0;
          return (await request.query(sql.replace(/\?/g, () => `@p${index++}`))).recordset ?? [];
        },
        async commit() {
          await transaction.commit();
        },
        async rollback() {
          await transaction.rollback();
        },
        release() {},
      };
    },
  };
}

/** New isolated v3 tables only. Repository gate makes full snapshots consistent with every writer;
 * owner locks additionally establish the per-tenant CAS boundary. No process/runtime activation. */
export class RelationalStorage implements AsyncDocumentStorage {
  private readonly adapter: RelationalAdapter;
  private readonly dialect: RelationalDialect;
  constructor(config: SQLConnectConfig, adapter?: RelationalAdapter) {
    const parsed = sqlConnectConfigSchema.parse(config);
    if (adapter && adapter.dialect !== parsed.driver) fail('DRIVER_MISMATCH');
    this.adapter = adapter ?? createRelationalAdapter(parsed);
    this.dialect = parsed.driver;
  }
  private table(key: keyof typeof tables): string {
    return this.dialect === 'postgresql'
      ? `public.${tables[key]}`
      : this.dialect === 'sqlserver'
        ? `dbo.${tables[key]}`
        : tables[key];
  }
  private async transaction<T>(run: (tx: RelationalTransaction) => Promise<T>): Promise<T> {
    let tx: RelationalTransaction | undefined;
    let committing = false,
      broken = false;
    try {
      tx = await this.adapter.begin();
      const result = await run(tx);
      committing = true;
      await tx.commit();
      return result;
    } catch (error) {
      if (tx)
        try {
          await tx.rollback();
        } catch {
          broken = true;
        }
      if (committing) {
        broken = true;
        return fail('COMMIT_UNCERTAIN');
      }
      if (error instanceof RelationalStorageError) throw error;
      return fail('STORAGE_FAILED');
    } finally {
      tx?.release(broken);
    }
  }
  private async insertAbsent(
    tx: RelationalTransaction,
    table: keyof typeof tables,
    columns: string[],
    values: unknown[],
    keyColumns: string[],
  ) {
    const name = this.table(table);
    const placeholders = columns.map(() => '?').join(', ');
    if (this.dialect === 'postgresql')
      await tx.query(
        `INSERT INTO ${name} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT (${keyColumns.join(', ')}) DO NOTHING`,
        values,
      );
    else if (this.dialect === 'mysql')
      await tx.query(
        `INSERT INTO ${name} (${columns.join(', ')}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${keyColumns[0]} = ${keyColumns[0]}`,
        values,
      );
    else {
      const keys = keyColumns.map((key) => values[columns.indexOf(key)]);
      await tx.query(
        `IF NOT EXISTS (SELECT 1 FROM ${name} WITH (UPDLOCK, HOLDLOCK) WHERE ${keyColumns.map((key) => `${key} = ?`).join(' AND ')}) INSERT INTO ${name} (${columns.join(', ')}) VALUES (${placeholders})`,
        [...keys, ...values],
      );
    }
  }
  private async lock(tx: RelationalTransaction, table: 'gate' | 'owners', column: string, value: string) {
    const hint = this.dialect === 'sqlserver' ? ' WITH (UPDLOCK, HOLDLOCK)' : '';
    const rows = await tx.query(
      `SELECT revision FROM ${this.table(table)}${hint} WHERE ${column} = ?${this.dialect === 'sqlserver' ? '' : ' FOR UPDATE'}`,
      [value],
    );
    // A missing gate must never silently turn cross-process serialization into a no-op.
    if (rows.length !== 1) fail('SCHEMA_NOT_READY');
  }
  private async gate(tx: RelationalTransaction) {
    await this.lock(tx, 'gate', 'repository_id', 'default');
  }
  private async owner(tx: RelationalTransaction, ownerId: string) {
    await this.insertAbsent(tx, 'owners', ['owner_id', 'revision'], [ownerId, 0], ['owner_id']);
    await this.lock(tx, 'owners', 'owner_id', ownerId);
  }
  async migrate(): Promise<void> {
    await this.transaction(async (tx) => {
      if (this.dialect === 'sqlserver')
        await tx.query(
          "DECLARE @r int; EXEC @r = sys.sp_getapplock @Resource = 'novel_agent_v3_migration', @LockMode = 'Exclusive', @LockOwner = 'Transaction'; IF @r < 0 THROW 50000, 'Migration lock failed', 1;",
        );
      if (this.dialect === 'postgresql') await tx.query('SELECT pg_advisory_xact_lock(?)', [1851880546]);
      const text =
        this.dialect === 'sqlserver' ? 'NVARCHAR(MAX)' : this.dialect === 'mysql' ? 'LONGTEXT' : 'TEXT';
      const key = (length: number) =>
        this.dialect === 'sqlserver'
          ? `NVARCHAR(${length}) COLLATE Latin1_General_100_BIN2`
          : this.dialect === 'mysql'
            ? `VARCHAR(${length}) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`
            : `VARCHAR(${length}) COLLATE "C"`;
      const definitions: Array<[keyof typeof tables, string]> = [
        ['gate', `repository_id ${key(128)} NOT NULL PRIMARY KEY, revision BIGINT NOT NULL`],
        ['owners', `owner_id ${key(128)} NOT NULL PRIMARY KEY, revision BIGINT NOT NULL`],
        [
          'documents',
          `owner_id ${key(128)} NOT NULL, document_key ${key(255)} NOT NULL, content ${text} NOT NULL, revision BIGINT NOT NULL, PRIMARY KEY (owner_id, document_key)`,
        ],
        [
          'receipts',
          `owner_id ${key(128)} NOT NULL, source_hash ${key(64)} NOT NULL, document_count BIGINT NOT NULL, PRIMARY KEY (owner_id, source_hash)`,
        ],
        ...entityTables.map(
          (table) =>
            [
              table,
              `owner_id ${key(128)} NOT NULL, project_id ${key(128)} NOT NULL, entity_id ${key(128)} NOT NULL, entity_name ${text} NOT NULL, body ${text} NOT NULL, content_hash ${key(64)} NOT NULL, PRIMARY KEY (owner_id, project_id, entity_id)`,
            ] as [EntityTable, string],
        ),
      ];
      for (const [table, definition] of definitions) {
        const name = this.table(table);
        await tx.query(
          this.dialect === 'sqlserver'
            ? `IF OBJECT_ID(N'${name}', N'U') IS NULL CREATE TABLE ${name} (${definition})`
            : `CREATE TABLE IF NOT EXISTS ${name} (${definition})${this.dialect === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin' : ''}`,
        );
      }
      await this.insertAbsent(tx, 'gate', ['repository_id', 'revision'], ['default', 0], ['repository_id']);
    });
  }
  async readDocument(ownerId: string, key: string): Promise<StoredDocument | null> {
    validate(identifier, ownerId);
    validate(documentKey, key);
    return this.transaction(async (tx) => {
      if (key === 'projects.json') await this.gate(tx);
      const rows = await tx.query(
        `SELECT revision, content FROM ${this.table('documents')} WHERE owner_id = ? AND document_key = ?`,
        [ownerId, key],
      );
      return rows.length
        ? {
            revision: number(rows[0].revision),
            content:
              key === 'projects.json'
                ? await this.reconstruct(tx, ownerId, String(rows[0].content))
                : String(rows[0].content),
          }
        : null;
    });
  }
  private async current(tx: RelationalTransaction, ownerId: string, key: string) {
    return tx.query(
      `SELECT revision, content FROM ${this.table('documents')} WHERE owner_id = ? AND document_key = ?`,
      [ownerId, key],
    );
  }
  private async put(
    tx: RelationalTransaction,
    ownerId: string,
    key: string,
    content: string,
    revision: number,
    exists: boolean,
  ) {
    if (key === 'projects.json') content = await this.project(tx, ownerId, content);
    if (exists)
      await tx.query(
        `UPDATE ${this.table('documents')} SET content = ?, revision = ? WHERE owner_id = ? AND document_key = ?`,
        [content, revision, ownerId, key],
      );
    else
      await tx.query(
        `INSERT INTO ${this.table('documents')} (owner_id, document_key, content, revision) VALUES (?, ?, ?, ?)`,
        [ownerId, key, content, revision],
      );
  }
  private async bump(tx: RelationalTransaction, ownerId: string) {
    const rows = await tx.query(`SELECT revision FROM ${this.table('owners')} WHERE owner_id = ?`, [ownerId]);
    const next = number(rows[0]?.revision) + 1;
    if (!Number.isSafeInteger(next)) fail('REVISION_OVERFLOW');
    await tx.query(`UPDATE ${this.table('owners')} SET revision = ? WHERE owner_id = ?`, [next, ownerId]);
  }
  async writeDocument(
    ownerId: string,
    key: string,
    content: string,
    expectedRevision: number,
  ): Promise<number> {
    validate(identifier, ownerId);
    validate(documentKey, key);
    validate(bodySchema, content);
    validate(revisionSchema, expectedRevision);
    if (expectedRevision === Number.MAX_SAFE_INTEGER) fail('REVISION_OVERFLOW');
    return this.transaction(async (tx) => {
      await this.gate(tx);
      await this.owner(tx, ownerId);
      const rows = await this.current(tx, ownerId, key);
      if ((rows.length ? number(rows[0].revision) : 0) !== expectedRevision) fail('REVISION_CONFLICT');
      const next = expectedRevision + 1;
      await this.put(tx, ownerId, key, content, next, rows.length > 0);
      await this.bump(tx, ownerId);
      return next;
    });
  }
  async importDocuments(
    ownerId: string,
    sourceHash: string,
    documents: ImportDocument[],
  ): Promise<ImportDocumentsResult> {
    validate(identifier, ownerId);
    validate(receiptSchema.shape.sourceHash, sourceHash);
    documents = validate(z.array(importSchema), documents);
    if (new Set(documents.map((document) => document.key)).size !== documents.length) fail('INVALID_INPUT');
    return this.transaction(async (tx) => {
      await this.gate(tx);
      await this.owner(tx, ownerId);
      const receipts = await tx.query(
        `SELECT document_count FROM ${this.table('receipts')} WHERE owner_id = ? AND source_hash = ?`,
        [ownerId, sourceHash],
      );
      if (receipts.length) return { imported: false, count: number(receipts[0].document_count) };
      const existing = await tx.query(
        `SELECT document_key FROM ${this.table('documents')} WHERE owner_id = ?`,
        [ownerId],
      );
      if (existing.length) fail('IMPORT_CONFLICT');
      for (const document of documents) await this.put(tx, ownerId, document.key, document.content, 1, false);
      await tx.query(
        `INSERT INTO ${this.table('receipts')} (owner_id, source_hash, document_count) VALUES (?, ?, ?)`,
        [ownerId, sourceHash, documents.length],
      );
      await this.bump(tx, ownerId);
      return { imported: true, count: documents.length };
    });
  }
  async exportSnapshot(): Promise<StorageSnapshot> {
    return this.transaction(async (tx) => {
      await this.gate(tx);
      const owners = await tx.query(
        `SELECT owner_id, revision FROM ${this.table('owners')} ORDER BY owner_id`,
      );
      const result: StorageSnapshot = { version: 3, owners: [] };
      for (const owner of owners) {
        const ownerId = String(owner.owner_id);
        const documents = await tx.query(
          `SELECT document_key, content, revision FROM ${this.table('documents')} WHERE owner_id = ? ORDER BY document_key`,
          [ownerId],
        );
        const receipts = await tx.query(
          `SELECT source_hash, document_count FROM ${this.table('receipts')} WHERE owner_id = ? ORDER BY source_hash`,
          [ownerId],
        );
        const exported = [];
        for (const row of documents)
          exported.push({
            key: String(row.document_key),
            content:
              row.document_key === 'projects.json'
                ? await this.reconstruct(tx, ownerId, String(row.content))
                : String(row.content),
            revision: number(row.revision),
          });
        result.owners.push({
          ownerId,
          revision: number(owner.revision),
          documents: exported,
          receipts: receipts.map((row) => ({
            sourceHash: String(row.source_hash),
            documentCount: number(row.document_count),
          })),
        });
      }
      return result;
    });
  }
  async importSnapshot(input: StorageSnapshot): Promise<void> {
    const snapshot = validate(storageSnapshotSchema, input);
    if (new Set(snapshot.owners.map((owner) => owner.ownerId)).size !== snapshot.owners.length)
      fail('INVALID_INPUT');
    for (const owner of snapshot.owners) {
      if (
        new Set(owner.documents.map((document) => document.key)).size !== owner.documents.length ||
        new Set(owner.receipts.map((receipt) => receipt.sourceHash)).size !== owner.receipts.length
      )
        fail('INVALID_INPUT');
    }
    await this.transaction(async (tx) => {
      await this.gate(tx);
      for (const table of ['owners', 'documents', 'receipts', ...entityTables] as const)
        if ((await tx.query(`SELECT 1 AS present FROM ${this.table(table)}`)).length)
          fail('SNAPSHOT_CONFLICT');
      for (const owner of [...snapshot.owners].sort((a, b) => a.ownerId.localeCompare(b.ownerId))) {
        await this.owner(tx, owner.ownerId);
        for (const document of owner.documents)
          await this.put(tx, owner.ownerId, document.key, document.content, document.revision, false);
        for (const receipt of owner.receipts)
          await tx.query(
            `INSERT INTO ${this.table('receipts')} (owner_id, source_hash, document_count) VALUES (?, ?, ?)`,
            [owner.ownerId, receipt.sourceHash, receipt.documentCount],
          );
        await tx.query(`UPDATE ${this.table('owners')} SET revision = ? WHERE owner_id = ?`, [
          owner.revision,
          owner.ownerId,
        ]);
      }
    });
  }
  private async project(tx: RelationalTransaction, ownerId: string, content: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return fail('INVALID_PROJECTS');
    }
    const entity = z.object({ id: identifier }).passthrough();
    const schema = z.array(
      entity.extend({
        chapters: z.array(entity).optional(),
        assets: z.array(entity).optional(),
        workflows: z.array(entity).optional(),
      }),
    );
    const projects = validate(schema, parsed);
    const desired: Record<
      EntityTable,
      Map<string, { projectId: string; entityId: string; body: string; name: string; hash: string }>
    > = { projects: new Map(), chapters: new Map(), assets: new Map(), workflows: new Map() };
    const add = (table: EntityTable, projectId: string, entityId: string, value: Row) => {
      const key = JSON.stringify([projectId, entityId]);
      if (desired[table].has(key)) fail('INVALID_PROJECTS');
      const body = JSON.stringify(value);
      desired[table].set(key, {
        projectId,
        entityId,
        body,
        name: String(value.title ?? value.name ?? ''),
        hash: createHash('sha256').update(body).digest('hex'),
      });
    };
    const manifest = projects.map((project) => ({
      id: project.id,
      collections: Object.fromEntries(
        (['chapters', 'assets', 'workflows'] as const)
          .filter((table) => project[table] !== undefined)
          .map((table) => [table, project[table]!.map((item) => item.id)]),
      ),
    }));
    for (const project of projects) {
      const { chapters = [], assets = [], workflows = [], ...metadata } = project;
      add('projects', project.id, project.id, metadata);
      for (const [table, entities] of [
        ['chapters', chapters],
        ['assets', assets],
        ['workflows', workflows],
      ] as const)
        for (const item of entities) add(table, project.id, item.id, item);
    }
    for (const table of entityTables) {
      const rows = await tx.query(
        `SELECT project_id, entity_id, content_hash FROM ${this.table(table)} WHERE owner_id = ?`,
        [ownerId],
      );
      const existing = new Map(
        rows.map((row) => [JSON.stringify([String(row.project_id), String(row.entity_id)]), row]),
      );
      for (const [key, value] of desired[table]) {
        const old = existing.get(key);
        if (old?.content_hash === value.hash) continue;
        if (old)
          await tx.query(
            `UPDATE ${this.table(table)} SET entity_name = ?, body = ?, content_hash = ? WHERE owner_id = ? AND project_id = ? AND entity_id = ?`,
            [value.name, value.body, value.hash, ownerId, value.projectId, value.entityId],
          );
        else
          await tx.query(
            `INSERT INTO ${this.table(table)} (owner_id, project_id, entity_id, entity_name, body, content_hash) VALUES (?, ?, ?, ?, ?, ?)`,
            [ownerId, value.projectId, value.entityId, value.name, value.body, value.hash],
          );
      }
      // Only keys read under this owner's lock and proven absent in the complete incoming document.
      for (const [key, old] of existing)
        if (!desired[table].has(key))
          await tx.query(
            `DELETE FROM ${this.table(table)} WHERE owner_id = ? AND project_id = ? AND entity_id = ?`,
            [ownerId, old.project_id, old.entity_id],
          );
    }
    return JSON.stringify(manifest);
  }
  /** Entity rows are canonical; document payload contains only ordering/presence manifest. */
  private async reconstruct(
    tx: RelationalTransaction,
    ownerId: string,
    manifestContent: string,
  ): Promise<string> {
    const manifest = validate(
      z.array(
        z
          .object({
            id: identifier,
            collections: z
              .object({
                chapters: z.array(identifier).optional(),
                assets: z.array(identifier).optional(),
                workflows: z.array(identifier).optional(),
              })
              .strict(),
          })
          .strict(),
      ),
      JSON.parse(manifestContent),
    );
    const rows: Record<EntityTable, Map<string, Row>> = {
      projects: new Map(),
      chapters: new Map(),
      assets: new Map(),
      workflows: new Map(),
    };
    for (const table of entityTables)
      for (const row of await tx.query(
        `SELECT project_id, entity_id, body FROM ${this.table(table)} WHERE owner_id = ?`,
        [ownerId],
      ))
        rows[table].set(JSON.stringify([row.project_id, row.entity_id]), row);
    const get = (table: EntityTable, projectId: string, entityId: string): Row => {
      const row = rows[table].get(JSON.stringify([projectId, entityId]));
      if (!row) return fail('PROJECTION_CORRUPT');
      return JSON.parse(String(row.body)) as Row;
    };
    return JSON.stringify(
      manifest.map((item) => {
        const project = get('projects', item.id, item.id);
        for (const table of ['chapters', 'assets', 'workflows'] as const)
          if (item.collections[table] !== undefined)
            project[table] = item.collections[table]!.map((id) => get(table, item.id, id));
        return project;
      }),
    );
  }
  close(): Promise<void> {
    return this.adapter.close();
  }
}
export function createProfileStorage(
  config: StorageConfig,
  profileId: string,
  adapter?: RelationalAdapter,
): RelationalStorage {
  const profile = storageConfigSchema.parse(config).profiles.find((item) => item.id === profileId);
  if (!profile) return fail('UNKNOWN_PROFILE');
  return new RelationalStorage(profile.connection, adapter);
}
