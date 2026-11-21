import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isSupportedNodeVersion } from './node-runtime.js';

const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const compose = readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8');

test('Docker build and runtime use the same supported Node 24 security baseline', () => {
  const stages = [...dockerfile.matchAll(/^FROM node:(\d+\.\d+\.\d+)-bookworm-slim AS (build|runtime)$/gm)];
  assert.deepEqual(stages.map(match => match[2]), ['build', 'runtime']);
  assert.equal(stages[0][1], '24.22.2');
  assert.equal(stages[1][1], stages[0][1]);
  assert.equal(isSupportedNodeVersion(stages[0][1]), true);
});

test('Docker retains production dependencies, compiled workers, SQL and web assets', () => {
  for (const instruction of [
    'COPY scripts ./scripts',
    'COPY public ./public',
    'RUN npm ci --ignore-scripts && npm rebuild sharp',
    'RUN npm run build && npm prune --omit=dev --ignore-scripts',
    'COPY --from=build /app/package.json /app/package-lock.json ./',
    'COPY --from=build /app/node_modules ./node_modules',
    'COPY --from=build /app/build ./build',
    'COPY --from=build /app/dist ./dist',
    'CMD ["node", "build/packages/server/src/supervisor.js"]',
  ]) assert.ok(dockerfile.includes(instruction), instruction);
});

test('Docker deployment preserves non-root, writable data and fail-closed mode boundaries', () => {
  assert.match(dockerfile, /^ARG CoreModel=server$/m);
  assert.ok(dockerfile.includes('case "$CoreModel" in local|server) ;; *)'));
  assert.ok(dockerfile.includes('CoreModel must be local or server'));
  assert.match(dockerfile, /^ENV CoreModel=\$\{CoreModel\} NODE_ENV=production PORT=3001 DATA_DIR=\/app\/data$/m);
  assert.ok(dockerfile.includes('chown node:node /app/data /app/.data-managed-backups'));
  assert.match(dockerfile, /^USER node$/m);
  assert.match(compose, /^    restart: "no"$/m);
  for (const setting of [
    'user: "1000:1000"',
    '"127.0.0.1:3001:3001"',
    'novel-data:/app/data',
    'novel-backups:/app/.data-managed-backups',
    'read_only: true',
    'NOVEL_INIT_TOKEN: ${NOVEL_INIT_TOKEN:-}',
    'cap_drop: [ALL]',
    'no-new-privileges:true',
    '/tmp:rw,noexec,nosuid,nodev,size=128m,uid=1000,gid=1000,mode=1770',
  ]) assert.ok(compose.includes(setting), setting);
});
