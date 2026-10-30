import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { installHttpFallbacks } from './http.js';
import { readWebHostingOptions } from './web-hosting.js';

test('web hosting configuration is explicit and rejects ambiguous modes', () => {
  assert.equal(readWebHostingOptions({}, process.cwd()).serveWeb, true);
  assert.equal(readWebHostingOptions({ SERVE_WEB: 'false' }, process.cwd()).serveWeb, false);
  assert.throws(() => readWebHostingOptions({ SERVE_WEB: '0' }, process.cwd()), /SERVE_WEB_INVALID/);
  assert.equal(readWebHostingOptions({ WEB_DIST_DIR: 'frontend' }, process.cwd()).webRoot, path.resolve('frontend'));
});

test('API-only mode never serves Web artifacts while bundled mode supports nested routes and immutable assets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-hosting-test-'));
  const webRoot = path.join(root, 'frontend');
  fs.mkdirSync(webRoot);
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>owned-web</title>');
  fs.writeFileSync(path.join(webRoot, 'app-abcdefgh.js'), 'export const owned = true;');
  try {
    for (const serveWeb of [false, true]) {
      const app = express();
      app.get('/api/health', (_req, res) => res.json({ ok: true }));
      installHttpFallbacks(app, root, { serveWeb, webRoot });
      const server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const base = `http://127.0.0.1:${address.port}`;
      try {
        assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { ok: true });
        const unknownApi = await fetch(`${base}/api/missing`);
        assert.equal(unknownApi.status, 404);
        assert.equal((await unknownApi.json()).code, 'NOT_FOUND');
        for (const route of ['/', '/assets/knowledge', '/app-abcdefgh.js']) {
          const response = await fetch(base + route);
          assert.equal(response.status, serveWeb ? 200 : 404);
          if (!serveWeb) assert.ok(!(await response.text()).includes('owned-web'));
          else assert.equal(response.headers.get('cache-control'), route.endsWith('.js') ? 'public, max-age=31536000, immutable' : 'no-cache');
        }
      } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
