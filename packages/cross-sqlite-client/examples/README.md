# cross-sqlite-client 示例：便签（notes）

一个基于 `cross-sqlite-client` + sqlite-wasm + OPFS 的迷你便签应用，演示库的初始化、迁移、写入通知和自动刷新的查询、持久化降级与单标签页锁。

## 启动

仓库根目录：

```bash
pnpm example:csc
```

或在本目录：

```bash
pnpm dev
```

两个命令都会先构建 `cross-sqlite-client` 库再启动 Vite，打开 http://localhost:5176/ 。

## 演示点

- **初始化**：`createDbClient()` 的 Promise 交给 `<DatabaseProvider>`。组件里用 `useDbClient()` 拿 client：没就绪时 `<Suspense>` 显示「数据库初始化中…」，失败时错误边界（`src/DbErrorBoundary.tsx`）接手。
- **迁移**：`src/migrations.ts` 定义了两个版本——v1 建 `notes` 表，v2 建索引和 `note_meta` 表。所有语句幂等（`CREATE ... IF NOT EXISTS`；SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，所以不用 `ALTER TABLE`）。迁移经 `transactionalExecutor` 包在事务里执行（web 适配器是单连接，安全）。状态面板用 `useDbQuery` 查询 `schema_version` 表展示已应用的版本。
- **写入通知和自动刷新**：便签列表是 `useDbQuery(["notes"], …)`。新增、删除以后没有任何手动刷新的代码：`client.onWrite` 通知以后，列表在 transition 里重新查询，查完之前旧列表一直显示。日志区每次写入都会出现一行「onWrite：有写入」。
- **`groupWrites`**：「批量 10 条」在一个手写事务里插入十条，整个事务放在 `client.groupWrites` 里：日志里只有一行写入通知，而且在 `COMMIT` 之后。
- **持久化与降级**：状态面板显示 `client.storage`。数据写入 OPFS 时，**添加便签后刷新页面，数据仍在**；OPFS 不可用时静默降级为 `:memory:`，刷新即丢，日志区会有降级告警。
- **单标签页锁**：**在第二个标签页打开同一 URL**。锁模式是 `"fail"`（默认）时，它立即以 `DbTabLockError` 失败；切到 `"wait"` 时，它排队等第一个标签页关掉，最多等 10 秒（`AbortSignal.timeout`），关掉第一个标签页它就自己打开了。
- **重试**：出错时点击「重试」——按库的约定创建一个新的 client Promise 传给 `DatabaseProvider`，同时换掉错误边界的 `key`。
- **事件日志**：右侧面板（最新在前，最多 50 条）记录初始化进度、迁移执行、OPFS 降级告警、锁错误、写入通知和每次增删操作。

## OPFS 与跨域隔离响应头

sqlite-wasm 的 OPFS 持久化要求页面处于跨域隔离状态，即响应必须携带：

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

本示例的 `vite.config.ts` 已为 dev 和 preview 配好这两个响应头（同时 `optimizeDeps.exclude` 了 `@sqlite.org/sqlite-wasm`）。

注意事项：

- **用其它方式伺服会失去持久化**：直接双击打开 `dist/index.html`（file://），或用不带上述响应头的静态服务器，页面不再跨域隔离，OPFS 不可用，库会静默降级为内存模式——界面照常工作，但刷新后数据丢失（日志区有降级告警）。
- **COEP 会拦截跨域资源**：`require-corp` 下，页面引用的跨域图片/脚本/字体必须带 `CORP`/`CORS` 响应头，否则会被浏览器拦截。本示例无跨域资源，接入第三方资源时需留意。
- 验证持久化：添加几条便签 → 刷新页面 → 便签仍在（且迁移版本仍为 1, 2，不会重复执行）。
