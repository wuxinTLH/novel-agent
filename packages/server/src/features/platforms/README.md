# Platforms

Platform feature route registration lives here.

## Single-instance external-account safety

The main-thread `mainPlatformAccountLockCoordinator()` owns non-expiring leases across tenant workers. Before constructing each Worker, obtain `credentials()` and pass them in private workerData; immediately call `bindWorker(worker, credentials)`. In the worker, install `createWorkerPlatformAccountLockClient(parentPort, credentials)` via `installPlatformAccountLockClient()` **before** creating the service context/runtime. Workers without this capability fail closed. Existing non-isolated main-thread runtimes use the same process singleton. There is no distributed or multi-instance exclusion guarantee.

Keys use server-verified provider/account identity, not tenant/project/connection IDs or request-supplied owners. IPC carries keyed opaque account hashes; conflict/unavailable errors do not reveal other tenants or accounts. A worker cannot release another worker's lease. No timer revokes a lease; automatic cleanup occurs on actual Worker exit, not an error event, close request, cancellation, or port closure. Loss of control-plane communication fails closed and may retain ownership until worker exit.

Read navigation, account checks, publication preview validation, full publication batches and reconciliation, draft creation/deletion, and connection teardown execute under these leases. Unknown/new manual login takes provider-wide exclusion until the login browser is actually closed, including timeout, cancellation, verification failure and shutdown. Login completion reuses this lease rather than recursively acquiring an account lock. Stopping a queue allows its in-flight item to settle before releasing; parallel planning reads likewise settle before any failure escapes. The runtime's generic mutation wrapper conservatively excludes Tomato when identity is not known; other currently available token/work adapters are local Mock only. A future real provider must pass its verified account scope (or its own provider-wide unknown-identity scope), never reuse Mock assumptions.

Only trusted server code may use the lock client/install functions; they are not HTTP APIs. This protects concurrent execution, not durable cross-tenant idempotency or externally initiated website edits. A process crash or externally surviving browser cannot prove remote outcome; existing unknown-outcome/manual reconciliation semantics remain required.
