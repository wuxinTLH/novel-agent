import fs from 'node:fs';
import { PostgresStorage } from './postgres-storage.js';

// Private IPC: no credentials in argv, process environment or diagnostic output.
let storage: PostgresStorage | undefined;
try {
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  storage = new PostgresStorage(request.config);
  let result: unknown;
  switch (request.operation) {
    case 'migrate':
      await storage.migrate();
      result = { ok: true };
      break;
    case 'read':
      result = await storage.readDocument(request.ownerId, request.key);
      break;
    case 'write':
      result = await storage.writeDocument(request.ownerId, request.key, request.content, request.revision);
      break;
    case 'import':
      result = await storage.importDocuments(request.ownerId, request.sourceHash, request.documents);
      break;
    default:
      throw new Error('UNKNOWN_OPERATION');
  }
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  const code =
    error && typeof error === 'object' && 'code' in error ? String(error.code) : 'POSTGRES_UNAVAILABLE';
  process.stdout.write(
    JSON.stringify({ ok: false, code: /^[A-Z_]{3,64}$/.test(code) ? code : 'POSTGRES_UNAVAILABLE' }),
  );
  process.exitCode = 1;
} finally {
  await storage?.close();
}
