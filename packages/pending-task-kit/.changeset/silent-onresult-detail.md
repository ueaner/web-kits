---
"pending-task-kit": minor
---

`silentOnSuccess`/`silentOnFailure` no longer suppress `onResult` (or the DOM event/cross-tab
relay) entirely — they now only set `detail.silent` on the dispatched
`PendingTaskResultEventDetail`, which `onResult` can check itself. The engine has no notion of
what a "notification" is (per this package's own "notification channel deliberately not part
of this package"), so having it withhold `onResult` on your behalf assumed `onResult` only ever
means "show a toast" — not true for callers that also use it to switch a view or invalidate a
cache on an outcome they don't want to toast for.

Migration: a caller that relied on the old "silent = `onResult` never runs" behavior should add
`if (detail.silent) return` (or equivalent) as the first line of its own `onResult`.

`expired` is unaffected — it still never reaches `onResult` at all, regardless of any flag.
