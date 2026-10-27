import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** SQL files are shipped beside the storage module in both source and compiled deployments. */
export function sqlResourceDirectory(root?: string): string {
  if (!root) return fileURLToPath(new URL('./sql/', import.meta.url));
  const source = path.join(root, 'packages/server/src/infrastructure/storage/sql');
  const compiled = path.join(root, 'build/packages/server/src/infrastructure/storage/sql');
  const candidates = import.meta.url.endsWith('.ts') ? [source, compiled] : [compiled, source];
  return candidates.find((directory) => fs.existsSync(directory)) ?? candidates[0];
}
