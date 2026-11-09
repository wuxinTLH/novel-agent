# Workflow

Workflow routes and route support live here.

`workflow-support.ts` validates editable workflow settings, including `maxParallelNodes`: an integer from 1 to 8. When omitted, generation uses 1 (serial execution); the engine also clamps the runtime cap to 1–8. Only dependency-ready nodes can run concurrently, so a linear graph remains sequential even at a cap of 8. Writer and audit nodes are singleton barriers: they wait for active peers to settle and do not admit peers while running. On error or cancellation, active tasks are drained before terminal persistence and project-lock release. Graph validation and graph-revision checks still apply; parallelism does not bypass start/end, writer/audit or dependency constraints.

## Chapter continuity

Chapter model prompts include a separate `<前章衔接锚点>` from the current canonical manuscript's nearest earlier chapter, including its revision and up to 6,000 Unicode code points of its ending. This section is independent of the ordinary recent-three-chapter budget, and never uses unadopted candidates, archived revisions, future chapters or stale writer output as its source. Missing immediate predecessors and empty content are explicitly identified rather than invented. World/character setting-only prompts remain separate.

Planning must compare prior ending state, next opening state and required transitions; writing must show causal transitions in the prose; audit must compare both sides with evidence for time, location, people, consciousness/injury, objects and ability boundaries. Conflicting old planning is not authority to rewrite saved events. These are model constraints, not deterministic semantic proof: stub tests verify prompt propagation and existing failed-audit candidate retention, not actual provider writing quality. No extra model calls are added. Existing manuscript chapters are not automatically rewritten.

The default chapter template remains planning → writer → audit between system boundaries. Optional author-added nodes are not implicitly inserted into existing workflows. For execution details see `../generation/engine.ts`; these contracts are not a claim of live production acceptance.
