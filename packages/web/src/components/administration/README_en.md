# Administration Console

[中文](README.md) | English

`Administration.tsx` accesses management APIs using the existing local administration token or an authenticated session with explicit permissions. It does not change authentication startup mode. Superadmins, administrators and operations administrators see different entries according to the shared permission table; writers do not get the administration center. The dashboard is the default view. Desktop sidebar and narrow-screen horizontal categories share tab/tabpanel associations, with arrow-key and Home/End support.

## Routine operations

- Dashboard: read-only status and shortcuts; loaded tenant count is not described as online user count.
- Users, database, system and security: retain server authorization, confirmations, save state and navigation guards.
- `OnlineMaintenance.tsx`: create an application-wide backup → select a successful backup and verify it → generate an offline restoration plan when permitted. Operations users may back up and verify, but cannot cancel jobs or generate restoration plans. Native details sections organize safety boundaries and CLI commands without removing the shutdown requirement.
- Select successful backups from recent jobs. For older backups, enter a UUID in advanced input. Frontend format checking does not replace server-side managed-directory and integrity checks. Submission timeouts are not retried automatically, and submission cannot be canceled.

## Safety boundaries

Native local authentication defaults off; server requires authentication enabled offline before startup; initial administrator bootstrap still requires the offline CLI. Online backups require acknowledgement of the brief pause across all tenants and the sensitive material included. Arbitrary paths and backup downloads are not exposed. Verification establishes integrity only; generating a plan never restores data. Restoration and migration require shutdown. Server permissions, CSRF, the global quiescence barrier and job management remain unchanged.

## Verification instructions

From the repository root, run `npm run build` and `npm test`. After building, `node scripts/smoke-administration-ui.mjs` exercises navigation, backup, verification, planning and responsive layout using an isolated data directory, not real user data. These are commands for validation; this documentation update does not claim they were run or that production acceptance is complete.
