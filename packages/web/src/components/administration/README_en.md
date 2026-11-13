# Administration Console

[中文](README.md) | English

`Administration.tsx` accesses management APIs using the existing local administration token or an authenticated session with explicit permissions. It does not change authentication startup mode. Superadmins, administrators and operations administrators see different entries according to the shared permission table; writers do not get the administration center. The dashboard is the default view. Desktop sidebar and narrow-screen horizontal categories share tab/tabpanel associations, with arrow-key and Home/End support.

The authoring-shell administration entry is below the sidebar guide; mode/account status is below the logo, and language is left of the top-bar theme control. Relocation does not change permissions, authentication enablement or server-side administration boundaries.

## Routine operations

- Dashboard: read-only status and shortcuts; loaded tenant count is not described as online user count.
- Users, database, system and security: retain server authorization, confirmations, save state and navigation guards.
- `OnlineMaintenance.tsx`: create an application-wide backup → select a successful backup and verify it → generate an offline restoration plan when permitted. Operations users may back up and verify, but cannot cancel jobs or generate restoration plans. Native details sections organize safety boundaries and CLI commands without removing the shutdown requirement.
- Select successful backups from recent jobs. For older backups, enter a UUID in advanced input. Frontend format checking does not replace server-side managed-directory and integrity checks. Submission timeouts are not retried automatically, and submission cannot be canceled.

## Site appearance

`SiteAppearancePanel.tsx` requires `appearance.manage` (admin/superadmin); operations/writers cannot use administrative reads or saves. Header/Footer have independent previews and four colors, integer font size 12–24 px and vertical padding 0–32 px. Empty colors inherit the theme; arbitrary CSS/HTML/URLs are rejected. Company name defaults empty, is limited to 120 characters and rendered as text; the fixed © SakuraMikku project link cannot be removed.

Reset changes the draft only; save commits. Load failure never pretends settings were saved; save failure retains edits. A 409 requires reload/manual review, not automatic overwrite. Identity change/expiry aborts the current request and requires reopening. See [site appearance](../../../../../docs/en/site-appearance.md) for APIs, fixed link and global `DATA_DIR/site-appearance.json` backup rules. This is not tenant configuration or browser theme preference.

## Safety boundaries

Native local authentication defaults off; server requires authentication enabled offline before startup; initial administrator bootstrap still requires the offline CLI. Online backups require acknowledgement of the brief pause across all tenants and the sensitive material included. Arbitrary paths and backup downloads are not exposed. Verification establishes integrity only; generating a plan never restores data. Restoration and migration require shutdown. Server permissions, CSRF, the global quiescence barrier and job management remain unchanged.

## Verification instructions

From the repository root, run `npm run build` and `npm test`. After building, `node scripts/smoke-administration-ui.mjs` exercises navigation, backup, verification, planning and responsive layout using an isolated data directory, not real user data. Site appearance also has `node scripts/smoke-site-appearance.mjs`; inspect its isolated directories and side-effect guards before running. These are commands for validation; this documentation update does not claim they were run or that production acceptance is complete.
