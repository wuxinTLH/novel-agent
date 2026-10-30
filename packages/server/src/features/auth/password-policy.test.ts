import test from 'node:test';
import assert from 'node:assert/strict';
import { validPassword } from './password-policy.js';
import { AuthService } from './auth.js';

test('password policy keeps local compatibility and bounds server Unicode credentials', () => {
  assert.equal(validPassword('a'.repeat(12)), true);
  for (const value of [
    'a'.repeat(30),
    'ab'.repeat(20),
    'Password123456789!',
    'qwerty1234567890',
    'writer secret phrase',
  ]) {
    assert.equal(validPassword(value, 'server', 'writer'), false, value);
  }
  assert.equal(validPassword('correct horse battery staple', 'server', 'writer'), true);
  assert.equal(validPassword('😀😃😄😁😆😅😂🤣😊😇🙂🙃😉😍🥰', 'server'), true);
  assert.equal(validPassword('😀😃😄😁😆😅😂🤣', 'server'), false);
  assert.equal(validPassword('word'.repeat(300), 'server'), false);
});
test('server bootstrap checks new credentials before persistence', () => {
  let writes = 0;
  const service = new AuthService({
    dataDir: '.',
    enabled: true,
    securityProfile: 'server',
    secretKey: Buffer.alloc(32),
    persistence: {
      read: () => null,
      write: () => {
        writes++;
      },
    },
  });
  assert.throws(() => service.bootstrapSuperadmin('admin', 'a'.repeat(20)), /AUTH_PASSWORD_INVALID/);
  assert.equal(writes, 0);
  assert.equal(service.bootstrapSuperadmin('admin', 'a unique bootstrap passphrase').role, 'superadmin');
  assert.equal(writes, 1);
});
