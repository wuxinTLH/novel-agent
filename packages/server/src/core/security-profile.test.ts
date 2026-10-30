import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readSecurityProfile, assertHardenedStartup, configureHttpServer } from './security-profile.js';

test('hardened startup fails closed without identity TLS and independent keys', () => {
  assert.deepEqual(readSecurityProfile({}), { hardened: false, audit: false });
  assert.deepEqual(readSecurityProfile({ SECURITY_PROFILE: 'hardened', SECURITY_AUDIT: 'false' }), { hardened: true, audit: true });
  assert.throws(() => readSecurityProfile({ SECURITY_PROFILE: 'typo' }), /SECURITY_PROFILE_INVALID/);
  const valid = { hardened: true, authEnabled: true, trustedOrigin: 'https://novel.example', gatewayEnabled: false, modelKey: 'm'.repeat(32), platformKey: 'p'.repeat(32) };
  assert.doesNotThrow(() => assertHardenedStartup(valid));
  assert.throws(() => assertHardenedStartup({ ...valid, authEnabled: false }), /HARDENED_AUTH_REQUIRED/);
  assert.throws(() => assertHardenedStartup({ ...valid, trustedOrigin: undefined }), /HARDENED_HTTPS_ORIGIN_REQUIRED/);
  assert.throws(() => assertHardenedStartup({ ...valid, gatewayEnabled: true }), /HARDENED_GATEWAY_FORBIDDEN/);
  assert.throws(() => assertHardenedStartup({ ...valid, platformKey: valid.modelKey }), /HARDENED_DISTINCT_SECRET_KEYS_REQUIRED/);
});
test('HTTP parsing and keepalive limits do not install a short SSE response timeout', () => {
  const server = http.createServer();
  configureHttpServer(server);
  assert.equal(server.headersTimeout, 15000);
  assert.equal(server.requestTimeout, 120000);
  assert.equal(server.keepAliveTimeout, 5000);
  assert.equal(server.maxHeadersCount, 100);
  assert.equal(server.maxRequestsPerSocket, 1000);
  assert.equal(server.timeout, 0);
});
