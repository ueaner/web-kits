# cross-sqlite-client

Cross-platform (Web + Tauri) SQLite client for JavaScript/TypeScript apps: one
`DbClient` interface, a versioned migration framework, write notifications,
and Suspense-based React bindings —
with no business schema baked in. You bring your own schema and pick an
adapter; the library handles the platform differences underneath.

## Why

Web (via `@sqlite.org/sqlite-wasm`) and Tauri (via `@tauri-apps/plugin-sql`)
talk to SQLite in very different ways — different APIs, different connection
models, different failure modes. This package hides that behind one small
interface so the rest of your app can call `select()`/`execute()` without
caring which platform it's running on, and ships a migration runner and React
context on top so you don't have to write that plumbing per project.

## Install

```bash
pnpm add cross-sqlite-client
```

`@sqlite.org/sqlite-wasm` and `@tauri-apps/plugin-sql` are `optionalDependencies`
of this package, so installing `cross-sqlite-client` pulls both in automatically
— you don't need to `pnpm add` either one yourself in your app's own
`package.json`. "optional" here means a failed install of one won't block the
rest, not "skipped unless requested." Your app only needs to _use_ the one
matching its target platform; remove the other with `--no-optional` (or your
package manager's equivalent) if you don't want it in `node_modules` at all.
`react` is an optional peer dependency, needed only if you use the `./react`
subpath.

## Quick start

**1. Define your schema as versioned migrations** (see [Writing migrations](#writing-migrations)):

```ts
// appMigrations.ts
import type { Migration } from "cross-sqlite-client"

export const APP_MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [`CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL);`],
  },
]
```

**2. Create a client, picking the adapter for the current platform:**

```ts
// appDb.ts
import { createDbClient } from "cross-sqlite-client"
import { createWebAdapter } from "cross-sqlite-client/adapters/web"
import { createTauriAdapter } from "cross-sqlite-client/adapters/tauri"
import { isTauri } from "@tauri-apps/api/core"
import { APP_MIGRATIONS } from "./appMigrations"

export const clientPromise = createDbClient({
  name: "my-app", // becomes the OPFS/Tauri database filename
  adapter: isTauri() ? createTauriAdapter() : createWebAdapter(),
  migrations: APP_MIGRATIONS,
})
```

**3. Make it available to your React tree** — loading goes to `<Suspense>`,
a failed initialization to an error boundary:

```tsx
import { Suspense } from "react"
import { DatabaseProvider } from "cross-sqlite-client/react"
import { clientPromise } from "./appDb"

function App() {
  return (
    <DatabaseProvider client={clientPromise}>
      <ErrorBoundary fallback={<DbErrorPage />}>
        <Suspense fallback={<Spinner />}>
          <Router />
        </Suspense>
      </ErrorBoundary>
    </DatabaseProvider>
  )
}
```

**4. Query and write in your components.** No manual refresh after a write:
`useDbQuery` hears about it and re-queries, keeping the old data on screen
until the new result is in:

```tsx
import { useDbClient, useDbQuery } from "cross-sqlite-client/react"

function TodoList() {
  const client = useDbClient()
  const todos = useDbQuery(["todos"], (db) => db.select<Todo>("SELECT id, title FROM todos ORDER BY id"))

  const add = (title: string) => client.execute("INSERT INTO todos (title) VALUES (?)", [title])
  // ...
}
```

## API reference

### Core (`cross-sqlite-client`)

| Export                                                          | What it is                                                                                                                                                                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createDbClient(options)`                                       | Resolves the adapter, initializes it, applies `pragmas`, runs pending migrations, returns `Promise<DbClient>` with write notifications installed. If PRAGMA/migration setup fails, the already-opened connection is closed before the error propagates. |
| `runMigrations(db, migrations, options?)`                       | The migration runner `createDbClient` uses internally — call it directly if you're not going through `createDbClient`.                                                                                                                                  |
| `defaultExecutor`                                               | The migration executor used when `migrationOptions.executor` isn't set — runs all of a migration's statements via `executeBatch()`, with no transaction.                                                                                                |
| `DbConnection` / `DbClient` (types)                             | The connection an adapter returns / the client `createDbClient()` returns, which adds `onWrite` and `groupWrites` — see below.                                                                                                                          |
| `DbAdapter` / `DbAdapterConfig` / `DbInitializeOptions` (types) | The interface each `createXAdapter()` factory returns / the `{ name }` config passed to `initialize()` / its second argument, `{ signal }`.                                                                                                             |
| `BatchStatement` / `Logger` (types)                             | `string \| { sql, params? }` for `executeBatch()` / the diagnostics channel (`{ warn, error }`, defaults to `console`).                                                                                                                                 |
| `Migration` / `MigrationExecutor` / `MigrationOptions` (types)  | See [Writing migrations](#writing-migrations).                                                                                                                                                                                                          |
| `DbError` and subclasses                                        | See [Errors](#errors).                                                                                                                                                                                                                                  |

```ts
import { createDbClient, runMigrations, defaultExecutor } from "cross-sqlite-client"
```

Every adapter's `initialize()` returns a `DbConnection`; `createDbClient()`
wraps it with write notifications and returns a `DbClient`:

```ts
interface DbConnection {
  readonly storage: DbStorage
  select<T>(sql: string, params?: unknown[]): Promise<T[]>
  execute(sql: string, params?: unknown[]): Promise<{ lastInsertId?: number; rowsAffected?: number }>
  executeBatch(statements: BatchStatement[]): Promise<void>
  close(): Promise<void>
}

interface DbClient extends DbConnection {
  onWrite(listener: () => void): () => void // returns an unsubscribe function
  groupWrites<T>(fn: () => Promise<T>): Promise<T>
}
```

App code uses `DbClient`. Code that only runs SQL (a repository layer, say)
can type its parameter as `DbConnection` and accept either. See
[Write notifications](#write-notifications) for the details.

`executeBatch()` runs a batch of statements in order with **no cross-statement
transaction guarantee** — when every statement is parameterless, the web and
memory adapters join them into a single SQL string and send it to the
underlying engine in one call (the web adapter saves one Worker round-trip per
statement); if _any_ statement carries bound params, the whole batch falls
back to running one by one. The library deliberately does not
offer a business-facing transaction API: pooled-connection adapters (Tauri)
can't guarantee `BEGIN`/`COMMIT` land on the same physical connection, so
business multi-statement writes should be idempotent instead.

`createDbClient()` also accepts a few optional fields:

```ts
await createDbClient({
  name: "my-app",
  adapter,
  migrations: APP_MIGRATIONS,
  // Applied right after initialize, before migrations. Keys must be identifiers;
  // string values must be enum-like tokens (WAL, NORMAL, ...); booleans become 0/1;
  // numbers are inlined as-is.
  // Note: on pooled-connection adapters (Tauri), connection-level pragmas such as
  // foreign_keys/busy_timeout only apply to one pooled connection and silently won't
  // hold for later queries (createDbClient logs a warning); database-level pragmas
  // like journal_mode/user_version work everywhere.
  pragmas: { foreign_keys: true, journal_mode: "WAL" },
  // Diagnostics channel for library warnings/errors (default: console).
  logger: myLogger, // { warn(message, ...args), error(message, ...args) }
  // Passed to adapter.initialize() to cancel initialization. Only the web adapter's
  // singleTabLock: "wait" uses it so far, while queueing for the tab lock.
  signal: AbortSignal.timeout(5000),
})
```

### Adapters

Each `createXAdapter()` call returns a fresh, independent `DbAdapter` instance
(no shared module-level state), so you can safely create more than one in the
same process — e.g. in tests.

| Subpath                               | Factory                      | Backing driver                                          | `singleConnection` |
| ------------------------------------- | ---------------------------- | ------------------------------------------------------- | ------------------ |
| `cross-sqlite-client/adapters/web`    | `createWebAdapter(options?)` | `@sqlite.org/sqlite-wasm` (Worker)                      | `true`             |
| `cross-sqlite-client/adapters/tauri`  | `createTauriAdapter()`       | `@tauri-apps/plugin-sql`                                | `false`            |
| `cross-sqlite-client/adapters/memory` | `createMemoryAdapter()`      | `@sqlite.org/sqlite-wasm` (Node/main-thread, in-memory) | `true`             |

`singleConnection` says whether every `execute()`/`select()` call on that
adapter is guaranteed to land on the same physical connection — see
[Custom migration executors](#custom-migration-executors-and-singleconnection)
for why that matters.

**`createWebAdapter(options?)`:**

| Option             | Default   | Meaning                                                                                                                                                                                                         |
| ------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeoutMs`        | `15000`   | How long to wait for the SQLite worker to become ready before `initialize()` rejects. Without this, a failed worker-script load would leave `initialize()` pending forever.                                     |
| `fallbackToMemory` | `true`    | Whether to silently use `:memory:` when OPFS isn't available — including when the OPFS probe passes but opening the file fails — instead of throwing. See [COOP/COEP](#coopcoep-required-for-opfs-persistence). |
| `singleTabLock`    | `"fail"`  | What to do when another tab already has the same OPFS file open: `"fail"` rejects right away, `"wait"` queues, `"off"` doesn't coordinate. See [Multi-tab coordination](#multi-tab-coordination).               |
| `logger`           | `console` | Where diagnostics go (OPFS-fallback warnings, worker errors). Pass your own `{ warn, error }` to route them into your logging/telemetry.                                                                        |

**`createTauriAdapter()`** and **`createMemoryAdapter()`** take no options; their
`initialize()` only checks the `signal` before starting.
`createMemoryAdapter()` is meant for tests — see [Testing](#testing).

### React (`cross-sqlite-client/react`)

Requires React 19 (it's built on `use`, Suspense and transitions).

| Export                            | What it is                                                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<DatabaseProvider client={...}>` | Takes a `Promise<DbClient>` (typically `createDbClient()`'s return value; `Promise.resolve(client)` for one that's ready). It does **not** decide which adapter/migrations to use, and does **not** call `client.close()` on unmount. |
| `useDbClient()`                   | Returns the client. Suspends until it's ready (the nearest `<Suspense>` shows its fallback); a failed initialization — `DbTabLockError` included — is thrown to the nearest error boundary. Throws outside a `DatabaseProvider`.      |
| `useDbQuery(key, run)`            | Returns `run(client)`'s result. Suspends until it's in; a failed query is thrown to the error boundary. Re-queries after writes, see below.                                                                                           |

**`useDbQuery`:**

- `key` finds the query in the cache: it must be JSON-serializable and include
  every variable `run` uses. Same key, same query — components using the same
  key share one.
- Results are cached per client. **Every write clears the cache** and
  re-queries inside `startTransition`: the old data stays on screen until the
  new result is in (no fallback), and back-to-back writes only ever show the
  last result.
- A key change is your own update and suspends to the fallback. To keep the
  old data meanwhile (paging), wrap the `setState` that changes the key in
  `startTransition`:

  ```tsx
  function Notes() {
    const [limit, setLimit] = useState(20)
    const notes = useDbQuery(["notes", limit], (db) => db.select<Note>("SELECT * FROM notes ORDER BY id DESC LIMIT ?", [limit]))
    const more = () => startTransition(() => setLimit((n) => n + 20))
    // ...
  }
  ```

- A failed query stays cached until the next write; change the key to retry
  sooner.
- There's deliberately no expiry, retry, pagination or background refetching.
  If you need those, use [TanStack Query](https://tanstack.com/query) and wire
  write notifications to its invalidation:

  ```ts
  const client = await clientPromise
  client.onWrite(() => queryClient.invalidateQueries())
  ```

Why the promises are cached outside the component: when a component suspends
on its very first mount, React throws its state away and renders it from
scratch once the promise settles. A promise kept in state would be created
anew on that retry, suspending forever and querying over and over. So the
cache lives on the client, found again by `key`.

Two things worth knowing about `DatabaseProvider`:

- **No `retry`.** Retrying means passing it a _new_ promise and changing the
  `key` of the error boundary around it (otherwise the boundary stays in its
  error state):

  ```tsx
  function App() {
    const [clientPromise, setClientPromise] = useState(() => createDbClient({ ... }))
    const [attempt, setAttempt] = useState(0)
    const retry = () => {
      setClientPromise(createDbClient({ ... }))
      setAttempt((n) => n + 1)
    }

    return (
      <DatabaseProvider client={clientPromise}>
        <DbErrorBoundary key={attempt} onRetry={retry}>
          <Suspense fallback={<Spinner />}>
            <Router />
          </Suspense>
        </DbErrorBoundary>
      </DatabaseProvider>
    )
  }
  ```

- **No auto-`close()` on unmount.** Whoever creates the client owns closing
  it. If `DatabaseProvider` closed it automatically, a cached/shared client
  (e.g. an app-level singleton) would get closed the moment the provider
  happens to unmount and remount (conditional rendering, a remounting route,
  test setup/teardown). Close the client yourself, in whatever code created
  it, if its lifetime should be tied to something specific.

## Write notifications

The client `createDbClient()` returns tells you after every write:

```ts
const unsubscribe = client.onWrite(() => {
  // something was written: refresh the UI, invalidate a cache, ...
})
```

- It fires after `execute()` and `executeBatch()`, **on failure too**:
  `executeBatch` has no transaction, so earlier statements may already be
  applied when a later one fails.
- `select()` never notifies. Route writes — `INSERT … RETURNING` included —
  through `execute()`.
- Writes started in the same task are merged into one notification, delivered
  asynchronously after the write's promise settles, so it doesn't slow writes
  down.
- A throwing listener goes to `logger`; it doesn't affect the write or the
  other listeners. Nothing fires after `close()`.
- The migrations `createDbClient()` runs don't notify, and neither does a
  `DbConnection` you got from `adapter.initialize()` directly.

**It says "something was written", not which table.** An invalidation signal
may fire too often but must never be missed: one extra notification is one
extra query, a missed one leaves stale data on screen. And every way to report
tables would miss some: neither sqlite-wasm's Worker1 API nor Tauri's
`plugin-sql` exposes SQLite's `update_hook`; TEMP triggers don't hold on a
connection pool; parsing table names out of SQL misses what triggers and
foreign-key cascades write.

**`groupWrites(fn)`** holds the notifications for writes made while `fn` runs
and fires once when it settles (succeeds or throws); groups can nest, and only
the outermost one fires. Hand-written transactions belong in one — otherwise a
listener may re-query before `COMMIT` and read uncommitted data (the web
adapter has a single connection, so the query runs inside the same
transaction):

```ts
await client.groupWrites(async () => {
  await client.execute("BEGIN")
  try {
    for (const todo of todos) await client.execute("INSERT INTO todos (title) VALUES (?)", [todo])
    await client.execute("COMMIT")
  } catch (error) {
    await client.execute("ROLLBACK").catch(() => {})
    throw error
  }
})
```

It groups notifications, not transactions: concurrent `groupWrites` calls all
wait for the last one to end. It's also handy for a run of writes you want to
be notified about only once.

## Writing migrations

```ts
interface Migration {
  version: number
  statements: string[] // plain DDL/DML strings, no bound parameters
}
```

- **Versions must be unique positive integers.** With no migrations applied
  yet, `runMigrations` treats the current version as `0`; a migration with
  `version: 0` would never satisfy `version > currentVersion` and would be
  silently skipped forever. `runMigrations` throws immediately if any version
  is not a positive integer, or if two migrations share a version. (They don't
  have to start at 1 or be consecutive — gaps are fine.)
- **Every statement must be safe to re-run.** There is no cross-platform
  transaction guarantee (see below), so if a migration fails partway, the next
  startup re-runs the _entire_ version from scratch. Stick to
  `CREATE TABLE/INDEX IF NOT EXISTS` for new schema. For a future
  non-idempotent change (e.g. renaming a column), check the current schema
  state first — e.g. `SELECT 1 FROM pragma_table_info('t') WHERE name = '...'`
  — and skip the step if it's already done, rather than relying on rollback.
- **Failures surface as `DbMigrationError`.** The runner wraps whatever the
  executor threw into a `DbMigrationError` carrying the failing `.version`.
  `createDbClient()` additionally closes the already-opened connection before
  re-throwing, so a failed startup leaks no worker, OPFS file handle, or tab
  lock — retrying (e.g. with a fresh client promise) starts clean.
- **Late migrations below the current version are not silently dropped.** If
  the database already applied `[1, 2, 5]` and a new app build ships the
  missing `3`/`4`, those versions are below `MAX(version)` and would normally
  be skipped forever; the runner logs a `logger.warn` naming them instead.
  They are _not_ auto-applied — out-of-order application can break schema
  evolution assumptions — so apply such hotfixes deliberately.

`runMigrations(db, migrations, options?)` (and `createDbClient`'s
`migrationOptions`) accepts:

```ts
interface MigrationOptions {
  tableName?: string // version table name, default "schema_version"; identifiers only
  executor?: MigrationExecutor // see the next section
  logger?: Logger // overrides createDbClient's logger for migration diagnostics
}
```

## Custom migration executors and `singleConnection`

The default executor (`defaultExecutor`) runs each migration's statements via
`executeBatch()`, with no transaction. `adapters/web` also exports a
`transactionalExecutor` that wraps a migration in `BEGIN`/`COMMIT`/`ROLLBACK` —
but that's only safe on an adapter whose `singleConnection` is `true` (a real,
single persistent connection). `@tauri-apps/plugin-sql`'s backend is a
connection pool (`sqlx::Pool<Sqlite>`); separate `execute()` calls aren't
guaranteed to land on the same physical connection, so a `BEGIN` and `COMMIT`
split across calls can be silently torn apart there without any error.
`createDbClient()` throws up front if you pass an executor marked
`requiresSingleConnection: true` to an adapter whose `singleConnection` is
`false`.

`transactionalExecutor` carries that marker via
`Object.assign(fn, { requiresSingleConnection: true })` — not by comparing the
executor to `defaultExecutor` by reference, which would only catch "some
non-default executor was passed," not specifically "this executor needs a
transaction." Write your own executor the same way if it also manages a
transaction. An executor that doesn't touch transactions at all (e.g. one
that just adds logging) doesn't need the marker and won't be rejected, even on
a pooled-connection adapter.

```ts
import { runMigrations } from "cross-sqlite-client"
import { transactionalExecutor } from "cross-sqlite-client/adapters/web"

await runMigrations(client, APP_MIGRATIONS, { executor: transactionalExecutor })
```

## Web adapter details

### COOP/COEP required for OPFS persistence

OPFS persistence (used by `createWebAdapter()`) requires the page to be served
with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without these headers, the adapter doesn't error — it silently falls back to
an in-memory database (`fallbackToMemory: true` by default), so data won't
survive a page reload. Pass `fallbackToMemory: false` if you'd rather fail
loudly than run in-memory unexpectedly, or keep the fallback and check
`client.storage` to tell the user their data won't be kept:

```ts
const client = await createDbClient({ name: "my-app", adapter: createWebAdapter(), migrations })
if (!client.storage.persistent) {
  // "not-cross-origin-isolated" | "opfs-unsupported" | "opfs-unavailable" | "open-failed"
  showBanner(`Your progress won't be saved (${client.storage.reason})`)
}
```

`client.storage` is `{ persistent: true }` on an OPFS file and on Tauri, and
`{ persistent: false, reason }` on the in-memory fallback (and on the memory
adapter, with `reason: "memory-adapter"`). With no open connection (before
`initialize()`, after `close()`, after a failed `initialize()`) it is
`{ persistent: false, reason: "not-initialized" }`.

Note this is a _deployment_ constraint, not a browser-version one: even on a
fully modern browser, you can lose cross-origin isolation by being embedded in
someone else's iframe, being hosted on a platform that won't let you set
custom headers, or a team deliberately not enabling `COEP: require-corp`
because it would block some other third-party script on the same page.
There's currently no middle tier between full OPFS persistence and no
persistence at all (e.g. a `localStorage`-backed fallback) — see
[Known limitations](#known-limitations).

### Multi-tab coordination

sqlite-wasm's `opfs` VFS has its own locking protocol, so two tabs writing to
the same OPFS-backed file won't corrupt data and generally won't hang — the
losing tab just gets a catchable "database is locked" SQL error. But that
error only surfaces the moment some query happens to hit contention, with
nothing telling you _why_ it failed.

So `createWebAdapter()` uses the
[Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)
to claim a named lock for the database file before opening it. When another
tab already holds it, `singleTabLock` decides:

- `"fail"` (the default): `initialize()` rejects right away with
  `DbTabLockError` — catch it to show something like "this app is already open
  in another tab."
- `"wait"`: queue until the other tab lets go (the browser releases a closed
  tab's lock). How long is up to `createDbClient({ signal })` —
  `AbortSignal.timeout(5000)`, say; without one it waits indefinitely. A
  cancelled wait (or `close()` during it) rejects with `DbTabLockError`, the
  reason in `cause`. A lock that happens to be granted at the moment of
  cancellation is released at once, never left held.
- `"off"`: don't coordinate; rely solely on sqlite-wasm's own
  retry/`SQLITE_BUSY` behavior.

`"wait"` isn't the default because, with the other tab left open, the page
would sit on its loading state with no hint why — harder to debug than an
immediate error. This only ever applies to the OPFS-backed path — `:memory:`
is private per tab, so there's nothing to coordinate there.

The lock primitive itself, `acquireTabLock(lockName, { wait?, signal? })`, is
also exported from `cross-sqlite-client/adapters/web`: it returns a
`release()` function once it holds the lock, `null` when it doesn't wait and
the lock is taken, and throws `signal.reason` when a wait is cancelled. Use it
for cross-tab coordination of something other than the database.

## Errors

Every adapter throws one of these (all extend `DbError extends Error`, and all
accept an optional `cause`):

| Class                                         | Thrown when                                                                                                                               |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `DbError`                                     | Generic/usage errors, e.g. calling `select()`/`execute()` before `initialize()` resolves, or after `close()`.                             |
| `DbInitializationError`                       | `adapter.initialize()` failed (worker/OPFS/Tauri-load failure, etc.).                                                                     |
| `DbExecutionError` (has `.sql` and `.params`) | A `select()`/`execute()`/`executeBatch()` call failed.                                                                                    |
| `DbMigrationError` (has `.version`)           | A migration failed; wraps the underlying error as `cause`. Thrown by `runMigrations`/`createDbClient`.                                    |
| `DbCloseError`                                | `client.close()` failed.                                                                                                                  |
| `DbTabLockError`                              | (Web adapter only) Another tab already holds the database (`"fail"`), or the wait for it was cancelled (`"wait"`, the reason in `cause`). |

```ts
import { DbTabLockError } from "cross-sqlite-client"

try {
  await clientPromise
} catch (error) {
  if (error instanceof DbTabLockError) {
    // show "already open in another tab" instead of a generic error
  }
}
```

## Testing

Use `createMemoryAdapter()` in tests instead of mocking `DbClient` — it's a
real SQLite engine (the same one the web adapter uses, via
`@sqlite.org/sqlite-wasm`'s Node/main-thread build), so your SQL runs for
real and behaves the same as it would against the web adapter, just without
persistence:

```ts
import { createDbClient } from "cross-sqlite-client"
import { createMemoryAdapter } from "cross-sqlite-client/adapters/memory"

const client = await createDbClient({ name: "test", adapter: createMemoryAdapter(), migrations: APP_MIGRATIONS })
// exercise client.select() / client.execute() as usual; write notifications work too
```

To test a repository layer that doesn't need write notifications, a
`DbConnection` from `createMemoryAdapter().initialize({ name: "test" })` plus
your own `runMigrations(connection, APP_MIGRATIONS)` works as well.

Each `createMemoryAdapter()` call is a fresh, independent instance, so
separate tests (or parallel tests in the same process) don't share state.

The library's own suite (`pnpm test`) covers the migration runner, the client
lifecycle, and the React bindings; CI (`.github/workflows/ci.yml`) runs lint,
format check (`oxfmt`), typecheck, tests, build, and `publint` on Node 24 (the
minimum supported Node version for development; see `engines` in
`package.json`). Run `pnpm format` before committing to keep the tree
format-clean.

## Known limitations

- **Writes run through `select()` don't notify.** Route writes — `INSERT …
RETURNING` included — through `execute()`; see [Write notifications](#write-notifications).
- **A hand-written transaction outside `groupWrites` can be read uncommitted
  by a listener.** See [Write notifications](#write-notifications).

- **`lastInsertId` precision.** `DbClient.execute()`'s `lastInsertId` is typed
  as `number`. The web adapter converts SQLite's `sqlite3_last_insert_rowid()`
  (a 64-bit `bigint`, up to 2^63-1) down via `Number()`, so a rowid beyond
  `Number.MAX_SAFE_INTEGER` (2^53-1) loses precision. Not an issue for a
  typical local-first app (that's over 9 quadrillion rows in one table), but
  if you need an exact large rowid, read it back with a dedicated
  `SELECT last_insert_rowid()` query instead.
- **No OPFS degradation tier.** When OPFS/cross-origin isolation isn't
  available, `createWebAdapter()` only has two states: full OPFS persistence,
  or `:memory:` with none at all. sqlite-wasm ships a `kvvfs` backend
  (`localStorage`/`sessionStorage`-based, no cross-origin isolation required)
  that could serve as a middle tier, but it wasn't wired in as of this
  writing — pursue it if you need persistence in deployments that can't
  achieve cross-origin isolation (see [COOP/COEP](#coopcoep-required-for-opfs-persistence)).

## Runtime environment notes

Deployment/runtime behaviors that are deliberate tradeoffs rather than bugs:

- **bfcache-frozen tabs hold the database lock.** `singleTabLock` uses the Web
  Locks API; a tab frozen by the browser's back/forward cache (rather than
  closed) keeps holding its lock, so other tabs keep getting `DbTabLockError`
  (or, with `"wait"`, keep queueing until their `signal` gives up) until the
  frozen tab is discarded. Locks of genuinely closed or crashed tabs
  are released by the browser automatically.
- **No Web Locks API → no cross-tab coordination.** On old browsers or
  insecure (non-HTTPS) contexts, `singleTabLock` silently degrades to no
  coordination: multiple tabs can open the same OPFS file at once, and
  contention then surfaces later as catchable "database is locked"
  (`SQLITE_BUSY`) errors from sqlite-wasm itself.
- **The in-memory fallback loses data on reload.** When OPFS is unavailable
  and `fallbackToMemory` is on, everything works but nothing persists. The
  adapter emits a `logger.warn` when this happens, and `client.storage` says
  so (`persistent: false` with the reason) — check it to warn the user.

## Versioning

This package is pre-1.0: **minor releases may contain breaking changes**
(0.2.0 added a required `executeBatch` to `DbClient`; 0.4.0 renamed what
adapters return to `DbConnection`, rebuilt the React binding on Suspense,
turned `singleTabLock` into three string values and requires React 19). Pin exact versions, and read
the [CHANGELOG](CHANGELOG.md) when upgrading.

## Examples

A runnable browser demo app (Vite + React) lives in [`examples/`](./examples/) — see its README
for details. It's a notes CRUD app that exercises:

- `DatabaseProvider` / `useDbClient` with `<Suspense>` and an error boundary
- `useDbQuery`: the list refreshes itself after adding or removing a note, with no refresh code
- `groupWrites`: a batch insert in one hand-written transaction, notified once
- Versioned migrations (v1 → v2) applied at startup
- OPFS persistence, with the silent `:memory:` fallback when cross-origin isolation is missing
- `singleTabLock`: in a second tab, `"fail"` surfaces `DbTabLockError` right away and `"wait"`
  queues until the first tab closes; plus the retry flow (a fresh client promise and a fresh
  error-boundary `key`)

OPFS persistence requires the page to be served with COOP/COEP headers (see
[COOP/COEP required for OPFS persistence](#coopcoep-required-for-opfs-persistence)) — the demo's
Vite config already sets them. Start it from the repo root with `pnpm example:csc` (or `pnpm dev`
inside `examples/`), then open <http://localhost:5176>.

## Contributing

PRs that change shippable code must include a changeset (`pnpm changeset`) —
CI enforces this via `changeset status`. Docs-only or chore PRs can opt out
with `pnpm changeset --empty`.

## Releasing

Releases are published by CI from tags, never from a local machine:

1. `pnpm changeset version` — bumps `package.json` and updates `CHANGELOG.md`
   from pending changesets; commit the result.
2. Tag that commit `vX.Y.Z` (matching the new version) and push the tag.
3. `.github/workflows/release.yml` does a clean checkout of the tag, re-runs
   the full verification chain (build, typecheck, lint, test, publint), and
   publishes with `--provenance`. Requires an `NPM_TOKEN` repository secret
   with publish rights on the package.
