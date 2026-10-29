# Workflow

Workflow routes and route support live here.

`workflow-support.ts` validates editable workflow settings, including `maxParallelNodes`: an integer from 1 to 8. When omitted, generation uses 1 (serial execution); the engine also clamps the runtime cap to 1–8. Only dependency-ready nodes can run concurrently, so a linear graph remains sequential even at a cap of 8. Writer and audit nodes are singleton barriers: they wait for active peers to settle and do not admit peers while running. On error or cancellation, active tasks are drained before terminal persistence and project-lock release. Graph validation and graph-revision checks still apply; parallelism does not bypass start/end, writer/audit or dependency constraints.

The default chapter template remains planning → writer → audit between system boundaries. Optional author-added nodes are not implicitly inserted into existing workflows. For execution details see `../generation/engine.ts`; these contracts are not a claim of live production acceptance.
