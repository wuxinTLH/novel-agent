import { Pool } from 'pg';
const pool = new Pool({ connectionTimeoutMillis: 10000, statement_timeout: 10000 });
try {
  const result = await pool.query(
    "SELECT to_regclass('public.novel_agent_metadata')::text AS metadata, to_regclass('public.novel_agent_documents')::text AS documents",
  );
  console.log(JSON.stringify(result.rows));
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN';
  console.error('READ_ONLY_CHECK_FAILED', /^[A-Z0-9_]{2,64}$/.test(code) ? code : 'UNKNOWN');
  process.exitCode = 1;
} finally {
  await pool.end();
}
