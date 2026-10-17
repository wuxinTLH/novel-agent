import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testFiles = ['server', 'src'].flatMap((directory) =>
  fs
    .readdirSync(path.join(root, directory))
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => path.join(directory, name)),
);
const result = spawnSync(
  process.execPath,
  [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '--test', ...testFiles],
  {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
