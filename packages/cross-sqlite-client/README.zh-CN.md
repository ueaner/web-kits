# cross-sqlite-client

面向 JavaScript/TypeScript 应用的跨平台（Web + Tauri）SQLite 客户端：一个统一的 `DbClient` 接口、版本化迁移框架、写入通知、以及基于 Suspense 的 React 绑定——业务 schema 完全由调用方定义。你提供自己的 schema 并选一个适配器，库负责抹平底层平台差异。

## 为什么需要它

Web（通过 `@sqlite.org/sqlite-wasm`）和 Tauri（通过 `@tauri-apps/plugin-sql`）访问 SQLite 的方式截然不同：API 不同、连接模型不同、失败模式也不同。这个库把这些差异隐藏在一个很小的接口后面，让应用其余部分直接调用 `select()`/`execute()`，而不用关心自己跑在哪个平台上；同时内置了迁移运行器和 React Context，省得每个项目都重复写一遍。

## 安装

```bash
pnpm add cross-sqlite-client
```

`@sqlite.org/sqlite-wasm` 和 `@tauri-apps/plugin-sql` 是本包的 `optionalDependencies`，因此安装 `cross-sqlite-client` 时会自动把两个都带上——不需要在你自己应用的 `package.json` 里单独 `pnpm add` 它们。这里的 optional 意味着其中一个安装失败不会阻塞其余安装，而不是「按需跳过」。你的应用只需要**使用**匹配目标平台的那一个；如果不想让另一个出现在 `node_modules` 里，可用 `--no-optional`（或对应包管理器的等效参数）安装。`react` 是可选 peer dependency，只有使用 `./react` 子路径时才需要。

## 快速开始

**1. 用版本化迁移定义 schema**（详见[编写迁移](#编写迁移)）：

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

**2. 创建客户端，按当前平台选择适配器：**

```ts
// appDb.ts
import { createDbClient } from "cross-sqlite-client"
import { createWebAdapter } from "cross-sqlite-client/adapters/web"
import { createTauriAdapter } from "cross-sqlite-client/adapters/tauri"
import { isTauri } from "@tauri-apps/api/core"
import { APP_MIGRATIONS } from "./appMigrations"

export const clientPromise = createDbClient({
  name: "my-app", // 会成为 OPFS/Tauri 数据库文件名
  adapter: isTauri() ? createTauriAdapter() : createWebAdapter(),
  migrations: APP_MIGRATIONS,
})
```

**3. 通过 React Provider 提供给组件树**，加载状态交给 `<Suspense>`，初始化失败交给错误边界：

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

**4. 在组件里查询和写入。** 写入以后不用手动刷新：`useDbQuery` 收到写入通知，会重新查询，新结果出来之前旧数据一直显示：

```tsx
import { useDbClient, useDbQuery } from "cross-sqlite-client/react"

function TodoList() {
  const client = useDbClient()
  const todos = useDbQuery(["todos"], (db) => db.select<Todo>("SELECT id, title FROM todos ORDER BY id"))

  const add = (title: string) => client.execute("INSERT INTO todos (title) VALUES (?)", [title])
  // ...
}
```

## API 参考

### 核心（`cross-sqlite-client`）

| 导出                                                            | 说明                                                                                                                                         |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `createDbClient(options)`                                       | 初始化适配器、应用 `pragmas`、执行待应用迁移，返回带写入通知的 `Promise<DbClient>`。若 PRAGMA/迁移阶段失败，会先关闭已打开的连接再向上抛错。 |
| `runMigrations(db, migrations, options?)`                       | `createDbClient` 内部使用的迁移运行器；不经过 `createDbClient` 时可直接调用。                                                                |
| `defaultExecutor`                                               | 未设置 `migrationOptions.executor` 时使用的默认迁移执行器：通过 `executeBatch()` 执行一个迁移的全部语句，无事务包裹。                        |
| `DbConnection` / `DbClient`（类型）                             | 适配器返回的连接 / `createDbClient()` 返回的、多了 `onWrite` 和 `groupWrites` 的 client —— 详见下文。                                        |
| `DbAdapter` / `DbAdapterConfig` / `DbInitializeOptions`（类型） | 各 `createXAdapter()` 工厂返回的接口 / 传给 `initialize()` 的 `{ name }` 配置 / `initialize()` 的第二个参数 `{ signal }`。                   |
| `BatchStatement` / `Logger`（类型）                             | `executeBatch()` 的语句类型 `string \| { sql, params? }` / 诊断输出通道（`{ warn, error }`，默认 `console`）。                               |
| `Migration` / `MigrationExecutor` / `MigrationOptions`（类型）  | 见[编写迁移](#编写迁移)。                                                                                                                    |
| `DbError` 及子类                                                | 见[错误](#错误)。                                                                                                                            |

```ts
import { createDbClient, runMigrations, defaultExecutor } from "cross-sqlite-client"
```

每个适配器的 `initialize()` 返回一个 `DbConnection`；`createDbClient()` 在它外面装上写入通知，返回 `DbClient`：

```ts
interface DbConnection {
  readonly storage: DbStorage
  select<T>(sql: string, params?: unknown[]): Promise<T[]>
  execute(sql: string, params?: unknown[]): Promise<{ lastInsertId?: number; rowsAffected?: number }>
  executeBatch(statements: BatchStatement[]): Promise<void>
  close(): Promise<void>
}

interface DbClient extends DbConnection {
  onWrite(listener: () => void): () => void // 返回取消订阅的函数
  groupWrites<T>(fn: () => Promise<T>): Promise<T>
}
```

应用代码用 `DbClient`。只需要执行 SQL 的地方（比如仓储层）可以把参数类型写成 `DbConnection`，两种都能传进去。写入通知的细节见[写入通知](#写入通知)。

`executeBatch()` 按顺序执行一批语句，**无跨语句事务保证**——全部语句不带绑定参数时，web 和 memory 适配器会把它们拼成一条 SQL 一次性发给底层引擎（web 适配器每条语句省一次 Worker 往返）；只要批内有**任何**一条带参语句，整批退化为逐条 `execute()`。库刻意不提供业务侧事务 API：连接池型适配器（Tauri）无法保证 `BEGIN`/`COMMIT` 落在同一条物理连接上，因此业务多语句写入应自行保证幂等。

`createDbClient()` 还接受几个可选字段：

```ts
await createDbClient({
  name: "my-app",
  adapter,
  migrations: APP_MIGRATIONS,
  // initialize 之后、迁移之前应用。key 必须是合法标识符；
  // 字符串值必须是枚举式 token（WAL、NORMAL……）；boolean 会转成 0/1；number 原样拼入。
  // 注意：在连接池型适配器（Tauri）上，foreign_keys/busy_timeout 这类连接级 PRAGMA 只对
  // 池中一条连接生效，后续查询会静默失效（createDbClient 会打告警日志）；journal_mode/
  // user_version 这类库级 PRAGMA 不受影响。
  pragmas: { foreign_keys: true, journal_mode: "WAL" },
  // 库告警/错误的诊断输出通道（默认 console）。
  logger: myLogger, // { warn(message, ...args), error(message, ...args) }
  // 原样传给 adapter.initialize()：取消初始化。目前只有 web 适配器在 singleTabLock: "wait" 下排队等锁时用到。
  signal: AbortSignal.timeout(5000),
})
```

### 适配器

每次调用 `createXAdapter()` 都会返回一个**全新的、相互独立的** `DbAdapter` 实例（没有模块级单例状态），因此同一进程里可以放心创建多个——例如测试里。

| 子路径                                | 工厂                         | 底层驱动                                       | `singleConnection` |
| ------------------------------------- | ---------------------------- | ---------------------------------------------- | ------------------ |
| `cross-sqlite-client/adapters/web`    | `createWebAdapter(options?)` | `@sqlite.org/sqlite-wasm`（Worker）            | `true`             |
| `cross-sqlite-client/adapters/tauri`  | `createTauriAdapter()`       | `@tauri-apps/plugin-sql`                       | `false`            |
| `cross-sqlite-client/adapters/memory` | `createMemoryAdapter()`      | `@sqlite.org/sqlite-wasm`（Node/主线程，内存） | `true`             |

`singleConnection` 表示该适配器的每次 `execute()`/`select()` 是否保证落在同一条物理连接上——为什么重要，见[自定义迁移执行器](#自定义迁移执行器与-singleconnection)。

**`createWebAdapter(options?)` 选项：**

| 选项               | 默认值    | 说明                                                                                                                                        |
| ------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeoutMs`        | `15000`   | 等待 SQLite Worker 就绪的超时时间；若 Worker 脚本加载失败，不设超时会让 `initialize()` 永远 pending。                                       |
| `fallbackToMemory` | `true`    | OPFS 不可用时是否静默回退到 `:memory:`（包括探测通过但打开 OPFS 文件失败的情况），而不是抛错。详见 [COOP/COEP](#opfs-持久化需要-coopcoep)。 |
| `singleTabLock`    | `"fail"`  | 另一个标签页已经打开同一个 OPFS 文件时怎么办：`"fail"` 立即报错，`"wait"` 排队等，`"off"` 不协调。详见[多标签页协调](#多标签页协调)。       |
| `logger`           | `console` | 诊断信息（OPFS 降级告警、Worker 错误）的输出位置。传入自己的 `{ warn, error }` 可接入应用的日志/监控。                                      |

**`createTauriAdapter()`** 和 **`createMemoryAdapter()`** 不接受选项；它们的 `initialize()` 只在开始时检查一次 `signal`。`createMemoryAdapter()` 用于测试——见[测试](#测试)。

### React（`cross-sqlite-client/react`）

需要 React 19（用到 `use`、Suspense 和 transition）。

| 导出                              | 说明                                                                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<DatabaseProvider client={...}>` | 接收 `Promise<DbClient>`（通常是 `createDbClient()` 的返回值；已就绪的 client 用 `Promise.resolve(client)`）。它**不**决定用哪个适配器或迁移哪些 schema，也**不**在卸载时调用 `client.close()`。 |
| `useDbClient()`                   | 返回 client。还没就绪时挂起（最近的 `<Suspense>` 显示 fallback）；初始化失败时把错误（包括 `DbTabLockError`）抛给最近的错误边界。在 `DatabaseProvider` 外调用会抛错。                            |
| `useDbQuery(key, run)`            | 返回 `run(client)` 的结果。没出结果时挂起，出错时抛给错误边界。有写入时自动重新查询，见下文。                                                                                                    |

**`useDbQuery`：**

- `key` 用来在缓存里找到这次查询，要能 JSON 序列化，而且要包含 `run` 用到的所有变量。`key` 一样就是同一个查询：用同一个 `key` 的组件共用一次查询。
- 结果按 client 缓存。**每次写入都会清空缓存**，并在 `startTransition` 里重新查询：新结果出来之前旧数据一直显示，不会退回 fallback；连着几次写入时，只会显示最后一次的结果。
- `key` 变化是你自己发起的更新，会挂起到 fallback。想在新结果出来之前保留旧数据（比如分页），把改变 `key` 的 `setState` 包在 `startTransition` 里：

  ```tsx
  function Notes() {
    const [limit, setLimit] = useState(20)
    const notes = useDbQuery(["notes", limit], (db) => db.select<Note>("SELECT * FROM notes ORDER BY id DESC LIMIT ?", [limit]))
    const more = () => startTransition(() => setLimit((n) => n + 20))
    // ...
  }
  ```

- 查询出错时，错误抛给最近的错误边界；错误边界重试（重新挂载）时会重新查询。
- 刻意不做缓存过期、重试、分页、后台刷新。需要这些的话用 [TanStack Query](https://tanstack.com/query)，把写入通知接到它的失效上：

  ```ts
  const client = await clientPromise
  client.onWrite(() => queryClient.invalidateQueries())
  ```

为什么 promise 要缓存在组件外面：组件第一次挂载就挂起时，React 会丢掉它的 state，promise 存在 state 里的话，重试时又会新建一个，于是一直挂起、反复查询。所以缓存放在 client 上，靠 `key` 找回来。

关于 `DatabaseProvider` 有两点值得注意：

- **没有内置 `retry`。** 重试就是创建一个**新的 Promise** 传进来，同时换掉包住它的错误边界的 `key`（不然错误边界还停在出错状态）：

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

- **卸载时不自动 `close()`。** 谁创建 client，谁负责关闭。如果 `DatabaseProvider` 自动关闭 client，那么当它因为条件渲染、路由重挂载、测试 setup/teardown 而卸载又重新挂载时，被缓存/共享的 client（比如应用级单例）就会被直接关掉。如果 client 生命周期需要绑定到某个特定范围，请在你创建它的地方自行关闭。

## 写入通知

`createDbClient()` 返回的 client 在每次写入以后通知你：

```ts
const unsubscribe = client.onWrite(() => {
  // 有写入：刷新界面、让缓存失效……
})
```

- `execute()` 和 `executeBatch()` 结束后通知，**成功和失败都通知**：`executeBatch` 没有事务，中途失败时前面的语句已经生效了。
- `select()` 不通知。写语句（包括 `INSERT … RETURNING`）要走 `execute()`。
- 同一个任务里的多次写入合并成一次通知，在写入的 Promise 结束之后异步发出，不拖慢写入。
- listener 抛出的错误交给 `logger`，不影响写入，也不影响其他 listener。`close()` 之后不再通知。
- `createDbClient()` 里执行的迁移不通知。直接用 `adapter.initialize()` 拿到的 `DbConnection` 也不通知。

**只说明"有写入"，不说明写了哪张表。** 失效通知宁可多发、不能漏发：多发一次只是多查一次，漏发界面就显示旧数据。而按表通知的几条路都会漏：sqlite-wasm 的 Worker1 接口和 Tauri 的 `plugin-sql` 都拿不到 SQLite 的 `update_hook`；连接池上 `TEMP` 触发器靠不住；从 SQL 里解析表名会漏掉触发器和外键级联写到的表。

**`groupWrites(fn)`**：`fn` 执行期间的写入先攒着，`fn` 结束（成功或抛错）以后合并成一次通知；可以嵌套，最外层结束时才通知。手写事务一定要放进来，否则监听方可能在 `COMMIT` 之前重新查询，读到还没提交的数据（web 适配器是单连接，查询会落进同一个事务）：

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

它管的是通知，不是事务：同时进行的几个 `groupWrites` 会一起等到最后一个结束才通知。连着执行好几条写入、又不想通知好几次时，也可以用它。

## 编写迁移

```ts
interface Migration {
  version: number
  statements: string[] // 纯 DDL/DML 字符串，不带绑定参数
}
```

- **版本号必须是唯一的正整数。** 没有应用任何迁移时，`runMigrations` 把当前版本视为 `0`；一个 `version: 0` 的迁移永远满足不了 `version > currentVersion`，会被永久静默跳过。传入不是正整数的版本号（包括 `1.5` 这类）、或两个迁移共用同一个版本号时，`runMigrations` 会立即抛错。（不要求从 1 开始、也不要求连续——跳号是可以的。）
- **每条语句都必须可安全重跑。** 跨平台事务没有统一保证（原因见下文），因此如果某次迁移执行到一半失败，下次启动会**从头重跑整个 version**。新 schema 请使用 `CREATE TABLE/INDEX IF NOT EXISTS`。未来若要写不可重跑的操作（例如重命名列），先查询当前 schema 状态——例如 `SELECT 1 FROM pragma_table_info('t') WHERE name = '...'`——已完成就跳过，而不是依赖回滚。
- **失败以 `DbMigrationError` 暴露。** 运行器会把执行器抛出的错误包装成携带失败 `.version` 的 `DbMigrationError`。`createDbClient()` 在向上抛错前还会先关闭已打开的连接，因此一次失败的启动不会泄漏 Worker、OPFS 文件句柄或标签页锁——重试（比如换一个新的 client Promise）可以从干净状态开始。
- **低于当前版本的"迟到迁移"不会被静默丢弃。** 如果数据库已应用 `[1, 2, 5]` 而新构建补发了缺失的 `3`/`4`，这些版本低于 `MAX(version)`，默认情况下会被永远跳过；运行器会用 `logger.warn` 点名它们。它们**不会**被自动补跑——乱序应用可能破坏 schema 演进假设——这类 hotfix 请显式处理。

`runMigrations(db, migrations, options?)`（以及 `createDbClient` 的 `migrationOptions`）接受：

```ts
interface MigrationOptions {
  tableName?: string // 版本表名，默认 "schema_version"；仅限合法标识符
  executor?: MigrationExecutor // 见下一节
  logger?: Logger // 覆盖 createDbClient 的 logger，仅作用于迁移阶段的诊断输出
}
```

## 自定义迁移执行器与 `singleConnection`

默认执行器（`defaultExecutor`）通过 `executeBatch()` 执行每个迁移的全部语句，无事务包裹。`adapters/web` 还导出了 `transactionalExecutor`，它把一次迁移包在 `BEGIN`/`COMMIT`/`ROLLBACK` 里——但这只在 `singleConnection: true` 的适配器上安全（真正的一条持久连接）。`@tauri-apps/plugin-sql` 的底层是连接池（`sqlx::Pool<Sqlite>`），多次 `execute()` 调用不保证落在同一条物理连接上，`BEGIN` 和 `COMMIT` 跨调用拆散后甚至可能不报错。`createDbClient()` 会在你把一个标记为 `requiresSingleConnection: true` 的执行器传给 `singleConnection: false` 的适配器时，提前抛错。

这个检查基于显式标记，而不是把执行器和 `defaultExecutor` 做引用相等比较：`transactionalExecutor` 通过 `Object.assign(fn, { requiresSingleConnection: true })` 携带标记。如果你也写了一个管理事务的自定义执行器，请用同样方式标记。完全不碰事务的执行器（例如只加日志）不需要这个标记，即使传给连接池适配器也不会被拒绝。

```ts
import { runMigrations } from "cross-sqlite-client"
import { transactionalExecutor } from "cross-sqlite-client/adapters/web"

await runMigrations(client, APP_MIGRATIONS, { executor: transactionalExecutor })
```

## Web 适配器细节

### OPFS 持久化需要 COOP/COEP

`createWebAdapter()` 使用 OPFS 持久化，要求页面必须以下列响应头提供：

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

没有这些头时，适配器不会报错，而是静默回退到内存数据库（`fallbackToMemory: true` 为默认），因此页面刷新后数据会丢失。如果你宁可失败也不愿在不知情的情况下跑内存模式，可传 `fallbackToMemory: false`；也可以保留回退，检查 `client.storage` 提示用户"这次的数据不会保存"：

```ts
const client = await createDbClient({ name: "my-app", adapter: createWebAdapter(), migrations })
if (!client.storage.persistent) {
  // "not-cross-origin-isolated" | "opfs-unsupported" | "opfs-unavailable" | "open-failed"
  showBanner(`这次的进度不会保存（${client.storage.reason}）`)
}
```

`client.storage` 在 OPFS 文件和 Tauri 上是 `{ persistent: true }`，退回内存时是 `{ persistent: false, reason }`（内存适配器是 `reason: "memory-adapter"`）。没有打开的连接时（`initialize()` 之前、`close()` 之后、`initialize()` 失败后）是 `{ persistent: false, reason: "not-initialized" }`。

注意这是**部署/托管层面的约束**，不是浏览器版本问题：即使在很新的浏览器上，也可能因为嵌在别人的 iframe 里、托管平台不允许自定义响应头、或者团队故意不启用 `COEP: require-corp`（以免阻塞页面上的其他第三方脚本）而失去跨源隔离。目前只在「完整 OPFS 持久化」和「完全没有持久化（`:memory:`）」之间二选一——例如 sqlite-wasm 还提供了基于 `localStorage`/`sessionStorage` 的 `kvvfs` 后端，可作为中间层，但当前版本尚未接入；见[已知限制](#已知限制)。

### 多标签页协调

sqlite-wasm 的 `opfs` VFS 自带锁协议，因此两个标签页同时写同一个 OPFS 文件时**不会损坏数据，通常也不会卡死**——失败的标签页会收到一个可捕获的 "database is locked" SQL 错误。但这个错误只在某条查询恰好撞上竞争时才暴露，而且不会告诉你**为什么**失败。

所以 `createWebAdapter()` 会在打开数据库文件前用 [Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) 申请一个命名锁。另一个标签页已经持有这把锁时，按 `singleTabLock` 处理：

- `"fail"`（默认）：`initialize()` 立即以 `DbTabLockError` reject。捕获它之后可以展示「该应用已在另一个标签页打开」之类的提示。
- `"wait"`：排队等另一个标签页放开（关闭标签页时浏览器会自动放开）。等多久由 `createDbClient({ signal })` 决定，比如 `AbortSignal.timeout(5000)`；不传就一直等。被取消（或在等待中调用 `close()`）时以 `DbTabLockError` reject，取消原因在 `cause` 里。恰好在取消的同时轮到的锁会立即放开，不会留下一把没人用的锁。
- `"off"`：不协调，只依赖 sqlite-wasm 自身的重试/`SQLITE_BUSY` 处理。

默认不是 `"wait"`：另一个标签页一直开着时，页面会一直停在加载，没有任何提示，这比立即报错更难排查。锁只对 OPFS 持久化路径生效——`:memory:` 每个标签页互相独立，无需协调。

锁原语本身 `acquireTabLock(lockName, { wait?, signal? })` 也从 `cross-sqlite-client/adapters/web` 导出：拿到锁时返回 `release()`；不等待时拿不到返回 `null`；等待时被取消抛出 `signal.reason`。应用如果需要为数据库之外的资源做同样的跨标签页协调，可以直接使用。

## 错误

所有适配器都抛出以下错误类（全部继承 `DbError extends Error`，均可选传入 `cause`）：

| 类                                           | 触发时机                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `DbError`                                    | 通用/用法错误，例如 `initialize()` 还没 resolve 就调用 `select()`/`execute()`，或 `close()` 之后调用。       |
| `DbInitializationError`                      | `adapter.initialize()` 失败（Worker/OPFS/Tauri 加载失败等）。                                                |
| `DbExecutionError`（带 `.sql` 和 `.params`） | `select()`/`execute()`/`executeBatch()` 调用失败。                                                           |
| `DbMigrationError`（带 `.version`）          | 某条迁移失败；底层错误包装在 `cause` 里。由 `runMigrations`/`createDbClient` 抛出。                          |
| `DbCloseError`                               | `client.close()` 失败。                                                                                      |
| `DbTabLockError`                             | （仅 Web 适配器）另一个标签页已持有数据库锁（`"fail"`），或排队等锁时被取消（`"wait"`，原因在 `cause` 里）。 |

```ts
import { DbTabLockError } from "cross-sqlite-client"

try {
  await clientPromise
} catch (error) {
  if (error instanceof DbTabLockError) {
    // 展示「已在另一个标签页打开」而不是通用错误
  }
}
```

## 测试

测试时请用 `createMemoryAdapter()`，而不是 mock `DbClient`——它是真正的 SQLite 引擎（与 Web 适配器使用同一个 `@sqlite.org/sqlite-wasm` 的 Node/主线程版本），因此你的 SQL 会真实执行，行为与 Web 适配器一致，只是没有持久化：

```ts
import { createDbClient } from "cross-sqlite-client"
import { createMemoryAdapter } from "cross-sqlite-client/adapters/memory"

const client = await createDbClient({ name: "test", adapter: createMemoryAdapter(), migrations: APP_MIGRATIONS })
// 正常使用 client.select() / client.execute()，写入通知也照常工作
```

只测仓储层、不需要写入通知时，也可以直接用 `createMemoryAdapter().initialize({ name: "test" })` 拿一个 `DbConnection`，再自己 `runMigrations(connection, APP_MIGRATIONS)`。

每次 `createMemoryAdapter()` 调用都是一个全新的独立实例，因此不同测试（或同一进程里的并行测试）不会共享状态。

库自身的测试套件（`pnpm test`）覆盖迁移运行器、客户端生命周期和 React 绑定；CI（`.github/workflows/ci.yml`）在 Node 24 上运行 lint、格式检查（`oxfmt`）、typecheck、测试、构建和 `publint`（Node 24 是开发的最低版本要求，见 `package.json` 的 `engines`）。提交前请运行 `pnpm format` 保持代码树格式整洁。

## 已知限制

- **`select()` 执行的写语句不通知。** 写语句（包括 `INSERT … RETURNING`）要走 `execute()`，见[写入通知](#写入通知)。
- **没放进 `groupWrites` 的手写事务，监听方可能读到未提交的数据。** 见[写入通知](#写入通知)。

- **`lastInsertId` 精度。** `DbClient.execute()` 返回的 `lastInsertId` 类型是 `number`。Web 适配器会把 SQLite 的 `sqlite3_last_insert_rowid()`（64 位 `bigint`，最大 2^63-1）通过 `Number()` 转换，因此超过 `Number.MAX_SAFE_INTEGER`（2^53-1）时会丢失精度。对典型本地优先应用不是问题（需要单表超过 9 千万亿行才会触发），但如果你需要精确的大整数 rowid，请用专门的 `SELECT last_insert_rowid()` 查询读取。
- **没有 OPFS 降级层。** OPFS/跨源隔离不可用时，`createWebAdapter()` 只有两种状态：完整 OPFS 持久化，或完全没有持久化的 `:memory:`。sqlite-wasm 提供了基于 `localStorage`/`sessionStorage` 的 `kvvfs` 后端，可作为中间层，但当前版本尚未接入——如果你需要在无法达到跨源隔离的部署环境里获得持久化，可以考虑接入它（见 [COOP/COEP](#opfs-持久化需要-coopcoep)）。

## 运行环境说明

以下是刻意的设计取舍，而非缺陷：

- **bfcache 冻结的标签页会一直持有数据库锁。** `singleTabLock` 基于 Web Locks API；被浏览器前进/后退缓存（bfcache）冻结（而非关闭）的标签页会持续持有锁，其他标签页会一直收到 `DbTabLockError`（`"wait"` 下则一直排队，直到 `signal` 超时），直到被冻结的标签页被丢弃。真正关闭或崩溃的标签页，其锁会由浏览器自动释放。
- **没有 Web Locks API → 没有跨标签页协调。** 在老旧浏览器或非安全（非 HTTPS）上下文中，`singleTabLock` 会静默退化为不做协调：多个标签页可以同时打开同一个 OPFS 文件，竞争会在此后以 sqlite-wasm 抛出的可捕获的 "database is locked"（`SQLITE_BUSY`）错误形式暴露。
- **内存降级模式下刷新页面会丢数据。** OPFS 不可用且 `fallbackToMemory` 开启时，一切功能正常但不持久化。发生降级时适配器会发出 `logger.warn`，`client.storage` 也会是 `persistent: false` 并给出原因——应用需要向用户提示时检查它即可。

## 版本策略

本包处于 0.x 阶段：**minor 版本可能包含破坏性变更**（0.2.0 给 `DbClient` 新增了必选方法 `executeBatch`；0.4.0 把适配器返回的连接改名为 `DbConnection`、React 绑定改成基于 Suspense、`singleTabLock` 改成三个字符串值，并要求 React 19）。请锁定精确版本号，升级前阅读 [CHANGELOG](CHANGELOG.md)。

## 示例

[`examples/`](./examples/) 目录下有一个可运行的浏览器演示应用（Vite + React）——详细说明见它自己的 README。这是一个便签 CRUD 应用，演示了：

- `DatabaseProvider` / `useDbClient` 配合 `<Suspense>` 和错误边界
- `useDbQuery`：增删便签以后列表自动刷新，没有手动刷新的代码
- `groupWrites`：一个手写事务里批量插入，只发一次写入通知
- 启动时应用 v1 → v2 的版本化迁移
- OPFS 持久化，以及缺少跨源隔离时静默降级到 `:memory:`
- `singleTabLock`：再开一个标签页，`"fail"` 下立即 `DbTabLockError`，`"wait"` 下排队等第一个标签页关掉；以及重试流程（新的 client promise 加新的错误边界 `key`）

OPFS 持久化要求页面带 COOP/COEP 响应头（见 [OPFS 持久化需要 COOP/COEP](#opfs-持久化需要-coopcoep)）——演示应用的 Vite 配置已内置。在仓库根目录运行 `pnpm example:csc`（或在 `examples/` 目录里 `pnpm dev`），然后打开 <http://localhost:5176>。

## 贡献

改动可发布代码的 PR 必须附带 changeset（`pnpm changeset`）——CI 会通过 `changeset status` 强制检查。纯文档或杂务类 PR 可以用 `pnpm changeset --empty` 豁免。

## 发布

发布由 CI 从 tag 触发，绝不从本地机器发出：

1. `pnpm changeset version`——根据待发布的 changeset 更新 `package.json` 版本号和 `CHANGELOG.md`，提交结果。
2. 给该提交打上与新版本一致的 `vX.Y.Z` tag 并推送。
3. `.github/workflows/release.yml` 会干净地 checkout 该 tag，重跑完整验证链（build、typecheck、lint、test、publint），并以 `--provenance` 发布。需要在仓库 secrets 中配置有发布权限的 `NPM_TOKEN`。
