# cross-sqlite-client

Cross-platform (Web + Tauri) SQLite client for JavaScript/TypeScript apps: one
`DbClient` interface, a versioned migration framework, and React bindings —
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
import type { Migration } from "cross-sqlite-client";

export const APP_MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [`CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL);`],
  },
];
```

**2. Create a client, picking the adapter for the current platform:**

```ts
// appDb.ts
import { createDbClient } from "cross-sqlite-client";
import { createWebAdapter } from "cross-sqlite-client/adapters/web";
import { createTauriAdapter } from "cross-sqlite-client/adapters/tauri";
import { isTauri } from "@tauri-apps/api/core";
import { APP_MIGRATIONS } from "./appMigrations";

export const clientPromise = createDbClient({
  name: "my-app", // becomes the OPFS/Tauri database filename
  adapter: isTauri() ? createTauriAdapter() : createWebAdapter(),
  migrations: APP_MIGRATIONS,
});
```

**3. Make it available to your React tree:**

```tsx
import { DatabaseProvider } from "cross-sqlite-client/react";
import { clientPromise } from "./appDb";

function App() {
  return (
    <DatabaseProvider client={clientPromise}>
      <Router />
    </DatabaseProvider>
  );
}
```

**4. Read it wherever you need the client:**

```tsx
import { useDatabase } from "cross-sqlite-client/react";

function TodoList() {
  const { dbClient, isDbReady, isLoading, dbError } = useDatabase();

  if (isLoading) return <Spinner />;
  if (dbError) return <ErrorMessage error={dbError} />;
  if (!isDbReady || !dbClient) return null;

  // dbClient.select<T>(sql, params?) / dbClient.execute(sql, params?) / dbClient.executeBatch(statements) / dbClient.close()
  // ...
}
```

## API reference

### Core (`cross-sqlite-client`)

| Export                                                         | What it is                                                                                                                                                                                                           |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createDbClient(options)`                                      | Resolves the adapter, initializes it, applies `pragmas`, runs pending migrations, returns `Promise<DbClient>`. If PRAGMA/migration setup fails, the already-opened connection is closed before the error propagates. |
| `runMigrations(db, migrations, options?)`                      | The migration runner `createDbClient` uses internally — call it directly if you're not going through `createDbClient`.                                                                                               |
| `defaultExecutor`                                              | The migration executor used when `migrationOptions.executor` isn't set — runs all of a migration's statements via `executeBatch()`, with no transaction.                                                             |
| `DbClient` (type)                                              | `{ select<T>(sql, params?), execute(sql, params?), executeBatch(statements), close() }` — see below.                                                                                                                 |
| `DbAdapter` / `DbAdapterConfig` (types)                        | The interface each `createXAdapter()` factory returns / the `{ name }` config passed to `initialize()`.                                                                                                              |
| `BatchStatement` / `Logger` (types)                            | `string \| { sql, params? }` for `executeBatch()` / the diagnostics channel (`{ warn, error }`, defaults to `console`).                                                                                              |
| `Migration` / `MigrationExecutor` / `MigrationOptions` (types) | See [Writing migrations](#writing-migrations).                                                                                                                                                                       |
| `DbError` and subclasses                                       | See [Errors](#errors).                                                                                                                                                                                               |

```ts
import { createDbClient, runMigrations, defaultExecutor } from "cross-sqlite-client";
```

`DbClient`, the interface every adapter implements:

```ts
interface DbClient {
  select<T>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ lastInsertId?: number; rowsAffected?: number }>;
  executeBatch(statements: BatchStatement[]): Promise<void>;
  close(): Promise<void>;
}
```

`executeBatch()` runs a batch of statements in order with **no cross-statement
transaction guarantee** — when every statement is parameterless, the web and
memory adapters join them into a single SQL string and send it to the
underlying engine in one call (the web adapter saves one Worker round-trip per
statement); if _any_ statement carries bound params, the whole batch falls
back to running one by one. The library deliberately does not
offer a business-facing transaction API: pooled-connection adapters (Tauri)
can't guarantee `BEGIN`/`COMMIT` land on the same physical connection, so
business multi-statement writes should be idempotent instead.

`createDbClient()` also accepts two optional fields:

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
});
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
| `singleTabLock`    | `true`    | Whether to coordinate access to the same OPFS file across browser tabs. See [Multi-tab coordination](#multi-tab-coordination).                                                                                  |
| `logger`           | `console` | Where diagnostics go (OPFS-fallback warnings, worker errors). Pass your own `{ warn, error }` to route them into your logging/telemetry.                                                                        |

**`createTauriAdapter()`** and **`createMemoryAdapter()`** take no options.
`createMemoryAdapter()` is meant for tests — see [Testing](#testing).

### React (`cross-sqlite-client/react`)

| Export                            | What it is                                                                                                                                                                                                                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<DatabaseProvider client={...}>` | Takes a `DbClient` or `Promise<DbClient>` (typically `createDbClient()`'s return value) and resolves it, exposing the result via context. It does **not** decide which adapter/migrations to use — that's your app's job (see Quick start) — and it does **not** call `client.close()` on unmount (see below). |
| `useDatabase()`                   | Reads the context: `{ dbClient, isDbReady, isLoading, dbError }`. Throws if called outside a `DatabaseProvider`.                                                                                                                                                                                               |

Two things worth knowing about `DatabaseProvider`:

- **No `retry`.** The `client` prop only ever settles once — retrying means
  passing it a _new_ promise, which re-triggers initialization because the
  prop reference changed. The moment the prop changes, the context drops back
  to fully-not-ready (`dbClient: null`, `isDbReady: false`) until the new
  promise resolves — consumers never see the old connection during the window:

  ```tsx
  function App() {
    const [clientPromise, setClientPromise] = useState(() => createDbClient({ ... }));

    return (
      <DatabaseProvider client={clientPromise}>
        {/* on a dbError, e.g. from a "Retry" button: */}
        {/* setClientPromise(createDbClient({ ... })) */}
        <Router />
      </DatabaseProvider>
    );
  }
  ```

- **No auto-`close()` on unmount.** Whoever creates the client owns closing
  it. If `DatabaseProvider` closed it automatically, a cached/shared client
  (e.g. an app-level singleton) would get closed the moment the provider
  happens to unmount and remount (conditional rendering, a remounting route,
  test setup/teardown) — leaving `isDbReady: true` pointing at a dead
  connection. Close the client yourself, in whatever code created it, if its
  lifetime should be tied to something specific.

## Writing migrations

```ts
interface Migration {
  version: number;
  statements: string[]; // plain DDL/DML strings, no bound parameters
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
  tableName?: string; // version table name, default "schema_version"; identifiers only
  executor?: MigrationExecutor; // see the next section
  logger?: Logger; // overrides createDbClient's logger for migration diagnostics
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
import { runMigrations } from "cross-sqlite-client";
import { transactionalExecutor } from "cross-sqlite-client/adapters/web";

await runMigrations(client, APP_MIGRATIONS, { executor: transactionalExecutor });
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
loudly than run in-memory unexpectedly.

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

By default (`singleTabLock: true`), `createWebAdapter()` uses the
[Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)
to claim a named lock for the database file before opening it. If another tab
already holds it, `initialize()` rejects immediately with `DbTabLockError`
instead of letting the app find out later via a random query failure — catch
it to show something like "this app is already open in another tab." Pass
`singleTabLock: false` to skip this and rely solely on sqlite-wasm's own
retry/`SQLITE_BUSY` behavior. This only ever applies to the OPFS-backed path —
`:memory:` is private per tab, so there's nothing to coordinate there.

The lock primitive itself, `tryAcquireTabLock(lockName)`, is also exported
from `cross-sqlite-client/adapters/web` for apps that need the same
best-effort cross-tab coordination for something other than the database.

## Errors

Every adapter throws one of these (all extend `DbError extends Error`, and all
accept an optional `cause`):

| Class                                         | Thrown when                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `DbError`                                     | Generic/usage errors, e.g. calling `select()`/`execute()` before `initialize()` resolves, or after `close()`. |
| `DbInitializationError`                       | `adapter.initialize()` failed (worker/OPFS/Tauri-load failure, etc.).                                         |
| `DbExecutionError` (has `.sql` and `.params`) | A `select()`/`execute()`/`executeBatch()` call failed.                                                        |
| `DbMigrationError` (has `.version`)           | A migration failed; wraps the underlying error as `cause`. Thrown by `runMigrations`/`createDbClient`.        |
| `DbCloseError`                                | `client.close()` failed.                                                                                      |
| `DbTabLockError`                              | (Web adapter only, `singleTabLock: true`) Another tab already holds the database.                             |

```ts
import { DbTabLockError } from "cross-sqlite-client";

try {
  await clientPromise;
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
import { createMemoryAdapter } from "cross-sqlite-client/adapters/memory";
import { runMigrations } from "cross-sqlite-client";

const client = await createMemoryAdapter().initialize({ name: "test" });
await runMigrations(client, APP_MIGRATIONS);
// exercise client.select() / client.execute() as usual
```

Each `createMemoryAdapter()` call is a fresh, independent instance, so
separate tests (or parallel tests in the same process) don't share state.

The library's own suite (`pnpm test`) covers the migration runner, the client
lifecycle, and the React bindings; CI (`.github/workflows/ci.yml`) runs lint,
format check (`oxfmt`), typecheck, tests, build, and `publint` on Node 24 (the
minimum supported Node version for development; see `engines` in
`package.json`). Run `pnpm format` before committing to keep the tree
format-clean.

## Known limitations

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
  until the frozen tab is discarded. Locks of genuinely closed or crashed tabs
  are released by the browser automatically.
- **No Web Locks API → no cross-tab coordination.** On old browsers or
  insecure (non-HTTPS) contexts, `singleTabLock` silently degrades to no
  coordination: multiple tabs can open the same OPFS file at once, and
  contention then surfaces later as catchable "database is locked"
  (`SQLITE_BUSY`) errors from sqlite-wasm itself.
- **The in-memory fallback loses data on reload.** When OPFS is unavailable
  and `fallbackToMemory` is on, everything works but nothing persists. The
  adapter emits a `logger.warn` when this happens — pass your own `logger` if
  the app needs to detect it and warn the user.

## Versioning

This package is pre-1.0: **minor releases may contain breaking changes**
(0.2.0 added a required `executeBatch` to `DbClient`, which breaks custom
adapter/client implementations at compile time). Pin exact versions, and read
the [CHANGELOG](CHANGELOG.md) when upgrading.

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
