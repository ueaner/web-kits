# Changelog

## 0.3.0

### Minor Changes

- 42cf6ac: `DbClient` gets a read-only `storage` that says where the data actually lives: `{ persistent: true }` on an OPFS file or Tauri, `{ persistent: false, reason }` when the web adapter fell back to memory (`"not-cross-origin-isolated"`, `"opfs-unsupported"`, `"opfs-unavailable"`, `"open-failed"`) and on the memory adapter (`"memory-adapter"`). Before `initialize()`, after `close()` and after a failed `initialize()` it is `{ persistent: false, reason: "not-initialized" }`, so it never claims persistence with nothing open. Apps can now tell the user their data won't be kept, instead of the fallback only showing up as a `logger.warn`.

  Also fixed: when the OPFS file failed to open and the web adapter fell back to memory, it kept the cross-tab lock it had taken for the OPFS file until `close()`, so that tab blocked every other tab from opening the database (`DbTabLockError`). It now releases the lock when it falls back.

  **Breaking for hand-written clients:** `storage` is a required member of `DbClient`, so a stub or wrapper that implements `DbClient` itself must add it (for example `storage: { persistent: true }`).

## 0.2.2

### Patch Changes

- e730427: 构建目标统一为 ES2022（`tsconfig.base.json` 的 `target`/`lib`，并显式声明
  `useDefineForClassFields: true`，避免将来下调 `target` 时类字段语义被静默改变）。

  对三个包的影响并不相同：

  - **`cross-tab-kit` / `cross-sqlite-client`：发布产物逐字节不变**，仅构建配置变化。
  - **`pending-task-kit`：`dist` 有实际变化**。ES2022 下 TS/oxc 直接输出**原生 class field**
    （`PendingTaskPoller` 的字段声明），并把这些字段上的 doc 注释作为普通注释保留下来：
    `dist` 体积从 27.10 kB 增至 29.45 kB。因此发布包的**最低 JS 引擎要求随之抬到 ES2022**
    （原生 class fields ≈ Chrome 74+ / Safari 14.1+ / Firefox 69+）。

  API 与运行时行为没有任何变化，但浏览器兼容基线变了，所以 `pending-task-kit` 记 `minor`。
  如果你的目标浏览器低于上面的基线、且构建流程不会对 `node_modules` 里的依赖做降级，
  请在打包阶段自行降级该依赖（或在 issue 里说明，我们可以为它单独设一个更低的 `target`）。

- ab25815: 可选依赖 `@tauri-apps/plugin-sql` 的版本范围从 `^2.4.1` 提升到 `^2.5.0`。API 无变化；仍锁在 2.4.x 的 Tauri 项目升级本包时，会被连带升级到 2.5.x。

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-09-20

### Changed

- sqlite-wasm optional dependency bumped to `^3.53.4-build1`（SQLite 内核 3.53.0 → 3.53.4，纯上游 bug 修复），`vitest` 等开发依赖同步更新
- package.json 声明 `engines: { node: ">=24" }`：库的运行时（浏览器/Tauri）不受影响，但 Node < 24 的使用方安装时会看到 EBADENGINE 警告

## [0.2.0] - 2026-09-19

### BREAKING CHANGES

- `DbClient` 新增必选方法 `executeBatch(statements)`。自己实现 `DbClient`/`DbAdapter`
  （而非使用内置 web/tauri/memory 适配器）的代码需要补上这个方法，TypeScript 会在编译期指出。
- `MigrationExecutor` 从裸函数类型变为带可选 `requiresSingleConnection?: boolean` 属性的接口。
  函数形态的赋值仍然兼容；自己管理 BEGIN/COMMIT 的自定义 executor 现在应通过该属性声明，
  而不再依赖文档约定。
- `DatabaseProvider` 在 `client` prop 变化后的重初始化窗口内会先回到完全未就绪状态
  （`dbClient: null`、`isDbReady: false`）——此前窗口期内会继续把旧 client 当作已就绪暴露。
  依赖旧行为（窗口期继续使用旧连接）的代码需要调整。

### Added

- `DbClient.executeBatch(statements)`：顺序执行一批语句，无跨语句事务保证。全部语句不带
  绑定参数时，web/memory 适配器将其拼成一条 SQL 单次执行（web 侧每条语句省一次 worker
  往返）；批内有任何带参语句则整批逐条执行。`defaultExecutor`（迁移默认执行器）与
  `transactionalExecutor` 已改走此路径。
- `createDbClient()` 新增 `pragmas` 选项：initialize 之后、迁移之前应用 PRAGMA 配置
  （如 `{ foreign_keys: true, journal_mode: "WAL" }`）。key 与字符串值均做白名单校验，
  非法值直接抛错而不是拼进 SQL。连接池型适配器（Tauri）上配置连接级 PRAGMA 时会
  `logger.warn` 提示其只对池中一条连接生效。
- `Logger` 类型与 `logger` 选项（`createDbClient()`、`runMigrations()`、
  `createWebAdapter()`）：库的诊断输出（OPFS 降级告警、worker 错误、schema 版本告警）
  可接入应用自己的日志系统，默认仍为 `console`。
- 新增 `DbMigrationError`（带 `.version`）：迁移失败时由 `runMigrations`/`createDbClient`
  抛出，底层错误包装在 `cause` 中。
- `runMigrations` 校验与告警：version 必须为唯一正整数；`tableName` 做标识符白名单校验；
  数据库已应用版本高于传入迁移列表最大版本时（应用回滚场景）告警；低于当前版本但从未
  应用过的"迟到迁移"（hotfix 补发场景）也会被点名告警，但不会被自动乱序补跑。
- `fallbackToMemory` 现在同样覆盖"OPFS 探测通过但打开数据库文件失败"的情况。
- web 适配器在 close 和初始化超时时会 terminate 自己创建的 Worker，避免重复 close/reopen
  累积孤儿 Worker。
- 测试补齐：迁移运行器、客户端生命周期、`executeBatch`、`pragmas`、初始化并发与重开、
  迁移失败路径、Tauri 适配器契约（mock plugin-sql）、React `DatabaseProvider`/`useDatabase`
  （含 StrictMode 双挂载与卸载竞态）。CI 矩阵覆盖 Node 20/22/24。
- CI（`.github/workflows/ci.yml`）：lint → typecheck → test → build → publint；
  PR 必须通过 changeset 门禁（`changeset status`，纯文档 PR 可用 `pnpm changeset --empty` 豁免）。
- 发布链路（`.github/workflows/release.yml`）：`vX.Y.Z` tag 触发，干净 checkout 后校验
  tag 与 package.json 版本一致、重跑完整验证链，以 `--provenance` 发布；配合 Changesets
  管理版本号与 CHANGELOG，`prepublishOnly` 兜底本地手动发布。
- `package.json` 增加 `"sideEffects": false`，利于 tree-shaking；新增
  `typecheck` 与 `pub:check` 脚本。

### Fixed

- **web 适配器的 SQL 错误此前不会被包装成 `DbExecutionError`**：sqlite-wasm 的 promiser 对
  错误响应是 reject（裸对象）而非 resolve error 型响应，旧的 `response.type === "error"`
  检查全部是死代码，SQL 错误以非 Error 的普通对象逃逸，`instanceof`/`.message` 全部失效。
  现在 exec/executeBatch/open 统一按真实 reject 语义包装。
- 迁移（或 PRAGMA）失败时 `createDbClient` 会先关闭已打开的连接再向上抛错——此前会泄漏
  worker/OPFS 文件句柄/跨标签页锁，应用内重试可能撞上自己持有的资源（如 `DbTabLockError`）。
- 三个适配器的 `initialize()` 并发调用共享同一个进行中的初始化 Promise，不再各自跑一遍
  完整流程并互相覆盖状态；失败后仍可重试。
- `close()` 与进行中的 `initialize()` 交错时不再静默 no-op（此前会留下没人持有句柄的连接
  和标签页锁）：close 会先等初始化落定再关闭。并发 `close()` 只会真正关闭一次。
- `close()` 之后重新 `initialize()` 会打开全新连接（竞态修复曾一度让重开返回已关闭的
  client，已在发布前修正）。
- `executeBatch` 拼接路径对不带结尾分号、或以 `--` 行注释结尾的语句也能正确工作。
- 迁移版本记录的 `applied_at` 改由 JS 侧传入（`Date.now()`），不再依赖 SQLite 3.42+ 的
  `strftime('%s','subsec')`。
- web 适配器 `close()`：promiser 调用的 promise 级 reject 也统一包装为 `DbCloseError`。

## [0.1.0] - 2026-09-18

首次公开发布：统一的 `DbClient` 接口、版本化迁移框架（`runMigrations`）、
web（sqlite-wasm/OPFS）/ Tauri（plugin-sql）/ memory 三个适配器、React 绑定
（`DatabaseProvider`/`useDatabase`）、跨标签页锁（Web Locks API）与类型化错误体系。
