# 生产级就绪深评报告：pending-task-kit v0.2.0

日期：2026-09-19
对象：提交 `cfccfdf` + 工作区未提交改动（截至评估时）
验证状态：89 个 vitest、3 个 Playwright e2e（真实 Chromium）全部通过；tsc（含 test-e2e）、oxlint 干净；`publint` 全绿

## 总体判断

**接近夯实，但还不是——三个评估维度均为「基本可用，有残留风险」。**

六轮代码审查已使并发正确性收敛（fence 语义、fail-open 降级、单一事实源贯彻一致），但深评在审查盲区发现了真实缺陷，集中在打包出口、极端环境降级、React 绑定测试、发布链路四处。

## 做得扎实的部分

- **并发正确性**：fence 代际比较解决 fencing 盲角；bfcache 冻结/崩溃后的接管有真实双 tab Playwright 验证（`test-e2e/leader-election.spec.ts:93-121`）；lease 写入 fail-open（`src/poll-lease.ts:76-86`）；store 写入失败收敛到 `hasUnpersistedWrites` 单一事实源。
- **打包骨架**：运行时零依赖；ESM 产物实测 node 解析正常（20 个导出）；tarball 白名单正确（仅 dist + LICENSE + 双 README，18 个文件）；`sideEffects: false` 准确；614 个 lockfile 条目全部是 devDependencies；`packageManager` 固定 pnpm 版本，CI 用 `--frozen-lockfile`。
- **类型与错误纪律**：全 src 无 `any`，自由数据位全用 `unknown`；consumer 回调抛错统一 `queueMicrotask` surface（引擎内 6 处同一模式）；存储失败统一静默降级；非法 `retryBackoffMs` 返回值回退正常节奏。
- **文档**：双语 README 章节一一对齐；误用陷阱（dedupe key 必须 `id:startedAt`、每 tab 每 store 单实例、PII 在 relay key 的驻留与清理）均已写明；「刻意不做」清单划清与 tanstack query/swr 的边界。
- **CI**：typecheck（含 test-e2e）/ lint / test / build / e2e 全覆盖，Playwright 浏览器缓存按 lockfile 哈希键控，失败上传报告，有 concurrency 组。

## 真实缺陷与处理状态

### ① CJS 消费者类型解析失败（TS1479）—— ✅ 已通过「移除 CJS」解决

原缺陷：`exports` 的 `types` 只指向 ESM 风味的 `.d.ts`，`moduleResolution: node16/nodenext` 的 CJS 用户 `require()` 即编译失败（实测复现）。

**决策（2026-09-19）：不支持 CJS。** 已实施：`tsup.config.ts` 改为 `format: ["esm"]`；`package.json` 的 `main` 指向 `./dist/index.js`、`exports` 移除 `require` 条件。重建后 dist 仅含 ESM 产物，`publint` 全绿，89 测试通过。缺陷随 CJS 移除彻底消失。

### ② storage 禁用时引擎从「安静降级」变「永久假死」—— ❌ 未修（发布前必修）

两段组合（`src/store.ts:100-101` + `src/engine.ts:844-846`）：

- `readPersistedTasks` 的 `typeof localStorage` 和 `getItem` 都在 try/catch 之外。在完全禁用站点数据的浏览器里，`localStorage` 访问器本身抛 SecurityError——这正是 `src/safe-storage.ts:17-29` 注释明确防过、唯独这里漏走的场景。所有 store mutator、`flushBatch`、`addTaskIfMissing` 都会抛出未捕获异常。
- 放大器：`runTick` 的 `finally` 中 `flushBatch(batch)` 在 `isChecking = false` **之前**——flushBatch 抛出则 isChecking 永卡 true，此后每个 tick 在 in-flight 检查处直接 return，**轮询永久瘫痪且无重试**。这是引擎唯一「一次异常即永久死亡」的点。

**修复**：`readPersistedTasks` 改用 `safeGetItem`（与 safe-storage 自身注释对齐）；`finally` 中 `isChecking = false` 移到 `flushBatch` 之前（或给 flushBatch 套 try/catch）。各几行 + 一个「localStorage 访问器抛错」的单测。

### ③ React 绑定零测试 —— ❌ 未修（强烈建议）

`src/react.ts` 承载了 StrictMode 双挂载（cleanup 完整性）、`visibilitychange → forceCheckAll` 解冻恢复、`optionsRef` 回调保鲜等关键逻辑，人工审读正确，但 `test/` 六个测试文件均不触碰它。`react.ts:36-40` 的注释自述了易回归点（新增回调 option 漏掉转发）。对一个声明支持 React 的发布版本，这是唯一「发货但零覆盖」的模块。

### ④ 发布链路不闭环 —— ❌ 未修（强烈建议）

- 无 release workflow：README 记录的是手动 `changeset version` + `npm publish`；npm registry 最新只有 0.1.0，0.2.0 是该流程的首次实战，从未验证。
- CI 无 `changeset status` 门禁，「改了 src 忘写 changeset」全靠自觉。
- 评估时工作树有 13 个未提交文件（含实质代码改动）且无 pending changeset；dist 由 `prepublishOnly` 现场构建——此刻直接 `npm publish` 会把不可追溯的代码以 0.2.0 名义发出。

**修复**：tag 触发的 release workflow（干净 checkout 构建 + `npm publish --provenance`）；CI 加 `pnpm changeset status --since=origin/main`。

### ⑤ React peer `>=19` 无谓过严 —— ❌ 未修（顺手）

`usePendingTaskPoller` 只用了 `useEffect`/`useRef`（`src/react.ts:1`），无 React 19 特有 API。存量 React 18 应用安装即 peer 冲突，README 未解释理由。放宽至 `>=18` 或在 README 写明必须 19 的原因。

## 可接受但应文档化的取舍（建议收敛成 README「Runtime environment notes」一节）

- **全链路墙钟（`Date.now()`）**：时钟回拨 → 轮询/续约延迟（无害）；时钟前跳 → 任务可能批量静默过期、lease 全部失效（fencing 兜住正确性）、dedupe 记录提前过期。README 未提。
- **后台标签页 timer intensive throttling**（Chrome 冻结后 1 次/分钟）：leader 续约节奏（默认 8s）远低于节流后间隔，后台 leader 会丢领导权，双后台 tab 交替当 leader——正确性由 Web Lock 串行化 + fence 保证，仅时效下降。README 只提了 bfcache，没提更常见的 timer 节流形态。
- **Web Locks 不可用时选举无互斥**（旧 Safari、http:// 非安全上下文）：已文档化并给出 `claimResultOnce` 补救，达标。
- **`stop()` 不自动挂 `pagehide`**：硬卸载时 in-flight batch 不落盘、lease 等 TTL 自然过期（默认 8s），无害，README 部分提及。
- **非 React 用户无解冻恢复钩子**：`visibilitychange → forceCheckAll` 只在 React 绑定里，README 核心用法章节未建议非 React 用户自接。
- **consumer 回调抛错变 uncaught 的契约**只存在于源码注释，双语 README 均未提。
- **zustand persist 退化噪音**：storage 完全不可用/SSR 时每次 setState 打 `console.warn`（zustand 内部行为），与本包「安静降级」基调不一致。
- **无 handler 的 type 静默挂起到 TTL**：`type` 拼错无任何提示；建议文档提示用字面量 union 参数化 `TType` 获得穷举检查。
- **e2e 仅 Chromium**：Safari/WebKit 的 `navigator.locks` 实现差异是已知风险区，可加 Playwright WebKit project。
- **0.x 语义承诺未写明**：README 未说明 0.x 下 minor 可含 breaking change（0.2.0 实际是 additive 的）。

## 已妥善处理（有代码/e2e 证据，无需行动）

- React StrictMode 双挂载（人工审读：cleanup 完整，旧实例 best-effort release 因 owner 守卫不会误释放新实例租约）
- SSR 导入/构造（全部 `typeof window`/`navigator` 守卫，ownerId 有非加密回退）
- `localStorage.clear()`（key:null）跨 tab 同步
- 页面卸载时 in-flight check 的真实取消与迟到响应丢弃
- 同 tab 多实例限制已文档化
- 接入路径清晰无歧义（README 核心示例完整可粘贴闭环）；类型导出完整、泛型 `TType` 贯通全链路

## 评分

| 维度                   | 评分                                                           |
| ---------------------- | -------------------------------------------------------------- |
| 真实浏览器运行时健壮性 | 基本可用，有残留风险（缺陷②是唯一致命路径）                    |
| 采用者体验与 API 设计  | 基本可用，有残留风险（缺陷①已随移除 CJS 解决；剩余为文档缺口） |
| 发布与运维就绪度       | 基本可用，有残留风险（缺陷④：首发流程未验证 + 无追溯保障）     |

## 行动建议（按优先级）

| 优先级         | 事项                                                                  | 成本               | 状态                  |
| -------------- | --------------------------------------------------------------------- | ------------------ | --------------------- |
| ~~发布前必修~~ | ① exports CJS 类型                                                    | —                  | ✅ 已解决（移除 CJS） |
| 发布前必修     | ② readPersistedTasks 走 safeGetItem + isChecking 先于 flushBatch 复位 | 各几行 + 一个单测  | ✅ 第七轮已修         |
| 强烈建议       | ③ React 绑定补测试（StrictMode / visibilitychange / optionsRef）      | 约半天             | ✅ 第七轮已修         |
| 强烈建议       | ④ release workflow（--provenance）+ CI changeset status 门禁          | 一个 workflow 文件 | ✅ 第七轮已修         |
| 顺手           | ⑤ react peer 放宽 >=18                                                | 一行               | ✅ 第七轮已修         |
| 顺手           | ⑥ README 补「Runtime environment notes」一节                          | 纯文档             | ✅ 第七轮已修         |

---

# 第七轮复审与修复落实（2026-09-19，工作区未提交改动，基于 cfccfdf）

验证状态：95 个 vitest（89→95，含新增 `test/react.test.tsx` 4 个用例）、tsc（含 test-e2e）、oxlint 全部通过

## 深评问题逐项核对（②③④⑤⑥ 全部修复，方式正确）

- **② 假死修复**（✅，超出建议）：`src/store.ts:104-108` 改用 `safeGetItem`；`src/engine.ts:851-863` 先无条件复位 `isChecking`，再给 `flushBatch` 套 try/catch + `queueMicrotask` surface。回归测试真实有效：`test/engine.test.ts:1408-1443`（writeTasks 抛错后下一 tick 恢复）、`test/store.test.ts:57-70`。
- **③ React 绑定测试**（✅，真测试非空转）：`test/react.test.tsx` 4 个用例逐一核验过失败路径确实存在——StrictMode 断言存活实例 interval 仍在走；visibilitychange 用 60s interval 排除自然 tick；optionsRef 用「换闭包后旧闭包零调用」pin 住 mount-closure 写法。
- **④ 发布链路**（✅）：`release.yml` tag 触发、最小权限（`contents: read` + `id-token: write`）、tag/版本一致性校验、`--provenance`、`--no-git-checks` 对 detached HEAD 必要；CI changeset 门禁（`ci.yml:31-33`）语义经 changesets 源码验证。
- **⑤ react peer**（✅）：`>=18`，hook 仅用 `useEffect`/`useRef`。
- **⑥ Runtime notes**（✅）：双语各 9 条，覆盖深评全部取舍项。
- **回归项**：relay 门控、claimResultOnce、fence 配对、finalCheckAttempted 配对、stopped 顺序、setLeaderStatus 守卫、retryBackoffMs 校验——全部完好。新增依赖仅 `@testing-library/react` + `react-dom`（devDependencies），运行时零依赖不变。

## 第七轮新发现与修复

### Major：CHANGELOG 漏记 CJS 移除 —— ✅ 已修（本轮）

npm 上 0.1.0 实测带 `require` 条件和 `.cjs` 产物，0.2.0 移除 CJS 对 node16/nodenext 的 CJS 消费者是 breaking，但 changelog 只字未提。**修复**：`CHANGELOG.md` 0.2.0 条目新增 `### Breaking Changes`（ESM-only 说明）和 `### Patch Changes`（react peer 放宽、storage 禁用加固）；README 双语 0.x 声明中「0.2.0 本身是纯加法的」的错误表述同步修正。

### Minor：README 把 8s 说成「续约节奏」 —— ✅ 已修（本轮）

`README.md:308` / `README.zh-CN.md:288` 原表述低估了默认配置下的实际行为（默认 `pollIntervalMs=10s` 时 lease 在两次 check 之间例行过期，前台 tab 也轮换 leadership）。**修复**：双语改写为「leadership 会例行轮换，前台标签页也一样」，8s 明确为 TTL、续约只搭在有到期任务的 tick 上。

### Minor：changeset 门禁鸡生蛋问题 —— ✅ 已修（本轮）

门禁合入后本 PR 自己会红（改了 src 无 changeset），且纯文档 PR 也触发。**修复**：新增 `.changeset/review-hardening.md`（patch，已验证 `changeset status` 正确识别）；双语 Contributing 补 `pnpm changeset --empty` 逃生口说明。

### 残留未修（nit 级，记录在案）

- `test/store.test.ts:62-64` mock 的是 `getItem` 抛错而非访问器本身抛错（safeGetItem 同一 try 兜住，机制覆盖但注释自述场景未直接测）。
- flushBatch 兜底路径语义（catch 丢弃未落盘 batch 后，已 finalize 任务下 tick 可能重复 dispatch）目前无实际抛出面，建议注释承认「牺牲恰好一次换可恢复」。
- `release.yml`：验证步骤跑两遍（`prepublishOnly` 与显式四步重复）；tag/版本校验可前移 fail-fast；无 concurrency 组。
- 负值 `taskListWarnThreshold` 未挡；`react.test.tsx` 的 `visibilityState` 未还原、`onLeaderChange` 转发保鲜无专项测试；CI action 主版本不齐（cache@v4/upload-artifact@v4）。

## 结论

**深评全部行动项已闭环，无遗留 blocker/major。** 当前状态满足「夯实的生产级可用版本」标准：正确性经七轮审查收敛、打包出口纯净（ESM-only + publint 全绿）、极端环境降级有测试背书、发布链路可追溯（tag + provenance + changeset 门禁）。可以提交并发布 0.2.0。

---

## 附录：审查历史

- **第一至三轮**（`code-review-2026-09-18.md`）：跨标签页 leader 选举 + result relay（提交 `2be6c90`）。
- **README 轮**：dedupe key 文档修正（提交 `f97507c`）。
- **第四至六轮**（`code-review-0.2.0.md`）：0.2.0 生产化加固（提交 `cfccfdf`）及后续两轮增量修复。
- **本轮**：生产级就绪深评（本文件）。
