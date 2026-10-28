import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canManageUser, hasPermission, ROLE_IDS, ROLES } from '../../../../../shared/permissions';

// Source-contract guards complement server authorization tests without introducing a DOM runner.
const administration = readFileSync(new URL('./Administration.tsx', import.meta.url), 'utf8');
const gate = readFileSync(new URL('../auth/AuthGate.tsx', import.meta.url), 'utf8');

test('console navigation uses explicit admin.access rather than role weight or superadmin equality', () => {
  assert.match(gate, /hasPermission\(user\.role, 'admin\.access'\)/);
  assert.match(gate, /ROLES\[user\.role\]/);
  assert.doesNotMatch(gate, /user\.role === 'superadmin'/);
  assert.deepEqual(
    ROLE_IDS.filter((role) => hasPermission(role, 'admin.access')),
    ['superadmin', 'admin', 'operations'],
  );
});

test('authenticated console fails closed before session authority resolves', () => {
  assert.match(
    administration,
    /useResource<AuthStatus>\(mode === 'authenticated' \? '\/auth\/session' : undefined\)/,
  );
  assert.match(administration, /session\.value\?\.enabled && session\.value\.authenticated/);
  assert.match(administration, /allowed\('admin\.status\.read'\) \? '\/admin\/status' : undefined/);
  assert.match(administration, /status && actor && allowed\('admin\.access'\)/);
});

test('operations cannot mount user, security or CLI resource panels and storage stays read-only', () => {
  for (const permission of ['users.read', 'security.read', 'maintenance.commands', 'storage.manage'] as const)
    assert.equal(hasPermission('operations', permission), false);
  assert.match(administration, /allowed\('users\.read'\) &&/);
  assert.match(administration, /allowed\('security\.read'\) &&/);
  assert.match(administration, /allowed\('maintenance\.commands'\) &&/);
  assert.match(administration, /writable=\{allowed\('storage\.manage'\)\}/);
  assert.match(administration, /const locked = !writable \|\| status\.storage\.active !== false/);
  assert.match(administration, /OnlineMaintenance role=\{mode === 'authenticated' \? actor : undefined\}/);
});

test('admin creation options and target actions follow explicit manage rules, not numeric rank', () => {
  assert.deepEqual(
    ROLE_IDS.filter((role) => canManageUser('admin', role)),
    ['operations', 'writer'],
  );
  assert.equal(hasPermission('admin', 'roles.manage'), false);
  assert.match(
    administration,
    /const creationRoles = ROLE_IDS\.filter\(\(candidate\) => assignRoles \|\| canManageUser\(actor, candidate\)\)/,
  );
  assert.match(
    administration,
    /const manageable = \(user: AuthUser\) => manage && canManageUser\(actor, user\.role\)/,
  );
  assert.match(administration, /if \(!manageable\(user\) \|\| \(patch\.role && !assignRoles\)\) return/);
  assert.match(administration, /\{assignRoles \? \(/);
  assert.match(administration, /useState<AuthRole>\('writer'\)/);
  assert.doesNotMatch(administration, /value="user"/);
});

test('role selectors display all canonical labels with exact non-hierarchical weights', () => {
  assert.deepEqual(
    ROLE_IDS.map((role) => ROLES[role].weight),
    [1000, 99, 100, 10],
  );
  assert.match(administration, /ROLES\[role\]\.label.*ROLES\[role\]\.weight/);
  assert.match(administration, /ROLE_IDS\.map\(\(candidate\)/);
  assert.match(administration, /creationRoles\.map\(\(candidate\)/);
});

test('admin security settings remain read-only and existing dirty-close guards stay intact', () => {
  assert.equal(hasPermission('admin', 'security.read'), true);
  assert.equal(hasPermission('admin', 'security.manage'), false);
  assert.match(administration, /writable && \([\s\S]*?<AccountAdminSettings/);
  assert.match(administration, /if \(!writable\) return/);
  assert.match(administration, /dirty=\{databaseDirty \|\| securityDirty\}/);
});
