# Tenant runtimes

Tenant application boundaries and isolated runtime workers live here.

The outer authenticated routing boundary allows only exact GET/HEAD `/api/site-appearance` as nonsecret public appearance reads (case-insensitive, optional trailing slash). Other methods/subpaths do not become public. Appearance is owned once by the main control plane in `DATA_DIR/site-appearance.json`, never per-owner SQL data or a tenant Worker write. Admin GET/PUT continues to require `appearance.manage` and existing CSRF/session protections. See [site appearance](../../../../../docs/en/site-appearance.md).

Worker startup validates each tenant-directory ancestor with `lstat` before descending. Independent first tenants may race to create the shared `users/` directory: only `EEXIST` is tolerated, and the winning entry must still be a real directory, never a symlink/junction or file. Child creation stays nonrecursive and all other creation failures fail closed. `tenant-directory.test.ts` deterministically covers the competing-create path and rejected symlink/non-directory winners; startup/worker failures remain poisoned rather than silently restarted.
