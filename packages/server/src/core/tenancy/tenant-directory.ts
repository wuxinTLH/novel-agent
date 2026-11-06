import fs from 'node:fs';
import path from 'node:path';

interface DirectoryOperations {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options: { mode: number }): unknown;
  lstatSync(path: string): Pick<fs.Stats, 'isDirectory' | 'isSymbolicLink'>;
}

/** The root already exists. Validate each ancestor before creating the next child. */
export function ensureTenantDirectory(root: string, dir: string, operations: DirectoryOperations = fs): void {
  const relative = path.relative(path.resolve(root), path.resolve(dir));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('UNSAFE_TENANT_DIRECTORY');
  let cursor = path.resolve(root);
  for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) cursor = path.join(cursor, segment);
    if (!operations.existsSync(cursor)) {
      try {
        operations.mkdirSync(cursor, { mode: 0o700 });
      } catch (error) {
        // Independent first tenants may create their shared users/ ancestor concurrently.
        // EEXIST is not proof of a safe directory: always inspect the winner below.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const stat = operations.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('UNSAFE_TENANT_DIRECTORY');
  }
}
