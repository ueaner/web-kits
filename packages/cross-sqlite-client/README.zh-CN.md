# cross-sqlite-client

面向 JavaScript/TypeScript 应用的跨平台（Web + Tauri）SQLite 客户端：一个统一的 `DbClient` 接口、版本化迁移框架、以及 React 绑定——业务 schema 完全由调用方定义。你提供自己的 schema 并选一个适配器，库负责抹平底层平台差异。

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
import type { Migration } from "cross-sqlite-client";

export const APP_MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [`CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL);`],
  },
];
```

**2. 创建客户端，按当前平台选择适配器：**

```ts
// appDb.ts
import { createDbClient } from "cross-sqlite-client";
import { createWebAdapter } from "cross-sqlite-client/adapters/web";
import { createTauriAdapter } from "cross-sqlite-client/adapters/tauri";
import { isTauri } from "@tauri-apps/api/core";
import { APP_MIGRATIONS } from "./appMigrations";

export const clientPromise = createDbClient({
  name: "my-app", // 会成为 OPFS/Tauri 数据库文件名
  adapter: isTauri() ? createTauriAdapter() : createWebAdapter(),
  migrations: APP_MIGRATIONS,
});
```

**3. 通过 React Provider 提供给组件树：**

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

**4. 在任意组件里读取客户端：**

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

## API 参考

### 核心（`cross-sqlite-client`）

| 导出                                                           | 说明                                                                                                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `createDbClient(options)`                                      | 初始化适配器、应用 `pragmas`、执行待应用迁移，返回 `Promise<DbClient>`。若 PRAGMA/迁移阶段失败，会先关闭已打开的连接再向上抛错。 |
| `runMigrations(db, migrations, options?)`                      | `createDbClient` 内部使用的迁移运行器；不经过 `createDbClient` 时可直接调用。                                                    |
| `defaultExecutor`                                              | 未设置 `migrationOptions.executor` 时使用的默认迁移执行器：通过 `executeBatch()` 执行一个迁移的全部语句，无事务包裹。            |
| `DbClient`（类型）                                             | `{ select<T>(sql, params?), execute(sql, params?), executeBatch(statements), close() }` —— 详见下文。                            |
| `DbAdapter` / `DbAdapterConfig`（类型）                        | 各 `createXAdapter()` 工厂返回的接口 / 传给 `initialize()` 的 `{ name }` 配置。                                                  |
| `BatchStatement` / `Logger`（类型）                            | `executeBatch()` 的语句类型 `string \| { sql, params? }` / 诊断输出通道（`{ warn, error }`，默认 `console`）。                   |
| `Migration` / `MigrationExecutor` / `MigrationOptions`（类型） | 见[编写迁移](#编写迁移)。                                                                                                        |
| `DbError` 及子类                                               | 见[错误](#错误)。                                                                                                                |

```ts
import { createDbClient, runMigrations, defaultExecutor } from "cross-sqlite-client";
```

每个适配器都实现的 `DbClient` 接口：

```ts
interface DbClient {
  select<T>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ lastInsertId?: number; rowsAffected?: number }>;
  executeBatch(statements: BatchStatement[]): Promise<void>;
  close(): Promise<void>;
}
```

`executeBatch()` 按顺序执行一批语句，**无跨语句事务保证**——全部语句不带绑定参数时，web 和 memory 适配器会把它们拼成一条 SQL 一次性发给底层引擎（web 适配器每条语句省一次 Worker 往返）；只要批内有**任何**一条带参语句，整批退化为逐条 `execute()`。库刻意不提供业务侧事务 API：连接池型适配器（Tauri）无法保证 `BEGIN`/`COMMIT` 落在同一条物理连接上，因此业务多语句写入应自行保证幂等。

`createDbClient()` 还接受两个可选字段：

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
});
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
| `singleTabLock`    | `true`    | 是否跨浏览器标签页协调对同一 OPFS 文件的访问。详见[多标签页协调](#多标签页协调)。                                                           |
| `logger`           | `console` | 诊断信息（OPFS 降级告警、Worker 错误）的输出位置。传入自己的 `{ warn, error }` 可接入应用的日志/监控。                                      |

**`createTauriAdapter()`** 和 **`createMemoryAdapter()`** 不接受选项。`createMemoryAdapter()` 用于测试——见[测试](#测试)。

### React（`cross-sqlite-client/react`）

| 导出                              | 说明                                                                                                                                                                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<DatabaseProvider client={...}>` | 接收 `DbClient` 或 `Promise<DbClient>`（通常是 `createDbClient()` 的返回值），解析后通过 Context 暴露。它**不**决定用哪个适配器或迁移哪些 schema——那是应用层的职责（见快速开始）——也**不**在卸载时调用 `client.close()`（原因见下文）。 |
| `useDatabase()`                   | 读取 Context：`{ dbClient, isDbReady, isLoading, dbError }`。在 `DatabaseProvider` 外调用会抛错。                                                                                                                                       |

关于 `DatabaseProvider` 有两点值得注意：

- **没有内置 `retry`。** `client` prop 只会进入最终状态一次——重试意味着传给它一个**新的 Promise**，prop 引用变化会重新触发初始化。prop 变化的瞬间，context 会先回到完全未就绪状态（`dbClient: null`、`isDbReady: false`），直到新 Promise resolve——窗口期内消费方不会看到旧连接：

  ```tsx
  function App() {
    const [clientPromise, setClientPromise] = useState(() => createDbClient({ ... }));

    return (
      <DatabaseProvider client={clientPromise}>
        {/* 出现 dbError 时，例如点击「重试」按钮：setClientPromise(createDbClient({ ... })) */}
        <Router />
      </DatabaseProvider>
    );
  }
  ```

- **卸载时不自动 `close()`。** 谁创建 client，谁负责关闭。如果 `DatabaseProvider` 自动关闭 client，那么当它因为条件渲染、路由重挂载、测试 setup/teardown 而卸载又重新挂载时，被缓存/共享的 client（比如应用级单例）就会被直接关掉——结果 `isDbReady: true`，但连接其实已经死了。如果 client 生命周期需要绑定到某个特定范围，请在你创建它的地方自行关闭。

## 编写迁移

```ts
interface Migration {
  version: number;
  statements: string[]; // 纯 DDL/DML 字符串，不带绑定参数
}
```

- **版本号必须是唯一的正整数。** 没有应用任何迁移时，`runMigrations` 把当前版本视为 `0`；一个 `version: 0` 的迁移永远满足不了 `version > currentVersion`，会被永久静默跳过。传入不是正整数的版本号（包括 `1.5` 这类）、或两个迁移共用同一个版本号时，`runMigrations` 会立即抛错。（不要求从 1 开始、也不要求连续——跳号是可以的。）
- **每条语句都必须可安全重跑。** 跨平台事务没有统一保证（原因见下文），因此如果某次迁移执行到一半失败，下次启动会**从头重跑整个 version**。新 schema 请使用 `CREATE TABLE/INDEX IF NOT EXISTS`。未来若要写不可重跑的操作（例如重命名列），先查询当前 schema 状态——例如 `SELECT 1 FROM pragma_table_info('t') WHERE name = '...'`——已完成就跳过，而不是依赖回滚。
- **失败以 `DbMigrationError` 暴露。** 运行器会把执行器抛出的错误包装成携带失败 `.version` 的 `DbMigrationError`。`createDbClient()` 在向上抛错前还会先关闭已打开的连接，因此一次失败的启动不会泄漏 Worker、OPFS 文件句柄或标签页锁——重试（比如换一个新的 client Promise）可以从干净状态开始。
- **低于当前版本的"迟到迁移"不会被静默丢弃。** 如果数据库已应用 `[1, 2, 5]` 而新构建补发了缺失的 `3`/`4`，这些版本低于 `MAX(version)`，默认情况下会被永远跳过；运行器会用 `logger.warn` 点名它们。它们**不会**被自动补跑——乱序应用可能破坏 schema 演进假设——这类 hotfix 请显式处理。

`runMigrations(db, migrations, options?)`（以及 `createDbClient` 的 `migrationOptions`）接受：

```ts
interface MigrationOptions {
  tableName?: string; // 版本表名，默认 "schema_version"；仅限合法标识符
  executor?: MigrationExecutor; // 见下一节
  logger?: Logger; // 覆盖 createDbClient 的 logger，仅作用于迁移阶段的诊断输出
}
```

## 自定义迁移执行器与 `singleConnection`

默认执行器（`defaultExecutor`）通过 `executeBatch()` 执行每个迁移的全部语句，无事务包裹。`adapters/web` 还导出了 `transactionalExecutor`，它把一次迁移包在 `BEGIN`/`COMMIT`/`ROLLBACK` 里——但这只在 `singleConnection: true` 的适配器上安全（真正的一条持久连接）。`@tauri-apps/plugin-sql` 的底层是连接池（`sqlx::Pool<Sqlite>`），多次 `execute()` 调用不保证落在同一条物理连接上，`BEGIN` 和 `COMMIT` 跨调用拆散后甚至可能不报错。`createDbClient()` 会在你把一个标记为 `requiresSingleConnection: true` 的执行器传给 `singleConnection: false` 的适配器时，提前抛错。

这个检查基于显式标记，而不是把执行器和 `defaultExecutor` 做引用相等比较：`transactionalExecutor` 通过 `Object.assign(fn, { requiresSingleConnection: true })` 携带标记。如果你也写了一个管理事务的自定义执行器，请用同样方式标记。完全不碰事务的执行器（例如只加日志）不需要这个标记，即使传给连接池适配器也不会被拒绝。

```ts
import { runMigrations } from "cross-sqlite-client";
import { transactionalExecutor } from "cross-sqlite-client/adapters/web";

await runMigrations(client, APP_MIGRATIONS, { executor: transactionalExecutor });
```

## Web 适配器细节

### OPFS 持久化需要 COOP/COEP

`createWebAdapter()` 使用 OPFS 持久化，要求页面必须以下列响应头提供：

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

没有这些头时，适配器不会报错，而是静默回退到内存数据库（`fallbackToMemory: true` 为默认），因此页面刷新后数据会丢失。如果你宁可失败也不愿在不知情的情况下跑内存模式，可传 `fallbackToMemory: false`。

注意这是**部署/托管层面的约束**，不是浏览器版本问题：即使在很新的浏览器上，也可能因为嵌在别人的 iframe 里、托管平台不允许自定义响应头、或者团队故意不启用 `COEP: require-corp`（以免阻塞页面上的其他第三方脚本）而失去跨源隔离。目前只在「完整 OPFS 持久化」和「完全没有持久化（`:memory:`）」之间二选一——例如 sqlite-wasm 还提供了基于 `localStorage`/`sessionStorage` 的 `kvvfs` 后端，可作为中间层，但当前版本尚未接入；见[已知限制](#已知限制)。

### 多标签页协调

sqlite-wasm 的 `opfs` VFS 自带锁协议，因此两个标签页同时写同一个 OPFS 文件时**不会损坏数据，通常也不会卡死**——失败的标签页会收到一个可捕获的 "database is locked" SQL 错误。但这个错误只在某条查询恰好撞上竞争时才暴露，而且不会告诉你**为什么**失败。

默认开启 `singleTabLock: true` 时，`createWebAdapter()` 会在打开数据库文件前用 [Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) 申请一个命名锁。如果另一个标签页已经持有该锁，`initialize()` 会立即以 `DbTabLockError` reject，而不是让应用在之后的某次随机查询里才发现失败——捕获它之后可以展示「该应用已在另一个标签页打开」之类的提示。传 `singleTabLock: false` 可跳过此行为，只依赖 sqlite-wasm 自身的重试/`SQLITE_BUSY` 处理。它只对 OPFS 持久化路径生效——`:memory:` 每个标签页互相独立，无需协调。

锁原语本身 `tryAcquireTabLock(lockName)` 也从 `cross-sqlite-client/adapters/web` 导出，应用如果需要为数据库之外的资源做同样的跨标签页尽力协调，可以直接使用。

## 错误

所有适配器都抛出以下错误类（全部继承 `DbError extends Error`，均可选传入 `cause`）：

| 类                                           | 触发时机                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `DbError`                                    | 通用/用法错误，例如 `initialize()` 还没 resolve 就调用 `select()`/`execute()`，或 `close()` 之后调用。 |
| `DbInitializationError`                      | `adapter.initialize()` 失败（Worker/OPFS/Tauri 加载失败等）。                                          |
| `DbExecutionError`（带 `.sql` 和 `.params`） | `select()`/`execute()`/`executeBatch()` 调用失败。                                                     |
| `DbMigrationError`（带 `.version`）          | 某条迁移失败；底层错误包装在 `cause` 里。由 `runMigrations`/`createDbClient` 抛出。                    |
| `DbCloseError`                               | `client.close()` 失败。                                                                                |
| `DbTabLockError`                             | （仅 Web 适配器，`singleTabLock: true`）另一个标签页已持有数据库锁。                                   |

```ts
import { DbTabLockError } from "cross-sqlite-client";

try {
  await clientPromise;
} catch (error) {
  if (error instanceof DbTabLockError) {
    // 展示「已在另一个标签页打开」而不是通用错误
  }
}
```

## 测试

测试时请用 `createMemoryAdapter()`，而不是 mock `DbClient`——它是真正的 SQLite 引擎（与 Web 适配器使用同一个 `@sqlite.org/sqlite-wasm` 的 Node/主线程版本），因此你的 SQL 会真实执行，行为与 Web 适配器一致，只是没有持久化：

```ts
import { createMemoryAdapter } from "cross-sqlite-client/adapters/memory";
import { runMigrations } from "cross-sqlite-client";

const client = await createMemoryAdapter().initialize({ name: "test" });
await runMigrations(client, APP_MIGRATIONS);
// 正常使用 client.select() / client.execute()
```

每次 `createMemoryAdapter()` 调用都是一个全新的独立实例，因此不同测试（或同一进程里的并行测试）不会共享状态。

库自身的测试套件（`pnpm test`）覆盖迁移运行器、客户端生命周期和 React 绑定；CI（`.github/workflows/ci.yml`）在 Node 24 上运行 lint、格式检查（`oxfmt`）、typecheck、测试、构建和 `publint`（Node 24 是开发的最低版本要求，见 `package.json` 的 `engines`）。提交前请运行 `pnpm format` 保持代码树格式整洁。

## 已知限制

- **`lastInsertId` 精度。** `DbClient.execute()` 返回的 `lastInsertId` 类型是 `number`。Web 适配器会把 SQLite 的 `sqlite3_last_insert_rowid()`（64 位 `bigint`，最大 2^63-1）通过 `Number()` 转换，因此超过 `Number.MAX_SAFE_INTEGER`（2^53-1）时会丢失精度。对典型本地优先应用不是问题（需要单表超过 9 千万亿行才会触发），但如果你需要精确的大整数 rowid，请用专门的 `SELECT last_insert_rowid()` 查询读取。
- **没有 OPFS 降级层。** OPFS/跨源隔离不可用时，`createWebAdapter()` 只有两种状态：完整 OPFS 持久化，或完全没有持久化的 `:memory:`。sqlite-wasm 提供了基于 `localStorage`/`sessionStorage` 的 `kvvfs` 后端，可作为中间层，但当前版本尚未接入——如果你需要在无法达到跨源隔离的部署环境里获得持久化，可以考虑接入它（见 [COOP/COEP](#opfs-持久化需要-coopcoep)）。

## 运行环境说明

以下是刻意的设计取舍，而非缺陷：

- **bfcache 冻结的标签页会一直持有数据库锁。** `singleTabLock` 基于 Web Locks API；被浏览器前进/后退缓存（bfcache）冻结（而非关闭）的标签页会持续持有锁，其他标签页会一直收到 `DbTabLockError`，直到被冻结的标签页被丢弃。真正关闭或崩溃的标签页，其锁会由浏览器自动释放。
- **没有 Web Locks API → 没有跨标签页协调。** 在老旧浏览器或非安全（非 HTTPS）上下文中，`singleTabLock` 会静默退化为不做协调：多个标签页可以同时打开同一个 OPFS 文件，竞争会在此后以 sqlite-wasm 抛出的可捕获的 "database is locked"（`SQLITE_BUSY`）错误形式暴露。
- **内存降级模式下刷新页面会丢数据。** OPFS 不可用且 `fallbackToMemory` 开启时，一切功能正常但不持久化。发生降级时适配器会发出 `logger.warn`——如果应用需要感知并向用户提示，请传入自己的 `logger`。

## 版本策略

本包处于 0.x 阶段：**minor 版本可能包含破坏性变更**（0.2.0 就给 `DbClient` 新增了必选方法 `executeBatch`，自定义 adapter/client 的实现会在编译期报错）。请锁定精确版本号，升级前阅读 [CHANGELOG](CHANGELOG.md)。

## 贡献

改动可发布代码的 PR 必须附带 changeset（`pnpm changeset`）——CI 会通过 `changeset status` 强制检查。纯文档或杂务类 PR 可以用 `pnpm changeset --empty` 豁免。

## 发布

发布由 CI 从 tag 触发，绝不从本地机器发出：

1. `pnpm changeset version`——根据待发布的 changeset 更新 `package.json` 版本号和 `CHANGELOG.md`，提交结果。
2. 给该提交打上与新版本一致的 `vX.Y.Z` tag 并推送。
3. `.github/workflows/release.yml` 会干净地 checkout 该 tag，重跑完整验证链（build、typecheck、lint、test、publint），并以 `--provenance` 发布。需要在仓库 secrets 中配置有发布权限的 `NPM_TOKEN`。
