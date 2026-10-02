---
"cross-sqlite-client": minor
---

The React binding is rebuilt on React 19's `use`, Suspense and transitions, and gains a query hook.

- `useDbClient()` returns the client. Until it's ready the component suspends (the nearest `<Suspense>` shows its fallback); if initialization fails the error — `DbTabLockError` included — is thrown to the nearest error boundary.
- `useDbQuery(key, run)` returns `run(client)`'s result, suspending until it's in and throwing a failed query to the error boundary. Results are cached per client by `key` (JSON-serializable, and it must include every variable `run` uses), so components that share a key share one query. Every write clears the cache and re-queries inside `startTransition`: the old data stays on screen until the new result is in, and back-to-back writes only ever show the last result. A key change is your own update and suspends; wrap the `setState` that changes the key in `startTransition` to keep the old data meanwhile (paging). A failed query stays cached until the next write — change the key to retry sooner. There is deliberately no expiry, retry or pagination: use TanStack Query, with `client.onWrite` wired to `invalidateQueries`, if you need those.

**Breaking:**

- `useDatabase()` and `DatabaseContextType` are removed; use `useDbClient()` under `<Suspense>` and an error boundary instead of `{ dbClient, isDbReady, isLoading, dbError }`.
- `<DatabaseProvider client>` takes only a `Promise<DbClient>` (`Promise.resolve(client)` for one that's ready). To retry, pass a new promise and change the `key` of the error boundary around it.
- The `react` peer dependency is now `>=19.0.0`.
