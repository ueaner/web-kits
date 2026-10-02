---
"cross-sqlite-client": minor
---

The web adapter can queue for the tab lock instead of failing: `singleTabLock: "wait"` waits for the tab that holds the database to let go, for as long as the `signal` passed to `createDbClient({ signal })` / `adapter.initialize(config, { signal })` allows (`AbortSignal.timeout(5000)`, say; no signal waits indefinitely). A cancelled wait — by that signal or by `close()` — rejects with `DbTabLockError`, the cancellation reason in `cause`; a lock that happens to be granted at the moment of cancellation is released at once instead of being left held. `close()` during a wait no longer waits for the other tab.

**Breaking:**

- `singleTabLock` takes `"fail" | "wait" | "off"` instead of a boolean. `"fail"` (the default) is the old `true`: `DbTabLockError` right away when another tab holds the lock; `"off"` is the old `false`.
- `tryAcquireTabLock(name)` is now `acquireTabLock(name, { wait, signal })`. Without options it behaves as before (`null` when the lock is held); with `wait: true` it queues and, when `signal` aborts, throws `signal.reason`.
