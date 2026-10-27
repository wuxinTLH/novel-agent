import type { SQLConnectConfig } from '../../../../../shared/sqlconnect.js';

export interface SQLConnectConnection {
  execute(sql: string): Promise<void>;
  close(): Promise<void>;
}
export interface SQLConnectDriver {
  connect(config: SQLConnectConfig, signal: AbortSignal): Promise<SQLConnectConnection>;
}
export type SQLConnectDriverMap = Record<SQLConnectConfig['driver'], SQLConnectDriver>;

/** All adapters select an existing database. None may create databases or disable certificate checks implicitly. */
export const realSQLConnectDrivers: SQLConnectDriverMap = {
  mysql: {
    async connect(config, signal) {
      const mysql = await import('mysql2/promise');
      const pending = mysql.createConnection({
        host: config.host, port: config.port, user: config.user, password: config.password,
        database: config.database, connectTimeout: config.timeoutMs,
        ssl: config.tls === 'verify' ? { rejectUnauthorized: true } : undefined,
        multipleStatements: false,
      });
      const connection = await pending;
      const abort = () => connection.destroy();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { connection.destroy(); throw new Error('Aborted'); }
      return {
        async execute(sql) { await connection.query({ sql, timeout: config.timeoutMs }); },
        async close() { signal.removeEventListener('abort', abort); connection.destroy(); },
      };
    },
  },
  postgresql: {
    async connect(config, signal) {
      const { Client } = await import('pg');
      const client = new Client({
        host: config.host, port: config.port, user: config.user, password: config.password,
        database: config.database, connectionTimeoutMillis: config.timeoutMs,
        query_timeout: config.timeoutMs, statement_timeout: config.timeoutMs,
        ssl: config.tls === 'verify' ? { rejectUnauthorized: true } : false,
      });
      const abort = () => { void client.end().catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (signal.aborted) throw new Error('Aborted');
        await client.connect();
        if (signal.aborted) throw new Error('Aborted');
      } catch {
        signal.removeEventListener('abort', abort);
        await client.end().catch(() => {});
        throw new Error('Connection failed');
      }
      return {
        async execute(sql) { await client.query(sql); },
        async close() { signal.removeEventListener('abort', abort); await client.end(); },
      };
    },
  },
  sqlserver: {
    async connect(config, signal) {
      const { default: mssql } = await import('mssql');
      const pool = new mssql.ConnectionPool({
        server: config.host.replace(/^\[|\]$/g, ''), port: config.port, user: config.user,
        password: config.password, database: config.database,
        connectionTimeout: config.timeoutMs, requestTimeout: config.timeoutMs,
        pool: { max: 1, min: 0 },
        options: { encrypt: config.tls === 'verify', trustServerCertificate: false, enableArithAbort: true },
      });
      const abort = () => { void pool.close().catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (signal.aborted) throw new Error('Aborted');
        await pool.connect();
        if (signal.aborted) throw new Error('Aborted');
      } catch {
        signal.removeEventListener('abort', abort);
        await pool.close().catch(() => {});
        throw new Error('Connection failed');
      }
      return {
        async execute(sql) {
          const request = pool.request();
          const cancel = () => request.cancel();
          signal.addEventListener('abort', cancel, { once: true });
          try { if (signal.aborted) throw new Error('Aborted'); await request.batch(sql); }
          finally { signal.removeEventListener('abort', cancel); }
        },
        async close() { signal.removeEventListener('abort', abort); await pool.close(); },
      };
    },
  },
};
