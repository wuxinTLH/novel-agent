import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSupportedNodeVersion, isSupportedNodeVersion, supportedNodeRange } from './node-runtime.js';
import { readFileSync } from 'node:fs';

test('Node runtime rejects vulnerable patches, unsupported majors and prereleases', () => {
  for (const version of ['22.16.0', '22.23.3', '24.11.1', '24.22.0', '24.22.1', '20.20.2', '23.99.0', '25.0.0', '26.12.1', '24.22.2-rc.1', '24.22', '24.022.2', '24.22.2junk', '24.22.2\n']) {
    assert.equal(isSupportedNodeVersion(version), false, version);
    assert.throws(() => assertSupportedNodeVersion(version), /NODE_RUNTIME_UNSUPPORTED/);
  }
});

test('Node runtime accepts reviewed baselines and later stable patches within supported majors', () => {
  for (const version of ['22.23.4', 'v22.23.4', '22.23.5', '22.24.0', '24.22.2', '24.22.3', '24.23.0']) {
    assert.equal(isSupportedNodeVersion(version), true, version);
    assert.doesNotThrow(() => assertSupportedNodeVersion(version));
  }
});

test('package engine and lockfile security baselines match runtime policy', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(pkg.engines.node, supportedNodeRange);
  assert.equal(lock.packages[''].engines.node, supportedNodeRange);
});
