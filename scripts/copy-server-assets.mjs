import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// TypeScript emits modules, not SQL. Keep compiled resource lookup independent of cwd.
const root = fileURLToPath(new URL('../', import.meta.url));
const relative = 'packages/server/src/infrastructure/storage/sql';
const source = path.join(root, relative);
const destination = path.join(root, 'build', relative);
fs.mkdirSync(destination, { recursive: true });
const files = fs.readdirSync(source).filter(name => name.endsWith('.sql')).sort();
if (!files.length) throw new Error('SERVER_SQL_RESOURCES_MISSING');
for (const name of files) fs.copyFileSync(path.join(source, name), path.join(destination, name));
console.log(`Copied ${files.length} server SQL resources.`);
