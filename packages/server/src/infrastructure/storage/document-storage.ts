import fs from 'node:fs';
import path from 'node:path';

/** Synchronous durability boundary: implementations must finish COMMIT before returning. */
export interface DocumentStorage {
  read(key: string): string | null;
  write(key: string, contents: string): void;
}
const stores = new Map<string, DocumentStorage>();
export function bindDocumentStorage(dir: string, storage: DocumentStorage): () => void {
  const resolved = path.resolve(dir);
  if (stores.has(resolved)) throw new Error('DOCUMENT_STORAGE_ALREADY_BOUND');
  stores.set(resolved, storage);
  return () => stores.delete(resolved);
}
export function documentStorage(dir: string) {
  return stores.get(path.resolve(dir));
}
export function readDocumentFile(file: string): string | null {
  const backend = documentStorage(path.dirname(file));
  if (backend) return backend.read(path.basename(file));
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}
export function writeDocumentFile(file: string, contents: string): void {
  const backend = documentStorage(path.dirname(file));
  if (backend) {
    backend.write(path.basename(file), contents);
    return;
  }
  fs.writeFileSync(file + '.tmp', contents, { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
