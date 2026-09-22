# pending-task-kit 可借鉴清单（面向 cross-sqlite-client）

> 对象 A：`pending-task-kit` v0.5.0（`/home/ueaner/projects/frontend/pending-task-kit`，下称 PTK）
> 对象 B：`cross-sqlite-client` v0.2.1（`/home/ueaner/projects/frontend/cross-sqlite-client`，下称 CSC）
> 基线验证（本文所有结论的实测前提）：
> `vitest run` → **45 passed / 5 files / 3.60s**；`tsc --noEmit` → 干净；`oxfmt --check` → 干净；Node **24.21.0**（且 `typeof navigator.locks === "object"`，这一点后面很关键）。

---

## 0. 结论速览

先给一个可能出乎意料的判断：**这两个库是同一套纪律下的产物，CSC 在若干方面还领先 PTK。** 所以本文比"PTK vs math-kid"那份窄得多——真正值得借的只有 **6 条缺口 + 1 组顺手项**，其余是"已经对齐，不要重复劳动"的确认。

| #   | 借什么                                           | 优先级 | 成本           | CSC 现状                                          |
| --- | ------------------------------------------------ | ------ | -------------- | ------------------------------------------------- |
| 1   | 真实浏览器 e2e 覆盖 web 适配器                   | **P0** | 1–2 天         | ❌ web 侧关键行为在任何环境下零覆盖               |
| 2   | 诊断通道自身抛错不得拖垮被诊断的路径             | **P1** | 1 小时         | ❌ 7 处 `logger.*` 全部裸调，0 处 try/catch       |
| 3   | 降级状态要可编程读取，而不是只写日志             | **P1** | 半天           | ⚠️ 只有 `logger.warn`，接口无法表达"没有持久化了" |
| 4   | 独占锁的粒度：贴着临界区，而不是整个连接生命周期 | **P1** | 1–2 天（设计） | ⚠️ 已文档化 bfcache 后果，但未解决                |
| 5   | 评审/决策文档留在库仓库内 + 轮次台账格式         | **P2** | 2 小时         | ❌ 评审文档在消费方（math-kid）仓库里             |
| 6   | best-effort 吞掉的错误也要进诊断通道             | **P2** | 1 小时         | ❌ 3 处静默 `catch(() => {})`                     |
| 7   | 顺手：CHANGELOG 与 ci.yml 已漂移等 3 处          | **P2** | 15 分钟        | ❌ 见 §7                                          |

**先明确"不必借"的部分**（避免把 PTK 的领域当模板）：

- ❌ 任务轮询、TTL 任务过期、失败退避、结果通知——CSC 没有这个域。
- ❌ `PendingTaskLogger` 的具体形状——CSC 的 `Logger`（`warn` + `error`）**比 PTK 的（只有 `warn`）更完整**，不要降级。
- ❌ PTK 的 `hasUnpersistedWrites` 这个**具体字段**——但要借它背后的**模式**（见 §4）。
- ❌ PTK 的 `pollLeaseTtlMs` / `createLeadershipGate` 实现——CSC 的问题（OPFS 文件句柄）与 PTK 的问题（重复网络请求）不同，直接照搬会引入 PTK 自己都要用 fencing 兜住的复杂度（见 §5 的取舍说明）。
- ❌ 覆盖率工具——PTK 也没有。这不是"PTK 有而 CSC 没有"的项。

---

## 1. 关系定位：CSC 是同学，不是学生

这一点必须先讲清楚，否则下面的清单会被误读成"CSC 很糙"。把两边的共同点列出来，能立刻看出这是同一个作者、同一套方法论的两次应用：

| 实践                                                                                                                      | PTK                      | CSC                                                          |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------ |
| Changesets + `CHANGELOG` + `.changeset/config.json`                                                                       | ✅                       | ✅                                                           |
| CI 阶梯：lint → format:check → typecheck → test → build → `publint`                                                       | ✅                       | ✅                                                           |
| PR 的 `changeset status` 门禁                                                                                             | ✅                       | ✅                                                           |
| tag 触发发布 + 干净 checkout + tag↔版本号校验 + `--provenance`                                                            | ✅                       | ✅                                                           |
| `prepublishOnly` 兜底 + `pub:check`(publint)                                                                              | ✅                       | ✅                                                           |
| oxfmt + `format:check` 进 CI                                                                                              | ✅                       | ✅                                                           |
| Dependabot 冷却期（`cooldown.default-days: 3`）+ dev 依赖分组                                                             | ✅                       | ✅                                                           |
| `package.json` 元数据齐备（`license`/`repository`/`keywords`/`engines`/`packageManager`/`sideEffects`/`exports`/`files`） | ✅                       | ✅                                                           |
| 可选 peer（`peerDependenciesMeta.optional`）+ 子路径导出                                                                  | ✅                       | ✅                                                           |
| 双语 README，章节一一对齐                                                                                                 | ✅                       | ✅（EN 19 节 / ZH 19 节，逐节对应）                          |
| README 有「运行时取舍」专属章节，且注明"是取舍不是 bug"                                                                   | ✅                       | ✅（`Runtime environment notes`）                            |
| README 有"已知限制/刻意不做"章节                                                                                          | ✅                       | ✅（且 CSC 的 `Known limitations` **给了具体数字**，更好）   |
| 可注入诊断通道，默认 `console`                                                                                            | ✅                       | ✅                                                           |
| 构造期非法配置 fail-fast                                                                                                  | ✅ `RangeError`          | ✅ 带正则说明的 `Error`                                      |
| 失败时清理已获取的资源                                                                                                    | ✅ `finally` 顺序教训    | ✅ `createDbClient` 的 catch-close + `close()` 先清零再关闭  |
| 并发 `initialize()` 去重 / 单实例纪律                                                                                     | ✅ `activePollerByStore` | ✅ 缓存进行中的 `initPromise`                                |
| 单一写入收口（跨切面不变量只有一处实现）                                                                                  | ✅ `writeTasks`          | ✅ `executeBatch` / `close()` 状态清零顺序                   |
| 注释写"为什么/改坏会怎样"，并标注 bug 修复点                                                                              | ✅                       | ✅（`web.ts:156-159` 的 `"\n;\n"` 分隔符取舍是最典型的例子） |
| 测试用例名写成行为契约                                                                                                    | ✅                       | ✅                                                           |
| 测试用真实引擎而非 mock                                                                                                   | ✅（真实 Chromium）      | ✅（`createMemoryAdapter` 跑真 sqlite-wasm）                 |

**CSC 反超 PTK 的地方**（列出来是为了说明"不要反向污染"）：

1. `Logger` 接口有 `warn` **和** `error`；PTK 只有 `warn`。
2. `assertIdentifier` + `PRAGMA_VALUE_RE` 双白名单，任何拼进 SQL 的标识符/枚举值都被校验——PTK 没有拼 SQL 的场景，也就没有这一层。
3. 类型化错误层次带结构化字段：`DbExecutionError.sql/.params`、`DbMigrationError.version`、全部带 `cause`。
4. `release.yml` 有 `concurrency` 组（PTK 没有）。
5. `Known limitations` 给出可操作的具体数字与替代方案（`2^53-1` 精度、`kvvfs` 作为缺失的中间层）。
6. 测试防 flake 手法：`describe.skipIf(!hasWebLocks)` + `vi.waitFor`（注释解释"规范不保证一个 macrotask 内完成"）。PTK 的 e2e 反而没有 skipIf 守卫。

结论：下面的 6 条都是**真缺口**，不是风格差异。

---

## 2. 【P0】真实浏览器 e2e：这是唯一一条大缺口

### 2.1 现在到底测到了什么

45 个用例的分布：

| 文件                    | 用例 | 跑在哪个环境 | 测的是                                                                |
| ----------------------- | ---- | ------------ | --------------------------------------------------------------------- |
| `test/client.test.ts`   | 11   | node         | `executeBatch` / 生命周期 / `pragmas`，**经 `createMemoryAdapter()`** |
| `test/migrate.test.ts`  | 16   | node         | 迁移运行器、executor 约束、版本校验，**经 memory 适配器**             |
| `test/tauri.test.ts`    | 9    | node         | Tauri 适配器**契约**（mock `@tauri-apps/plugin-sql`）                 |
| `test/react.test.tsx`   | 7    | jsdom        | `DatabaseProvider` / `useDatabase`（含 StrictMode 双挂载）            |
| `test/tab-lock.test.ts` | 2    | node         | `tryAcquireTabLock` 的**同进程内**锁仲裁                              |

一个必须先纠正的直觉：`tab-lock.test.ts` **不是在跳过状态**。Node 24 真的实现了 `navigator.locks`（实测 `typeof navigator.locks === "object"`），所以 `describe.skipIf(!hasWebLocks)` 判定为"有"，两个用例真的在跑、真的在通过。这对 CSC 是好消息——但也正因如此，**没有人在 CI 里看到过任何一条 "skipped"，于是更容易以为多标签页这件事已经被测住了**。

实际没有被任何环境覆盖的行为，全部集中在 `src/adapters/web.ts`（381 行）：

- OPFS 探测（`getDirectory()` + `getFileHandle("test_opfs_support")` + `removeEntry`）
- `crossOriginIsolated` 判定，以及它带来的 `:memory:` 回退
- **两条** `fallbackToMemory` 分支：`web.ts:241-264`（探测阶段）与 `web.ts:311-322`（"探测通过但真打开失败"）
- `DbTabLockError` 的端到端路径（`web.ts:270-281`）——包括"锁请求本身抛 SecurityError 时要包成 `DbInitializationError`、而 `DbTabLockError` 必须原样抛出"这条精细契约
- worker 启动的 `Promise.race` 超时兜底（`web.ts:292-309`）与 `createWorker()` 失败回退（`web.ts:210-223`）
- `close()` 的 worker `terminate()` 与标签页锁释放（`web.ts:176-207`）
- promiser reject 形态的包装——**0.2.0 修的那个"错误包装全是死代码"的 bug 就属于这一类**（`CHANGELOG.md` 的 Fixed 第一条）

还有一个更具体的证据，说明"用 memory 覆盖契约"掩盖了真实缺口：`executeBatch` 的无绑定参数拼接逻辑在 **两个文件里各写了一份**——`adapters/memory.ts:54-59` 与 `adapters/web.ts:154-168`——而测试只覆盖前者。`CHANGELOG.md` 0.2.0 记着"拼接路径对不带结尾分号、或以 `--` 行注释结尾的语句也能正确工作"这条修复，**在 web 侧目前没有任何回归保护**。

### 2.2 PTK 的 e2e 骨架可以直接搬

PTK 当初加 e2e 的理由几乎是为 CSC 写的：

> `pnpm test:e2e` 会跑一个基于真实 Chromium 的小型 Playwright 套件，专门验证跨标签页 `navigator.locks` 仲裁和真实的 `storage` 事件——**这正是基于 jsdom 的 `pnpm test` 那套测试结构性做不到的事**。（`README.zh-CN.md:365-368`）

可直接复用的骨架：

```
test-e2e/
  fixture.html          # 一个只给 e2e 用的最小页面
  fixture.ts            # 在 window 上挂出测试需要驱动的入口
  tsconfig.json         # { "extends": "../tsconfig.json", "include": [".", "../playwright.config.ts"] }
playwright.config.ts
```

四个值得连注释一起抄的设计决定：

1. **串行、确定性**（`playwright.config.ts`）：

   ```ts
   // These tests race two/three real tabs against each other over a shared localStorage key —
   // running them in parallel with each other (or retrying flakily) would make failures
   // ambiguous, so keep this suite small, sequential, and deterministic instead.
   fullyParallel: false,
   workers: 1,
   ```

   对 CSC 同样成立：两个用例同时去抢同一个库的锁，失败原因会变得不可判定。

2. **`webServer` 用 vite**，而不是自己写静态服务器。

   > ⚠️ **CSC 特有的坑，必须写进配置注释**：PTK 用 vite 只是为了让它解析裸模块说明符；CSC 要真跑 OPFS，**dev server 必须发 `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`**。否则 `window.crossOriginIsolated` 恒为 `false`，适配器会**静默**走内存分支，于是"OPFS 持久化"的 e2e 变成了一条永远测内存的假测试——而且它是绿的。这是我在这次审计里认为最容易踩、后果最隐蔽的一个点。

3. **fixture 故意 import 构建产物而非源码**（`test-e2e/fixture.ts:1-7`）：

   ```ts
   // Imports the built `dist/index.js` deliberately, not `src/`, so
   // this also doubles as a build-output smoke test.
   import { createPendingTaskStore, PendingTaskPoller } from "../dist/index.js"
   ```

   对 CSC 的价值更大：CSC 有 5 个子路径导出（`.`/`./adapters/{web,tauri,memory}`/`./react`/`./package.json`）。e2e 从 `dist` 导入，等于顺带验证了"`exports` 映射真的能解析"——这是 `publint` 查不出的运行时那一半。

4. **test 侧的环境隔离**：PTK 每个用例用独立的 `storageKey`/`pollLeaseKey`（注释："so the three tests never contend with each other even though they all share the same browser's localStorage origin"）。CSC 的对应物是每个用例独立的 `name`（即独立的 OPFS 文件名）与 `lockName`。另外 PTK 在测试里**显式给足超时**而不是用默认值，并解释了原因：

   > on a loaded CI runner, either tab's event loop stalling for just over 200ms between renewals would let the other tab legitimately (if unexpectedly, for this test's purposes) take over mid-run.

   CSC 的同类参数是 `timeoutMs`（默认 15000）——CI 上等 worker 就绪可能很慢，别用默认值卡在边界。

配套的四处工程改动：

- `vitest.config.ts` 加 `exclude`，**连注释一起抄**：

  ```ts
  // test-e2e/ holds Playwright specs (a different `test()` global) — Vitest's default glob
  // would otherwise pick those up too and collide with Playwright's own test runner.
  exclude: [...configDefaults.exclude, "test-e2e/**"],
  ```

- `typecheck` 覆盖第二个 tsconfig：PTK 是 `tsc --noEmit && tsc --noEmit -p test-e2e`。**注意它的顺序陷阱**：PTK 的 CI 里 `build` 必须在 `typecheck` 之前，因为 test-e2e 的类型检查要对着 `dist/` 里的 `.d.ts`——这条 PTK 在 commit message 和 workflow 注释里都写明过（`b7fd4cc`）。CSC 的 e2e 若也从 `dist` 导入，会继承同样的顺序约束。
- CI 加独立 e2e job：`needs: check`（慢的放在快的后面给信号）、Playwright 浏览器缓存**按 lockfile 哈希键控**而不是按版本号（PTK 注释："so a browser revision bundled with a given @playwright/test release always invalidates correctly"）、失败才 `upload-artifact` 报告、`retention-days: 7`。
- `README.md` 的 Testing 一节补一句"web 适配器的行为由 `pnpm test:e2e` 覆盖"——现在那一节只说了 `pnpm test` 覆盖迁移运行器/生命周期/React 绑定，读者无从知道 web 侧是没有覆盖的。

### 2.3 建议的最小 e2e 用例清单

按"能证明一件 jsdom/node 证明不了的事"来选，6 条足够：

1. **双 tab 争锁**：第二个真实文档 `initialize()` → 抛 `DbTabLockError`，且 `instanceof` 成立、`cause` 未被吞掉。
2. **锁真的会释放**：第一个 tab `close()` 后，第二个能成功打开（证明 `web.ts:194` 的 `releaseTabLock?.()` 有效，而不是靠"反正浏览器会回收"）。
3. **OPFS 真的持久化**：写入 → `close()` → 重新 `initialize()` → 数据仍在。**这一条是 `:memory:` 永远证明不了的**，也是 README 里 COOP/COEP 承诺的直接兑现。
4. **降级可观测**：一个**故意不发** COOP/COEP 的页面（或直接 stub `crossOriginIsolated`）→ 走内存分支，且传入的自定义 `logger.warn` 被调用（把 §3 的改动一起验了）。
5. **`fallbackToMemory: false` 的失败语义**：缺少隔离 → 抛 `DbInitializationError`（而不是别的类型）。
6. **真实 worker 里的迁移 + 拼接路径**：跑一次 `runMigrations`，其中一条迁移语句**不带结尾分号**、另一条以 `--` 注释结尾——把 `memory.ts` 与 `web.ts` 两份拼接实现都钉住。

---

## 3. 【P1】诊断通道自身抛错，不得拖垮它正在诊断的路径

### 3.1 现状（已实测）

`src/` 里共 **7 处** 诊断调用，**0 处** try/catch：

```
src/adapters/web.ts:247   logger.warn("[Web DB] OPFS is not fully supported ... Falling back to in-memory mode.")
src/adapters/web.ts:261   logger.warn("[Web DB] OPFS initialization failed ... Falling back to in-memory mode.", opfsError)
src/adapters/web.ts:290   onerror: (...args) => logger.error("[Web DB] sqlite3Worker1Promiser error:", ...args)
src/adapters/web.ts:317   logger.warn("[Web DB] Failed to open the OPFS database. Falling back to in-memory mode.", ...)
src/core/index.ts:48      logger.warn("[PRAGMA] This adapter uses a connection pool; ...")
src/core/migrate.ts:80    logger.warn("[Migrations] Database schema version ... is newer than ...")
src/core/migrate.ts:90    logger.warn("[Migrations] ... migration(s) ... are being skipped: ...")
```

### 3.2 为什么这在 CSC 这里不是理论问题

PTK 的规则（多处注释，措辞统一）：

```ts
// A diagnostic channel must never take down the code path it's diagnosing.
try { logger.warn(...) } catch { /* ... */ }
```

在 PTK 那里，最坏后果是"少一条告警"。**在 CSC 这里最坏后果是相反的**——因为 CSC 的 README 明确把 logger 当成**检测降级的手段**：

> The adapter emits a `logger.warn` when this happens — **pass your own `logger` if the app needs to detect it** and warn the user。（`README.md`，Runtime environment notes）

于是链路变成：

1. 用户按 README 建议传了自定义 `logger`（典型实现会把消息上报到某个端点，或 `JSON.stringify` 后写库）；
2. OPFS 不可用 → 走到 `web.ts:247`，准备降级到内存（这是**为了保住应用可用性**而存在的分支）；
3. 自定义 logger 抛错（上报网络抖动、参数里有循环引用、logger 自己依赖了还没初始化的东西）；
4. 异常从 `doInitialize` 冒到 `web.ts:325-336` 的 catch → 被包成 `DbInitializationError` 抛出。

**净效果：那句"通知你已降级"的日志，亲手杀死了降级。** 而且异常类型还是误导性的（`DbInitializationError` 让人以为数据库起不来，实际是日志系统的问题）。

`migrate.ts:80/90` 同理：应用回滚（数据库版本高于代码）或 hotfix 补发场景下的告警，会把迁移整体中断——包括本该正常执行的那部分。

### 3.3 修法

加一个内部小工具，只包 try/catch，**并把理由写在注释里**：

```ts
// 诊断通道绝不能拖垮它正在诊断的代码路径：调用方传进来的 logger 可能是遥测实现
// （网络上报、JSON.stringify 参数、依赖尚未初始化的模块），它抛错不该把一个
// "OPFS 不可用 → 降级内存" 的良性分支变成一个 DbInitializationError。
function safeWarn(logger: Logger, message: string, ...args: unknown[]): void {
  try {
    logger.warn(message, ...args)
  } catch {
    /* 见上 */
  }
}
function safeError(logger: Logger, message: string, ...args: unknown[]): void {
  try {
    logger.error(message, ...args)
  } catch {
    /* 见上 */
  }
}
```

`web.ts:290` 的 `onerror` 尤其要包——它是在 worker 的错误回调里，抛出去会污染 worker 的消息处理循环。7 处全部换掉，改动量约 20 行。

顺带值得抄的一条测试（PTK 有，`test/engine.test.ts`）：

```
it("a throwing logger takes down neither a duplicate start() nor the tick that warns")
```

CSC 的对应版本应该是：`logger.warn` 抛错时，`createWebAdapter()` 仍然成功降级到内存并返回可用的 client。这条测试同时钉住了行为和 §3.2 的推理。

---

## 4. 【P1】降级状态要可编程读取（借 PTK 的"标志"模式，不是它的字段）

### 4.1 PTK 的模式

`hasUnpersistedWrites` 是 `PendingTaskStore` 上的一个**公开只读、单一事实源**的布尔值，文档注释把用途讲得很具体：

> True when the most recent write to this store's localStorage entry threw ... While true, persisted storage no longer reflects this tab's in-memory state, so anything about to rebuild `tasks` from a freshly-read persisted snapshot should build on `getState().tasks` instead ... Flips back to `false` as soon as a write ... succeeds again.

三个要点值得原样搬过来：**(a) 它是可读的状态，不是日志；(b) 它是"当前状态"而非"曾发生过"（写成功会翻回 false）；(c) 它是唯一写入点，注释明确要求外部"treat it as read-only"**。

### 4.2 CSC 的缺口

CSC 有两处降级，都只有"写日志"这一条出口：

| 降级                                | 代码                        | 应用能知道吗                            |
| ----------------------------------- | --------------------------- | --------------------------------------- |
| OPFS 不可用 / 打开失败 → `:memory:` | `web.ts:241-264`、`311-322` | 只能靠传 logger 解析字符串              |
| 无 Web Locks → 锁退化 no-op         | `web.ts:61-64`              | **完全不能**——这条路径根本没调用 logger |

第二行是更尖锐的问题：`web.ts:61-64`

```ts
if (typeof navigator === "undefined" || !navigator.locks) {
  // 不支持 Web Locks API 的环境（老浏览器、非浏览器测试环境）：跳过协调，行为等同于未启用
  return () => {}
}
```

返回的 no-op 是**真值**，所以 `doInitialize` 里 `if (!release) throw new DbTabLockError()` 不会触发——即"拿到了锁"。结果：单标签页独占这个承诺**静默失效**，而且没有任何运行时信号（README 的 `Runtime environment notes` 写了这一点，但文档不是信号）。

而 `Logger` 接口只有 `warn` / `error`，没有 info/debug 档，也**没有任何渠道能表达"现在没有持久化"**——一个应用无法在用户玩了 40 分钟之后、刷新之前，说一句"本局成绩不会被保存"。

### 4.3 建议的 API（非破坏性）

最小改法，二选一或都做：

```ts
// 方案 A：让 client 可自省（PTK 的 hasUnpersistedWrites 形状）
export interface DbClient {
  // ...
  /** 本次连接实际落在哪种存储上。":memory:" 表示刷新即丢，调用方应据此提示用户。 */
  readonly mode: "opfs" | "memory" | "tauri" | "unknown"
  /** Web 适配器：跨标签页独占锁是否真的生效（Web Locks 缺失时为 false）。 */
  readonly tabLockHeld: boolean
}

// 方案 B：把"降级"变成事件，让应用能反应而不只是记录
createWebAdapter({ onDegraded: (reason: "no-opfs" | "open-failed" | "no-web-locks") => { ... } })
```

方案 A 更贴近 PTK 的取舍（一个可读的当前状态 + 唯一写入点），也更容易测。**注意 PTK 的教训 (b)**：`mode` 在 `close()` 后应回到"未初始化"，而不是留着上一条连接的值——PTK 专门为"写成功要翻回 false"写了注释，就是防止这类状态漂移。

`Logger` 是否要加 `info` 档：**不建议**（属于范围蔓延）。用 `onDegraded` 或 `mode` 表达状态，比让应用去解析日志字符串正确得多。

---

## 5. 【P1，设计取舍】独占锁的粒度：贴着临界区，而不是整个连接生命周期

这一条要小心表述：**它是取舍，不是"抄 PTK"**。但正因为 CSC 自己的文档已经把前提条件写清楚了，可以推出一条挺强的结论。

### 5.1 CSC 的现状

`web.ts:270-281`：锁在 `initialize()` 里获取，持有到 `close()`。README 的 `Runtime environment notes` 诚实地记录了后果：

> **bfcache-frozen tabs hold the database lock.** ... a tab frozen by the browser's back/forward cache (rather than closed) keeps holding its lock, so other tabs keep getting `DbTabLockError` until the frozen tab is discarded.

即：`DbTabLockError` 是**终止性**的（第二个标签页彻底不可用），而 bfcache 会让这个不可用状态**无限期延长**，用户几乎不可能自己诊断（"另一个标签页在用"——哪个？那个看起来已经关掉了的？）。

### 5.2 关键前提：CSC 自己说了并发不会损坏数据

同一份 README 的 Multi-tab coordination 一节：

> sqlite-wasm's `opfs` VFS has its own locking protocol, so two tabs writing to the same OPFS-backed file **won't corrupt data and generally won't hang** — the losing tab just gets a catchable "database is locked" SQL error.

`web.ts:16-19` 的源码注释说得更细（`xLock`/`xUnlock` 走 SharedArrayBuffer + `Atomics.wait()`，冲突重试后返回 `SQLITE_BUSY`）。

**据此可以推出**：既然并发本身是安全的，那么"独占整个连接生命周期"就**不是正确性所必需的**——它买到的是**错误更早、语义更明确**（fail fast，而不是某次随机查询报 `database is locked`）。这个收益是真的，但代价是"第二个标签页完全不可用，且可能永久不可用"。这是一次 UX 换 UX 的交换，而不是"安全换便利"。

### 5.3 PTK 的两条对应经验

**(a) 锁的粒度应该贴着临界区，不是贴着生命周期。** PTK 的 leader 租约只在"真的要发网络请求"前才去 claim/renew（`engine.ts:740-750` 的注释解释得很清楚：被便宜的本地判断跳过的任务"never touch this, so they don't cost a localStorage round trip"）。映射到 CSC：真正必须独占的是 **"探测 + 打开 + 迁移"这段 schema 变更窗口**；迁移完成、schema 已就绪之后，独占就不再必要。

**(b) 一旦引入 TTL 就必须配 fencing。** PTK 的 `reconfirmLeadership` 存在的唯一理由就是"锁会自己过期"，所以任何基于租约的写入都必须校验代际，否则会出现"旧持有者的迟到写入覆盖新持有者"。**注意这里的边界**：纯 Web Locks 是**无过期、由浏览器保证串行**的原语，所以 CSC 现在**不需要** fencing。这意味着一个具体的警告：**如果为了 bfcache 问题给锁加 TTL/心跳，就必须同时把 fencing 补上**，否则会把一个"可用性问题"换成一个"数据正确性问题"。

### 5.4 如果要做，先写成设计方案

建议的路径（**不要直接改代码**）：

1. 先写一份设计方案文档（模板见 §6.3），回答：锁的作用域能不能缩到"迁移窗口"？缩了之后，一个**带着更旧迁移列表**的标签页能否在锁释放后打开同一个文件？如果能，需要什么样的"schema 已就绪"跨标签页握手（或直接约定"多标签页必须同版本"）？
2. 明确列出**不打算解决**的情况（比如"不同版本的 tab 并存"），写进 README 的 `Runtime environment notes`。
3. §2 的 e2e 先行：先用"双 tab 争锁 / close 后可获取"两条用例把**当前**行为钉住，再改动。否则改锁语义时没有任何回归网。

**不要**照搬 PTK 的 `createLeadershipGate`：PTK 的 leader 只做网络请求，代价是"少发一次请求"；CSC 共享的是一个 OPFS **文件句柄**，代价模型完全不同。这一点值得在方案文档里写明，避免后来者（或 AI）看到"PTK 有租约"就照抄。

---

## 6. 【P2】把评审与决策文档留在库仓库里

### 6.1 现状

CSC 仓库里没有任何评审文档——只有 `CHANGELOG.md`。而**已经写好的两份评审报告在消费方仓库里**：

- `math-kid/docs/cross-sqlite-client-implementation-review.md`
- `math-kid/docs/cross-sqlite-readme-review.md`

这是个位置问题，不是内容问题。库的行为、契约、取舍的评审记录，应该跟着库走：消费方可能换、可能私有化、可能不再维护，而"当初为什么这么设计"的需求一直存在。

PTK 的做法是把评审文档当**决策记录**留在库仓库内（`production-readiness-review.md`、`code-review-0.2.0.md`、`code-review-2026-09-18.md`、`cross-tab-kit-0.3.0-integration.md`），并形成了稳定的结构。

### 6.2 可直接抄的三个结构

**(a) 结论先行 + 严重度分级**——不让读者自己判断：

```
## 结论：不建议直接推送 —— 1 个 Blocker + 3 个 Major

## Blocker
### B1. 新 CI 跑不起来：`pnpm/action-setup@v4` 缺少版本来源
```

**(b)「优先级 / 成本 / 状态」行动建议表**（`production-readiness-review.md:84-95`）：

| 优先级         | 事项                                                                          | 成本              | 状态                  |
| -------------- | ----------------------------------------------------------------------------- | ----------------- | --------------------- |
| ~~发布前必修~~ | ① exports CJS 类型                                                            | —                 | ✅ 已解决（移除 CJS） |
| 发布前必修     | ② `readPersistedTasks` 走 `safeGetItem` + `isChecking` 先于 `flushBatch` 复位 | 各几行 + 一个单测 | ✅ 第七轮已修         |

这张表把评审报告变成**可跟踪的台账**，而不是一次性文档。

**(c) 逐项核对 + 附录：审查历史**——多轮评审时，每轮先核对上一轮的问题真的修好了没，最后附完整脉络：

```
## 附录：审查历史
- 第一至三轮（code-review-2026-09-18.md）：跨标签页 leader 选举 + result relay（提交 2be6c90）
- README 轮：dedupe key 文档修正（提交 f97507c）
- 第四至六轮（code-review-0.2.0.md）：0.2.0 生产化加固（提交 cfccfdf）
- 本轮：生产级就绪深评（本文件）
```

PTK 的附录本身就是 CSC 的一份现成模板：CSC 有 `c22a727`（首次发布）→ `ffe0ce7`…`d688cd1`（0.2.1）这条清晰的历史，配上"哪一轮发现了什么、怎么验证的"，0.2.0 那个"错误包装全是死代码"的 bug 就有过程记录，而不是只在 CHANGELOG 里一行结论。

**(d) 一条具体的检查项值得加进 review 清单**：**CHANGELOG / README 与代码的一致性**。PTK 第七轮专门把"CHANGELOG 漏记 CJS 移除"标为 **Major** 并修复。CSC 现在正好有同类漂移——见 §7。

### 6.3 附：一件顺手能做的事

PTK 的 `cross-tab-kit-0.3.0-integration.md`（227 行）是"动手前先写方案"的范本，结构是：

```
## 0. 0.1.0 → 0.3.0 的关键 API 事实（方案的事实基础）
## 1. 依赖与配置
## 2. safe-storage 改用 cross-tab-kit/advanced
## 3. engine.ts 选举机制重写（核心）  3.1 删除  3.2 新增  3.3 ...
## 4. 测试调整
## 5. 可观察行为变化（写进 changeset，minor）
## 6. 文档更新
## 7. 实施顺序与验证
```

两个可复用的要点：**第 0 节先把依赖方的真实 API 行为钉死**（避免方案建立在记忆上）；**第 5 节把"可观察行为变化"单列并指明要写进 changeset**——这正是 §5 那种锁语义改动需要的护栏。

---

## 7. 【P2】best-effort 吞掉的错误也要进诊断通道，以及 3 处顺手项

### 7.1 三处静默 `catch`

| 位置               | 代码                                                          | 为什么值得一条告警                                                                                                                                            |
| ------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/index.ts:65` | `await client.close().catch(() => {})`                        | 原始错误优先是对的，但"关闭也失败了"意味着 worker/OPFS 句柄/标签页锁可能真的泄漏了——这正是同一段注释想防的事                                                  |
| `web.ts:253`       | `await root.removeEntry("test_opfs_support").catch(() => {})` | 探测垃圾文件删不掉 → 每次初始化累积一个垃圾文件；低危但完全无声                                                                                               |
| `web.ts:371`       | `await db.execute("ROLLBACK;").catch(() => {})`               | **最值得改的一条**：ROLLBACK 失败意味着单连接上还开着一个事务，后续所有语句都会落在这个未结束的事务里。这比触发回滚的那条语句本身的失败严重得多，却被完全吞掉 |

PTK 的对照做法：`stop()` 释放租约同样是 best-effort，但**在 README 里写明了**（"fire-and-forget，因为 `stop()` 本身是同步 API，页面正好在这时被卸载的话仍可能来不及真正写完"）；`writeResultRelay` 里 `JSON.stringify` 抛错也静默跳过，但**配了整段注释解释为什么静默是对的**。区分点不是"吞不吞"，而是**有没有解释、有没有第二条通道**。CSC 有 logger 就在手边，这三处接一条 `logger.warn` 即可。

### 7.2 三处顺手项

1. **CHANGELOG 与 `ci.yml` 已漂移。** `CHANGELOG.md` 的 0.2.0 条目写着"CI 矩阵覆盖 Node 20/22/24"，但 `ci.yml` 现在是 `matrix: node-version: [24]`（对应 commit `b02d2ca` "Require Node 24 for development; single-version CI matrix"），`engines` 也是 `>=24`。历史条目不必改写，但应在下个版本记一条"CI 收敛为单版本"，否则读 CHANGELOG 的人会以为仍有三个 Node 版本在跑。
2. **`ci.yml` 的单元素矩阵已无意义。** `strategy: { fail-fast: false, matrix: { node-version: [24] } }` 只剩一个版本，`fail-fast` 是空转；`node-version: ${{ matrix.node-version }}` 也多了一层间接。要么删掉矩阵，要么留一条注释说明"将来要恢复多版本时在这里加"——留着容易让人误判当前覆盖面。
3. **`.changeset/README.md` 缺失**（PTK 有，changesets 官方模板也带）。纯体感问题，但新贡献者第一次 `pnpm changeset` 时有个说明更好。

---

## 8. 已经对齐、不要重复劳动

除了 §1 的表，这里再明确几条**容易被误当成缺口**的项：

| 主题                       | 为什么容易误判                                                | 实际情况                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 边界值校验                 | PTK 有 `Number.isFinite(x) && x > 0` 回退、`NaN` 特判         | CSC 是 **fail-fast 抛错**（`assertIdentifier`、PRAGMA 值白名单、`version` 必须正整数、重复版本抛错）。构造期配置错误就该抛错——PTK 对构造期配置也抛 `RangeError`，两边判断一致。**不要改。** |
| 失败时的状态复位顺序       | PTK 有"`isChecking = false` 必须在 `flushBatch` 之前"这类教训 | CSC 已经在 `close()` 里用同一手法（"先把状态清零再发 close 消息：并发的第二个 `close()` 看到空状态直接 no-op"），并在 `doInitialize` 的 catch 里统一清理。对齐。                            |
| `finally` 里做可能抛错的事 | PTK 踩过"一次异常永久瘫痪"                                    | CSC 的 `finally` 只为状态清零（`web.ts:203-206` 是 `w terminate()`，`memory.ts:80-82` 是 `db = null`），没有 PTK 那种"在 finally 里做 I/O"的形状。不需要额外加固。                          |
| 测试用替身                 | 容易以为"用了 mock 就是没测真东西"                            | CSC 明确用**真引擎**：`createMemoryAdapter()` 跑同一份 sqlite-wasm（`memory.ts:6-13` 的注释专门解释了这一点），README 的 Testing 一节还建议消费方也这么做。对齐，且措辞比 PTK 更直白。      |
| 覆盖率工具                 | 两边都没有                                                    | 这不是"PTK 有"的项，不列为借鉴。                                                                                                                                                            |
| `sideEffects: false`       | 需要确认是否属实                                              | CSC 的适配器在模块顶层没有副作用（worker/promiser 都在 `initialize()` 里创建），声明属实。对齐。                                                                                            |

---

## 9. 落地建议顺序

### 阶段一：1 天（低成本、先建立可信度）

1. §3 的 `safeWarn` / `safeError`（7 处 + 1 条"logger 抛错仍能降级"的测试）。
2. §7 的三处静默 catch 接 logger；§7.2 的三处顺手项。
3. §6.1 把两份评审文档从 `math-kid/docs/` 搬进本仓库（并采用 §6.2 的表格结构）。

**验收**：传一个 `warn` 必抛的 logger，OPFS 不可用时仍返回可用的内存 client；`CHANGELOG`/`ci.yml` 说法一致；仓库里有评审记录。

### 阶段二：2–3 天（最大缺口）

4. §2 的 e2e 骨架（`test-e2e/` + `playwright.config.ts` + `vitest` exclude + `typecheck` 覆盖 + CI job），**注意 dev server 必须发 COOP/COEP**。
5. 先落地 §2.3 里的第 1、2、3 条用例（争锁 / 释放 / OPFS 持久化），再补 4、5、6。

**验收**：故意把 `web.ts` 的锁释放注释掉 → e2e 报红；故意把 dev server 的 COEP 头去掉 → "OPFS 持久化"那条用例报红（证明它测的确实是 OPFS 而不是内存）。

### 阶段三：设计（1 周，先出文档再动代码）

6. §4 的降级可观测 API（`mode` / `onDegraded`），依赖阶段二的用例 4 做验证。
7. §5 写成设计方案文档（含"不解决什么"），在阶段二建立的回归网上再评估是否动手。

**验收**：README 的 Testing 一节能回答"web 适配器怎么测"；`Runtime environment notes` 里每条取舍都能对应到一个可编程信号或一条 e2e 用例，而不是只有一句"请自觉传 logger"。

---

## 附录 A：文件锚点速查

**pending-task-kit（可借的东西在哪）**

| 主题                              | 位置                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 诊断通道不得拖垮被诊断路径        | `src/store.ts:136-151`、`src/engine.ts:675-684`（`try { logger.warn } catch {}`）                           |
| 同一原则的测试                    | `test/engine.test.ts`（"a throwing logger takes down neither a duplicate start() nor the tick that warns"） |
| 降级状态作为可读标志（模式）      | `src/store.ts:22-49`（`hasUnpersistedWrites` 的完整 doc 注释）、`166-174`                                   |
| 锁贴着临界区 / 租约 TTL / fencing | `src/engine.ts:740-790`、`436-474`；README 的跨标签页两节                                                   |
| 运行时取舍 / 刻意不做             | `README.zh-CN.md:309-358`                                                                                   |
| 评审台账体裁                      | `production-readiness-review.md:76-137`、`code-review-0.2.0.md`                                             |
| 动手前的方案模板                  | `cross-tab-kit-0.3.0-integration.md`                                                                        |
| e2e 骨架与全部设计注释            | `playwright.config.ts`、`test-e2e/{fixture.html,fixture.ts,tsconfig.json,leader-election.spec.ts}`          |
| e2e 的 dist 冒烟技巧              | `test-e2e/fixture.ts:1-7`                                                                                   |
| vitest 排除 e2e 的注释            | `vitest.config.ts`                                                                                          |
| CI 的 e2e job（缓存键、artifact） | `.github/workflows/ci.yml` 的 `e2e` job                                                                     |

**cross-sqlite-client（缺口在哪）**

| 事项                                          | 位置                                                                                                              |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 7 处裸 logger 调用                            | `src/adapters/web.ts:247,261,290,317`、`src/core/index.ts:48`、`src/core/migrate.ts:80,90`                        |
| 无 Web Locks 时静默 no-op                     | `src/adapters/web.ts:61-64`（degradation 无任何信号）                                                             |
| 内存降级只写日志                              | `src/adapters/web.ts:241-264`、`311-322`                                                                          |
| 锁持有一整个连接生命周期                      | `src/adapters/web.ts:270-281`、`176-207`（释放点）                                                                |
| 并发安全的自我声明（§5.2 的前提）             | `README.md` 的 Multi-tab coordination 一节；`src/adapters/web.ts:16-19`                                           |
| 三处静默 catch                                | `src/core/index.ts:65`、`src/adapters/web.ts:253`、`src/adapters/web.ts:371`                                      |
| `executeBatch` 拼接逻辑重复实现（只测了一半） | `src/adapters/memory.ts:54-59` vs `src/adapters/web.ts:154-168`；测试只走 memory                                  |
| 未覆盖的 web 行为清单                         | `src/adapters/web.ts`（381 行，见 §2.1 列表）                                                                     |
| CHANGELOG 与 ci.yml 漂移                      | `CHANGELOG.md` 0.2.0 条目 vs `.github/workflows/ci.yml` 的 `matrix`                                               |
| 评审文档当前所在（错位）                      | `../math-kid/docs/cross-sqlite-client-implementation-review.md`、`../math-kid/docs/cross-sqlite-readme-review.md` |

**cross-sqlite-client（已经做对、不要动）**

| 好实践                                          | 位置                                                          |
| ----------------------------------------------- | ------------------------------------------------------------- |
| `Logger`（`warn` + `error`）比 PTK 更完整       | `src/core/types.ts:1-8`                                       |
| 标识符 / PRAGMA 值双白名单（防拼接注入）        | `src/core/migrate.ts:4-13`、`src/core/index.ts:4-26`          |
| 类型化错误带结构化字段                          | `src/core/errors.ts`（`.sql`/`.params`/`.version`/`cause`）   |
| 失败即清理已获取资源                            | `src/core/index.ts:62-67`                                     |
| `close()` 先清零状态再关连接                    | `src/adapters/web.ts:186-207`、`src/adapters/memory.ts:68-83` |
| `initialize()` 并发去重 + 失败可重试            | `src/adapters/{web,memory,tauri}.ts` 的 `initPromise` 段      |
| 真引擎测试 + 推荐消费方也这么做                 | `src/adapters/memory.ts:6-13`、`README.md` 的 Testing 一节    |
| 防 flake 的 `skipIf` / `vi.waitFor`（PTK 没有） | `test/tab-lock.test.ts:4-8`、`25-31`                          |
| 具体数字的 `Known limitations`                  | `README.md` 的 Known limitations 一节                         |

---

## 附录 B：只记三条

1. **最大的一条不是纪律，是覆盖。** CSC 的 CI、发布、格式化、依赖治理、双语文档都已经和 PTK 齐平甚至更好；真正缺的是**一段能跑真浏览器、真 OPFS、真双标签页的测试**。而且它的缺失方式很隐蔽——`tab-lock.test.ts` 在 Node 24 里真的在跑、真的通过，于是"多标签页已测"这个错觉会一直存在。落 e2e 时别忘了一件事：**dev server 不发 COOP/COEP，"OPFS 持久化"用例会变成一条永远在内存上跑的假绿灯。**
2. **诊断通道是基础设施，不是装饰。** PTK 的规则是"日志抛错绝不能拖垮它正在诊断的代码路径"。在 CSC 这里这条规则尤其贵——因为 CSC 的 README 让用户**用 logger 来检测降级**，所以一个会抛错的 logger 会把"OPFS 不可用就用内存"这个良性降级，变成 `DbInitializationError`。同理，降级状态应该是**可读的字段**（PTK 的 `hasUnpersistedWrites` 模式），而不是只写进日志、让应用去解析字符串。
3. **锁的粒度要贴着临界区。** CSC 自己的文档已经证明"两个 tab 同时写同一个 OPFS 文件不会损坏数据"，所以"独占整个连接生命周期"买到的是错误更早、代价是第二个 tab 永久不可用（bfcache 会无限延长它）。往这个方向走之前，先把"当前行为"用 e2e 钉住，再写方案文档——并且记住 PTK 的边界：**纯 Web Locks 不需要 fencing，一旦给它加 TTL 就必须补上**，否则是把可用性问题换成正确性问题。
