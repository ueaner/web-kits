---
"pending-task-kit": minor
---

`expired` now reaches `onResult` (plus the result relay and DOM event) like every other outcome, instead of being dropped with no signal at all. It arrives with `detail.silent: true` by default — new handler option `silentOnExpiry` (default `true`) controls that, so an `onResult` that already honors `detail.silent` shows no extra toast, while cleanup that depends on a task concluding (clearing a "processing" state, refreshing a list) now runs for expired tasks too. Set `silentOnExpiry: false` to dispatch it with `silent: false`.

**Behavior change:** an `onResult` that ignores `detail.silent` and treats any non-`success` status as a failure will now also see `expired`; check `detail.status`/`detail.silent` if that's not wanted.

With `crossTabPollLeaderElection` on, expiring a task now requires poll leadership (previously it was leaderless local bookkeeping), so only the leader tab expires it and relays the result, rather than every open tab dispatching it; as with `success`/`failure`, a strict once-only guarantee still needs `claimResultOnce`.
