/** Shared declarative authorization. Weight is ordering metadata, never an implicit grant. */
export const ROLE_IDS = ['superadmin', 'admin', 'operations', 'writer'] as const;
export type RoleId = (typeof ROLE_IDS)[number];
export const ROLES: Record<RoleId, { label: string; weight: number }> = {
  superadmin: { label: '超级管理员', weight: 1000 },
  admin: { label: '管理员', weight: 99 },
  operations: { label: '运维管理员', weight: 100 },
  writer: { label: '作家', weight: 10 },
};
const managers: readonly RoleId[] = ['superadmin', 'admin'];
const operators: readonly RoleId[] = ['superadmin', 'admin', 'operations'];
export const PERMISSION_MODULES = {
  workspace: { 'workspace.use': ROLE_IDS },
  administration: { 'admin.access': operators, 'admin.status.read': operators },
  users: { 'users.read': managers, 'users.manage': managers, 'roles.manage': ['superadmin'] },
  storage: { 'storage.read': operators, 'storage.manage': managers, 'sql.initialize': managers },
  maintenance: {
    'maintenance.read': operators,
    'maintenance.backup': operators,
    'maintenance.validate': operators,
    'maintenance.restorePlan': managers,
    'maintenance.cancel': managers,
    'maintenance.commands': managers,
  },
  security: { 'security.read': managers, 'security.manage': ['superadmin'] },
} as const satisfies Record<string, Record<string, readonly RoleId[]>>;
type Values<T> = T[keyof T];
export type Permission = Values<{
  [K in keyof typeof PERMISSION_MODULES]: keyof (typeof PERMISSION_MODULES)[K];
}>;
export function normalizeRole(value: unknown): RoleId | null {
  if (value === 'user') return 'writer';
  return typeof value === 'string' && (ROLE_IDS as readonly string[]).includes(value)
    ? (value as RoleId)
    : null;
}
export function hasPermission(role: unknown, permission: Permission): boolean {
  const canonical = normalizeRole(role);
  if (!canonical) return false;
  for (const entries of Object.values(PERMISSION_MODULES)) {
    const allowed = (entries as Record<string, readonly RoleId[]>)[permission];
    if (Object.hasOwn(entries, permission) && Array.isArray(allowed)) return allowed.includes(canonical);
  }
  return false;
}
/** Administrators cannot act on peers, superadmins or role assignment, regardless of numeric weight. */
export function canManageUser(actor: unknown, target: unknown): boolean {
  const source = normalizeRole(actor),
    destination = normalizeRole(target);
  return (
    !!destination &&
    (source === 'superadmin' ||
      (source === 'admin' && (destination === 'writer' || destination === 'operations')))
  );
}
