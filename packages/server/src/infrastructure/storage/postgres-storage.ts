import fs from 'node:fs';
import path from 'node:path';
import { sqlResourceDirectory } from './sql-resources.js';
import { Pool, type PoolConfig, type PoolClient } from 'pg';
import type { SQLConnectConfig } from '../../../../../shared/sqlconnect.js';

export interface StoredDocument {
  revision: number;
  content: string;
}
export interface ImportDocument {
  key: string;
  content: string;
}
export interface ImportDocumentsResult {
  imported: boolean;
  count: number;
}
export class PostgresStorageError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PostgresStorageError';
  }
}
export type PostgresStoragePool = Pick<Pool, 'connect' | 'end'>;
const schemaVersion = 2;
const migrationLock = 1851880545;
const invalid = () => new PostgresStorageError('INVALID_INPUT', 'Invalid storage input.');
function text(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.includes('\0'))
    throw invalid();
}
function content(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.includes('\0')) throw invalid();
}
function revision(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new PostgresStorageError('REVISION_OVERFLOW', 'Storage revision is outside the supported range.');
  return parsed;
}
function poolConfig(config: SQLConnectConfig | PoolConfig): PoolConfig {
  if (!('driver' in config)) return config;
  if (config.driver !== 'postgresql')
    throw new PostgresStorageError(
      'UNSUPPORTED_DRIVER',
      'PostgreSQL storage requires the PostgreSQL driver.',
    );
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.tls === 'verify' ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: config.timeoutMs,
    statement_timeout: config.timeoutMs,
    // Do not use client query_timeout: a client-only timeout does not prove rollback/commit outcome.
    max: 4,
  };
}

/** Explicit repository only: no config/environment file reads, activation, or network calls at construction.
 * All writes await COMMIT. Owner row locks serialize this repository's imports and writes;
 * these are not a lease for external side effects or a cross-host application runtime lock.
 */
export class PostgresStorage {
  private readonly pool: PostgresStoragePool;
  constructor(config: SQLConnectConfig | PoolConfig, pool?: PostgresStoragePool) {
    const normalized = poolConfig(config);
    this.pool = pool ?? new Pool(normalized);
  }
  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient | undefined;
    let committing = false;
    let broken: Error | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      const value = await run(client);
      committing = true;
      await client.query('COMMIT');
      return value;
    } catch (error) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = new Error('Storage transaction failed.');
        }
      }
      if (committing) {
        broken = new Error('Storage commit outcome is unknown.');
        throw new PostgresStorageError(
          'COMMIT_UNCERTAIN',
          'Storage commit was not acknowledged; read durable state before retrying.',
        );
      }
      if (error instanceof PostgresStorageError) throw error;
      throw new PostgresStorageError('STORAGE_FAILED', 'PostgreSQL storage operation failed.');
    } finally {
      client?.release(broken);
    }
  }
  async migrate(): Promise<void> {
    const directory = sqlResourceDirectory();
    const v1 = fs.readFileSync(path.join(directory, 'init_postgresql.sql'), 'utf8');
    const v2 = fs.readFileSync(path.join(directory, 'migrate_postgresql_v2.sql'), 'utf8');
    await this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [migrationLock]);
      const exists = await client.query(
        "SELECT to_regclass('public.novel_agent_metadata') AS metadata, to_regclass('public.novel_agent_schema_migrations') AS ledger",
      );
      if (exists.rows[0]?.metadata) {
        const result = await client.query(
          'SELECT metadata_value FROM public.novel_agent_metadata WHERE metadata_key = $1',
          ['schema_version'],
        );
        if (result.rows.length) {
          const version = result.rows[0].metadata_value;
          if (!/^[12]$/.test(String(version)))
            throw new PostgresStorageError(
              'UNSUPPORTED_SCHEMA_VERSION',
              'The existing storage schema version is unsupported.',
            );
        }
      }
      if (exists.rows[0]?.ledger) {
        const result = await client.query(
          'SELECT MAX(version) AS version FROM public.novel_agent_schema_migrations',
        );
        if (Number(result.rows[0]?.version ?? 0) > schemaVersion)
          throw new PostgresStorageError(
            'UNSUPPORTED_SCHEMA_VERSION',
            'The existing storage schema version is newer than this application.',
          );
      }
      await client.query(v1);
      await client.query(v2);
    });
  }
  private async lockOwner(client: PoolClient, ownerId: string): Promise<void> {
    await client.query(
      'INSERT INTO public.novel_agent_users (user_id, display_name) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING',
      [ownerId, ownerId],
    );
    await client.query(
      'INSERT INTO public.novel_agent_owner_state (owner_id) VALUES ($1) ON CONFLICT (owner_id) DO NOTHING',
      [ownerId],
    );
    await client.query('SELECT revision FROM public.novel_agent_owner_state WHERE owner_id = $1 FOR UPDATE', [
      ownerId,
    ]);
  }
  private async bumpOwner(client: PoolClient, ownerId: string): Promise<void> {
    const result = await client.query(
      'UPDATE public.novel_agent_owner_state SET revision = revision + 1 WHERE owner_id = $1 RETURNING revision',
      [ownerId],
    );
    revision(result.rows[0].revision);
  }
  async readDocument(ownerId: string, key: string): Promise<StoredDocument | null> {
    text(ownerId, 64);
    text(key, 255);
    return this.transaction(async (client) => {
      const result = await client.query(
        'SELECT revision, content FROM public.novel_agent_documents WHERE owner_id = $1 AND document_key = $2',
        [ownerId, key],
      );
      return result.rows.length
        ? { revision: revision(result.rows[0].revision), content: result.rows[0].content as string }
        : null;
    });
  }
  async readOwnerRevision(ownerId: string): Promise<number> {
    text(ownerId, 64);
    return this.transaction(async (client) => {
      const result = await client.query(
        'SELECT revision FROM public.novel_agent_owner_state WHERE owner_id = $1',
        [ownerId],
      );
      return result.rows.length ? revision(result.rows[0].revision) : 0;
    });
  }
  async writeDocument(
    ownerId: string,
    key: string,
    value: string,
    expectedRevision: number,
  ): Promise<number> {
    text(ownerId, 64);
    text(key, 255);
    content(value);
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision >= Number.MAX_SAFE_INTEGER
    )
      throw invalid();
    return this.transaction(async (client) => {
      await this.lockOwner(client, ownerId);
      const result =
        expectedRevision === 0
          ? await client.query(
              'INSERT INTO public.novel_agent_documents (owner_id, document_key, content, revision) VALUES ($1, $2, $3, 1) ON CONFLICT (owner_id, document_key) DO NOTHING RETURNING revision',
              [ownerId, key, value],
            )
          : await client.query(
              'UPDATE public.novel_agent_documents SET content = $3, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE owner_id = $1 AND document_key = $2 AND revision = $4 RETURNING revision',
              [ownerId, key, value, expectedRevision],
            );
      if (!result.rows.length)
        throw new PostgresStorageError('REVISION_CONFLICT', 'Document revision conflict.');
      const next = revision(result.rows[0].revision);
      await this.bumpOwner(client, ownerId);
      return next;
    });
  }
  async importDocuments(
    ownerId: string,
    sourceHash: string,
    documents: ImportDocument[],
  ): Promise<ImportDocumentsResult> {
    text(ownerId, 64);
    text(sourceHash, 128);
    if (!Array.isArray(documents) || !documents.length || documents.length > 100000) throw invalid();
    const keys = new Set<string>();
    // Snapshot caller-owned data before the first await.
    const snapshot = documents.map((document) => {
      if (!document || typeof document !== 'object') throw invalid();
      text(document.key, 255);
      content(document.content);
      if (keys.has(document.key)) throw invalid();
      keys.add(document.key);
      return { key: document.key, content: document.content };
    });
    return this.transaction(async (client) => {
      await this.lockOwner(client, ownerId);
      const previous = await client.query(
        'SELECT document_count FROM public.novel_agent_document_imports WHERE owner_id = $1 AND source_hash = $2',
        [ownerId, sourceHash],
      );
      if (previous.rows.length) return { imported: false, count: Number(previous.rows[0].document_count) };
      const existing = await client.query(
        'SELECT 1 FROM public.novel_agent_documents WHERE owner_id = $1 LIMIT 1',
        [ownerId],
      );
      if (existing.rows.length)
        throw new PostgresStorageError(
          'IMPORT_TARGET_NOT_EMPTY',
          'Import requires an empty owner document store.',
        );
      for (const document of snapshot) {
        await client.query(
          'INSERT INTO public.novel_agent_documents (owner_id, document_key, content, revision) VALUES ($1, $2, $3, 1)',
          [ownerId, document.key, document.content],
        );
      }
      await client.query(
        'INSERT INTO public.novel_agent_document_imports (owner_id, source_hash, document_count) VALUES ($1, $2, $3)',
        [ownerId, sourceHash, snapshot.length],
      );
      await this.bumpOwner(client, ownerId);
      return { imported: true, count: snapshot.length };
    });
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}
