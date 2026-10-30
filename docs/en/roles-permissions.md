# Roles and module permissions

[中文原文](../roles-permissions.md) · [English index](README.md)

## Roles and exact weights

| ID | Role | Weight |
| --- | --- | ---: |
| `superadmin` | Super administrator | 1000 |
| `operations` | Operations administrator | 100 |
| `admin` | Administrator | 99 |
| `writer` | Writer | 10 |

Weights are display/sort metadata, **not permission inheritance**. Operations having 100 does not grant administrator powers at 99. New features must declare explicit role permissions, never authorize through a weight comparison or “not writer.”

## Authorization matrix

| Permission | Superadmin | Admin | Operations | Writer |
| --- | :---: | :---: | :---: | :---: |
| `workspace.use` | ✓ | ✓ | ✓ | ✓ |
| `admin.access`, `admin.status.read` | ✓ | ✓ | ✓ | — |
| `users.read`, `users.manage` | ✓ | ✓ | — | — |
| `roles.manage` | ✓ | — | — | — |
| `storage.read` | ✓ | ✓ | ✓ | — |
| `storage.manage`, `sql.initialize` | ✓ | ✓ | — | — |
| `maintenance.read`, `maintenance.backup`, `maintenance.validate` | ✓ | ✓ | ✓ | — |
| `maintenance.restorePlan`, `maintenance.cancel`, `maintenance.commands` | ✓ | ✓ | — | — |
| `security.read` | ✓ | ✓ | — | — |
| `security.manage` | ✓ | — | — | — |

Super administrators can manage known target roles. Administrators can manage writers and operations users, not peers/superadmins, and cannot assign roles. Operations/writers cannot manage users. Unknown actor, target or permission fails closed, never defaults to administrator.

## Compatibility and enforcement

Legacy `user` normalizes to `writer`, without privilege escalation. Native local authentication defaults off; server requires offline-enabled auth (see [deployment modes](deployment-modes.md)). Existing explicit CLI activation remains; role migration neither enables it nor adds an environment switch. Unauthenticated local management keeps its socket/Host/Origin/credential/CSRF checks.

The online-maintenance component's optional `role` supports local/legacy superadmin display only when literally omitted (`undefined`). Authenticated parents must pass the verified actual role; omission is not an authentication fallback and other unknown values reject. Frontend hides unauthorized actions and rechecks submission, but the server authorizes every request independently; hidden buttons are not a security boundary.

## Maintenance boundaries

Operations may inspect status, create full-application backups and validate integrity; they cannot cancel, plan restore or use admin-only commands. Online backup covers **all tenants/control plane/configured business databases**, not a user's export. It includes secrets, needs explicit impact confirmation and temporarily pauses all tenants. Without reliable global quiescence, use stopped-service CLI.

The browser provides no artifact downloads, arbitrary filesystem paths or online restore. Integrity validation does not prove decryptability, business semantics or successful startup. Restore plans only instruct; they do not execute. Actual migration/restore requires a maintenance window, host-authorized offline CLI, external key retention, empty-target/mapping checks and journal review. Web roles/weights grant no OS/database/CLI privileges.

## Regression entry points

```sh
node node_modules/tsx/dist/cli.mjs --test shared/permissions.test.ts
```

Tests cover exact weights/matrix, legacy normalization, unknown rejection and target-role limits. The unified `node scripts/test.mjs` entry must include shared `.test.ts` discovery. These are reproducible local checks, not external security certification.
