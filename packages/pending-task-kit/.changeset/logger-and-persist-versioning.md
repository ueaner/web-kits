---
"pending-task-kit": minor
---

Add a `PendingTaskLogger` diagnostic-warning channel (`{ warn(message) }`, defaulting to
`console`) to `createPendingTaskStore`, `createPollLeaseClaimer`, and `PendingTaskPoller`, so
the package's warnings can be routed into an app's own telemetry/logging. Two new runtime
warnings use it: a task whose `type` matches no registry entry now warns once per type per
poller (previously it sat silently until its TTL expired), and `start()`-ing a second poller
on the same store in the same tab (which can never receive storage/relay events) now warns
instead of failing silently. The store's persisted state is also now versioned
(`version: 1` with a pass-through `migrate`) so future shape changes can migrate old data
instead of zustand discarding it — pre-versioning entries hydrate unchanged.
