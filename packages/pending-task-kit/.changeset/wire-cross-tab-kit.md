---
"pending-task-kit": minor
---

**Breaking**: `withTabLock`, `createTtlDedupeCache`, `createPollLeaseClaimer`, `generatePollOwnerId`, and the safe-storage helpers are no longer exported from this package — they've moved to [`cross-tab-kit`](https://github.com/ueaner/cross-tab-kit), which this package now depends on internally for its own cross-tab coordination. None of them had a real dependency on the "task" domain, so they're better served as their own standalone package.

Migration: if you were composing `claimResultOnce` with `withTabLock`/`createTtlDedupeCache` per the README's "Cross-tab duplicate-toast dedupe" section, `pnpm add cross-tab-kit` and import them from there instead — the API is unchanged, only the package they come from.

`clearResultRelay`/`parseResultRelay`/`writeResultRelay` are unaffected — they stay here, since they're genuinely task-domain-coupled (they validate a `PendingTask` shape).
