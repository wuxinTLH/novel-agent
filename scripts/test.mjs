import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function collect(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(directory, entry.name);
    return entry.isDirectory() ? collect(relative) : entry.name.endsWith('.test.ts') ? [relative] : [];
  });
}
const testFiles = ['shared', 'packages/server/src', 'packages/web/src'].flatMap(collect);
const concurrency = process.env.TEST_CONCURRENCY ?? '2';
if (!/^[1-8]$/.test(concurrency)) throw new Error('TEST_CONCURRENCY must be an integer from 1 to 8');
const result = spawnSync(
  process.execPath,
  [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '--test', `--test-concurrency=${concurrency}`, ...testFiles],
  {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
