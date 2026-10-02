---
"cross-sqlite-client": minor
---

`createDbClient()` now returns a client that tells you when the database was written to: `client.onWrite(listener)` (returns an unsubscribe function) fires after every `execute()` / `executeBatch()` — on failure too, since `executeBatch` has no transaction and earlier statements may already be applied. Writes started in the same task are merged into one notification, delivered asynchronously after the write's promise settles; `select()` never notifies (route writes, including `INSERT … RETURNING`, through `execute()`); migrations run before the notifications are installed; a throwing listener goes to `logger` and doesn't affect the write or the other listeners; nothing fires after `close()`. The signal is only "something was written", not which table: neither sqlite-wasm's Worker1 API nor Tauri's `plugin-sql` exposes SQLite's `update_hook`, TEMP triggers don't hold on a connection pool, and parsing table names out of SQL misses trigger and cascade writes — and an invalidation signal must never be missed.

`client.groupWrites(fn)` holds the notifications for writes made while `fn` runs and fires once when it settles (nested groups fire when the outermost one ends). Put hand-written transactions (`execute("BEGIN")` … `execute("COMMIT")`) inside it, otherwise a listener may re-query before the commit and read uncommitted data.

**Breaking:** what adapters return from `initialize()` is now `DbConnection` (the old `DbClient` interface, unchanged). `DbClient` is now `DbConnection` plus `onWrite` / `groupWrites`, and only `createDbClient()` produces one. Code that called `adapter.initialize()` directly (tests, typically) gets a `DbConnection`: it still runs SQL, but doesn't notify — use `createDbClient({ name, adapter: createMemoryAdapter(), migrations })` where you need a `DbClient`. Custom adapters return `DbConnection` and keep implementing the same five members. `runMigrations` and `MigrationExecutor` take `Pick<DbConnection, …>` (same members as before).

`adapter.initialize(config, { signal })` and `createDbClient({ signal })` accept an `AbortSignal`. The memory and Tauri adapters only check it before starting.
