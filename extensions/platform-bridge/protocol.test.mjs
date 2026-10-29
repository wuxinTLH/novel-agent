import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateMessage, isAuthorTab, isPopupSender } from './protocol.js';
test('only exact popup messages are accepted, with bounded challenge and explicit approval', () => {
  validateMessage({ action: 'claim', challenge: 'a'.repeat(64), approved: true });
  for (const message of [null, [], { action: 'publish' }, { action: 'status', token: 'secret' }, { action: 'claim', challenge: 'a'.repeat(65), approved: true }, { action: 'claim', challenge: 'a'.repeat(64), approved: false }]) assert.throws(() => validateMessage(message));
  for (const action of ['finish', 'status', 'disconnect']) validateMessage({ action });
});
test('page/content script/foreign extension senders and non-author tabs are refused', () => {
  const id = 'a'.repeat(32), url = `chrome-extension://${id}/popup.html`;
  assert.equal(isPopupSender({ id, url }, id), true);
  for (const sender of [{ id, url, tab: { id: 1 } }, { id: 'b'.repeat(32), url }, { id, url: 'https://fanqienovel.com/main' }, { id, url: url + '?action=publish' }]) assert.equal(isPopupSender(sender, id), false);
  assert.equal(isAuthorTab({ id: 12, url: 'https://fanqienovel.com/main/writer' }), true);
  for (const url of ['http://fanqienovel.com/main', 'https://fanqienovel.com.evil.test/main', 'https://fanqienovel.com/other', 'https://user:pass@fanqienovel.com/main']) assert.equal(isAuthorTab({ id: 12, url }), false);
  assert.equal(isAuthorTab({ id: -1, url: 'https://fanqienovel.com/main' }), false);
});
test('manifest grants no website script, cookie, broad tab or external messaging access', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['activeTab', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
  assert.equal(manifest.content_scripts, undefined); assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'none'; connect-src http://127.0.0.1:3001");
});
