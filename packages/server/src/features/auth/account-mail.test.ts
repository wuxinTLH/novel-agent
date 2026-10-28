import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountEmailTransport, type SmtpFactory } from './account-mail.js';
const env = {
  NOVEL_SMTP_ENABLED: 'true',
  NOVEL_SMTP_HOST: 'smtp.example.com',
  NOVEL_SMTP_USER: 'mailer',
  NOVEL_SMTP_PASSWORD: 'test-owner-secret',
  NOVEL_SMTP_FROM: 'accounts@example.com',
};
test('SMTP is opt-in, validates config, enforces TLS and bounded timeouts, delivers without attachments', async () => {
  let calls = 0;
  const factory: SmtpFactory = (options) => {
    calls++;
    assert.equal(options.port, 587);
    assert.equal(options.requireTLS, true);
    assert.equal(options.tls.rejectUnauthorized, true);
    assert.equal(options.socketTimeout, 15000);
    return {
      async sendMail(message) {
        assert.equal(message.from, env.NOVEL_SMTP_FROM);
        assert.equal(message.disableFileAccess, true);
        assert.equal(message.disableUrlAccess, true);
        assert.ok(message.text.includes('#token=test'));
      },
    };
  };
  assert.equal(createAccountEmailTransport({}, factory), undefined);
  assert.equal(calls, 0);
  assert.throws(
    () => createAccountEmailTransport({ ...env, NOVEL_SMTP_PASSWORD: '' }, factory),
    /ACCOUNT_SMTP_CONFIG_INVALID/,
  );
  const send = createAccountEmailTransport(env, factory)!;
  await send({
    to: 'user@example.com',
    purpose: 'reset',
    token: 'test',
    url: 'https://app.example/account/complete#token=test',
  });
  await assert.rejects(
    send({
      to: 'user@example.com\r\nBcc: attacker@example.com',
      purpose: 'reset',
      token: 'test',
      url: 'https://app.example',
    }),
    /ACCOUNT_MAIL_ADDRESS_INVALID/,
  );
});
test('SMTP failure rejects delivery instead of silently succeeding', async () => {
  const send = createAccountEmailTransport(env, () => ({
    async sendMail() {
      throw new Error('test unavailable');
    },
  }))!;
  await assert.rejects(
    send({ to: 'user@example.com', purpose: 'email', token: 'test', url: 'https://app.example' }),
    /test unavailable/,
  );
});
