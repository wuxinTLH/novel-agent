# Workflow scheduling integration

## Shared helpers and UI

`planWorkflowSchedule(nodes, edges, concurrency)` validates IDs, edges, cycles and concurrency 1–32, returning stable ready waves for previews. Preview waves are conservative barriers, not a runtime estimate.

`runWorkflowSchedule(nodes, edges, { concurrency = 1, signal, execute, onState })` is an independently tested generic coordinator. It admits ready nodes under the cap, clones dependency results, drains cooperative tasks on cancellation and blocks failed descendants. Production uses the shared planning and dependency rules with its own persistence coordinator.

`WorkflowSchedulePreview` renders possible topology waves. Its local preview cap does not change saved execution settings. `WorkflowScheduleSettings` persists an atomic `{ maxParallelNodes, edges, steps }` graph patch through the existing graph endpoint. Production accepts concurrency 1–4, default 1.

## Production integration

The generation engine executes eligible ready siblings concurrently using bounded batches and `Promise.allSettled`. Writer and audit nodes retain serial barriers; target chapters and character profile calls remain sequential. Run admission, project locks, graph revision checks, candidate checkpoints, adoption and publication remain under the generation runner.

Conditional sources must return strict JSON with a top-level `branch` string. Only outgoing edges whose `when` matches that explicit value are selected. Labels and natural-language prose never select a branch. An `all` join requires all selected prerequisites; an `any` join can use a successful selected branch after its prerequisites settle. Failed prerequisites cannot be hidden by a merge. Disabled dependencies remain subject to the production graph validator.

Completed outputs are persisted with their run and target context before downstream work. Provider or persistence failure prevents chapter promotion. Cancellation stops new admissions and drains in-flight work; a provider that ignores its abort signal cannot be forcibly terminated by the generic scheduler.

Automatic audit/repair remains outside the DAG, bounded by `maxAutoRepairs` 0–3. Repairs regenerate and recheck the writer without inserting a cycle in the graph.

## Verification scope

Shared scheduler tests cover dependency ordering, branches, joins, concurrency, failure and cancellation. Generation integration tests exercise overlapping ready siblings, writer barriers, explicit branch selection and rejection of partial promotion. Browser smoke verifies that saved scheduling settings survive reload. Real paid provider concurrency and provider-specific quotas still require external acceptance.
