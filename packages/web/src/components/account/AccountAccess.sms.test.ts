import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// The web package has no DOM test runner; guard the explicit UI/API wiring.
const access = readFileSync(new URL('./AccountAccess.tsx', import.meta.url), 'utf8');
const gate = readFileSync(new URL('../auth/AuthGate.tsx', import.meta.url), 'utf8');

test('server registration requires an E.164 phone and SMS proof before submitting email signup', () => {
  assert.match(access, /features\?\.smsRequired && \(/);
  assert.match(access, /pattern="\\\+\[1-9\]\[0-9\]\{7,14\}"/);
  assert.match(access, /register\/sms\/request'[\s\S]*?\{ username, email, phone, \.\.\.token \}/);
  assert.match(access, /register\/sms\/verify', 'POST', \{ code \}/);
  assert.match(access, /!registrationSmsVerified/);
  assert.match(
    access,
    /username, email, password, \.\.\.\(features\?\.smsRequired \? \{ phone \} : \{\}\), \.\.\.token/,
  );
  assert.match(gate, /purpose === 'register'/);
});

test('password login and OIDC SMS challenge transition to existing MFA or authenticated session', () => {
  assert.match(gate, /'smsRequired' in result && result\.smsRequired/);
  assert.match(gate, /onMfaRequired=\{\(\) =>/);
  assert.match(gate, /oidc === 'sms'/);
  assert.match(access, /account\/sms\/request', 'POST', token/);
  assert.match(access, /account\/sms\/verify', 'POST', \{[\s\S]*?code,[\s\S]*?\}/);
  assert.match(access, /if \(result\.mfaRequired\) onMfaRequired\?\.\(\)/);
  assert.match(access, /account\/mfa\/verify', 'POST', \{ code \}/);
});

test('both SMS sends require fresh Turnstile tokens and API requests retain CSRF transport', () => {
  assert.match(access, /if \(turnstile\?\.enabled && !turnstileToken\) throw/);
  assert.match(access, /setTurnstileToken\(''\);[\s\S]*?setAttempt\(\(v\) => v \+ 1\)/);
  assert.match(access, /pendingSms[\s\S]*?renderChallenge\(attempt, setTurnstileToken\)/);
  assert.match(gate, /renderChallenge=\{\(attempt, token\) =>/);
  assert.match(gate, /const accountRequest =/);
  assert.match(gate, /return api<T>\(path\.slice\(4\)/);
});
