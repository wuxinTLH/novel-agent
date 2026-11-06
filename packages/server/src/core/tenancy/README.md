# Tenant runtimes

Tenant application boundaries and isolated runtime workers live here.

Worker startup validates each tenant-directory ancestor with `lstat` before descending. Independent first tenants may race to create the shared `users/` directory: only `EEXIST` is tolerated, and the winning entry must still be a real directory, never a symlink/junction or file. Child creation stays nonrecursive and all other creation failures fail closed. `tenant-directory.test.ts` deterministically covers the competing-create path and rejected symlink/non-directory winners; startup/worker failures remain poisoned rather than silently restarted.
