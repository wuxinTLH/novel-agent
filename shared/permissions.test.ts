import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ROLE_IDS,
  ROLES,
  PERMISSION_MODULES,
  canManageUser,
  hasPermission,
  normalizeRole,
  type Permission,
  type RoleId,
} from './permissions.js';

const expectedGrants: Record<Permission, readonly RoleId[]> = {
  'workspace.use': ['superadmin', 'admin', 'operations', 'writer'],
  'admin.access': ['superadmin', 'admin', 'operations'],
  'admin.status.read': ['superadmin', 'admin', 'operations'],
  'users.read': ['superadmin', 'admin'],
  'users.manage': ['superadmin', 'admin'],
  'roles.manage': ['superadmin'],
  'storage.read': ['superadmin', 'admin', 'operations'],
  'storage.manage': ['superadmin', 'admin'],
  'sql.initialize': ['superadmin', 'admin'],
  'maintenance.read': ['superadmin', 'admin', 'operations'],
  'maintenance.backup': ['superadmin', 'admin', 'operations'],
  'maintenance.validate': ['superadmin', 'admin', 'operations'],
  'maintenance.restorePlan': ['superadmin', 'admin'],
  'maintenance.cancel': ['superadmin', 'admin'],
  'maintenance.commands': ['superadmin', 'admin'],
  'security.read': ['superadmin', 'admin'],
  'security.manage': ['superadmin'],
};

test('four roles have exact weights; ordering does not grant authority', () => {
  assert.deepEqual(ROLE_IDS, ['superadmin', 'admin', 'operations', 'writer']);
  assert.deepEqual(Object.fromEntries(ROLE_IDS.map((role) => [role, ROLES[role].weight])), {
    superadmin: 1000,
    admin: 99,
    operations: 100,
    writer: 10,
  });
  assert.ok(ROLES.operations.weight > ROLES.admin.weight);
  assert.equal(hasPermission('operations', 'users.manage'), false);
  assert.equal(hasPermission('operations', 'maintenance.restorePlan'), false);
  assert.equal(hasPermission('operations', 'maintenance.cancel'), false);
});

test('every declared permission matches the complete explicit role matrix', () => {
  const declared = Object.values(PERMISSION_MODULES).flatMap((module) => Object.keys(module));
  assert.deepEqual(declared.sort(), Object.keys(expectedGrants).sort());
  for (const [permission, allowed] of Object.entries(expectedGrants)) {
    for (const role of ROLE_IDS) {
      assert.equal(
        hasPermission(role, permission as Permission),
        allowed.includes(role),
        `${role}: ${permission}`,
      );
    }
  }
});

test('unknown roles and permissions fail closed, including object prototype names', () => {
  for (const role of [undefined, null, '', 'root', 'Admin', 'toString', {}, 1000]) {
    assert.equal(normalizeRole(role), null);
    for (const permission of Object.keys(expectedGrants)) {
      assert.equal(hasPermission(role, permission as Permission), false);
    }
  }
  for (const role of ROLE_IDS) {
    for (const permission of ['unknown', '', 'constructor', 'toString', '__proto__']) {
      assert.equal(hasPermission(role, permission as Permission), false);
    }
  }
});

test('legacy user normalizes to writer and receives exactly writer grants', () => {
  assert.equal(normalizeRole('user'), 'writer');
  for (const role of ROLE_IDS) assert.equal(normalizeRole(role), role);
  for (const permission of Object.keys(expectedGrants)) {
    assert.equal(
      hasPermission('user', permission as Permission),
      hasPermission('writer', permission as Permission),
    );
  }
});

test('user management uses explicit actor/target roles rather than weight', () => {
  const targets = [...ROLE_IDS, 'user'];
  for (const actor of [...ROLE_IDS, 'user']) {
    for (const target of targets) {
      const expected =
        actor === 'superadmin' || (actor === 'admin' && ['operations', 'writer', 'user'].includes(target));
      assert.equal(canManageUser(actor, target), expected, `${actor} -> ${target}`);
    }
  }
  for (const unknown of [undefined, null, '', 'root', {}, 1000]) {
    for (const role of ROLE_IDS) {
      assert.equal(canManageUser(unknown, role), false);
      assert.equal(canManageUser(role, unknown), false);
    }
  }
});
