# 代码审查报告：`cfccfdf` "Production-hardening pass: 0.2.0"

日期：2026-09-19（第四轮，针对 0.2.0 提交）
范围：提交 `cfccfdf`（22 个文件，+1732/-40）：AbortSignal 取消、retry backoff、onLeaderChange/onTick 观测钩子、task-list size warning、Playwright e2e 套件、打包工程化（LICENSE/CI/Changesets 等）
验证状态：76 个 vitest 全部通过、3 个 Playwright e2e 本机真实 Chromium 全部通过、`tsc --noEmit` 干净、oxlint 0 警告

## 结论：不建议直接推送 —— 1 个 Blocker + 3 个 Major

## Blocker

### B1. 新 CI 跑不起来：`pnpm/action-setup@v4` 缺少版本来源

位置：`.github/workflows/ci.yml:13, 29`

`pnpm/action-setup@v4` 未指定 `version`，而 `package.json` 没有 `packageManager` 字段——该 action 在这种情况下**必填 version**（官方文档：未声明 packageManager 时 "this field is required"）。两个 job 都会在 setup 阶段报 "No pnpm version is specified" 直接失败。本次提交的核心交付物之一（CI）从未真正跑通过。

**修复**：`package.json` 加 `"packageManager": "pnpm@11.5.2"`，或 workflow 里 `with: { version: 11 }`。

## Major

### M1. `pnpx playwright install` 与锁定的 `@playwright/test` 版本可能错位

位置：`.github/workflows/ci.yml:36`

`pnpx`（即 `pnpm dlx`）从 registry 拉取 `playwright@latest` 执行，**不**使用 `node_modules` 里 lock 住的 `@playwright/test@1.63`。Playwright 浏览器按 revision 安装，CLI 版本与测试运行器一旦错位，`test:e2e` 以 "Executable doesn't exist…" 失败，e2e job 随时会断。

**修复**：改为 `pnpm exec playwright install --with-deps chromium`，保证安装浏览器的 CLI 就是跑测试的那一个。

### M2. election 关闭时，`stop()` 会把本无错的请求变成「失败」

位置：`src/engine.ts:390`（election-off 早退）+ `src/engine.ts:695-758`（catch 分支）

`reconfirmLeadership` 第一行 `if (!this.options.crossTabPollLeaderElection) return fence` 位于 `this.stopped` 检查**之前**。于是 `crossTabPollLeaderElection: false` 时：

`stop()` abort 掉 in-flight 的 `check()` → handler 若按文档建议接入 `fetch(url, { signal })` 会抛 AbortError → catch 分支 → reconfirm 直接返回 fence（而非 false）→ 走入正常失败处理：`onCheckError` 收到 AbortError、`failureCount` +1；若恰达 `maxFailureCount`，任务被以 `"error"` finalize 并在已停止的 poller 上派发 `onResult`；若是 expired + `finalCheckOnExpiry` 的任务，abort 直接消耗掉仅有的一次 final check 并按 expired 移除。

而 election 开启（默认）时同一场景会被正确丢弃（审查员用临时探针实证两条路径差异：election-on 下 `onCheckError` 0 次、failureCount 不变；election-off 下均污染）。副作用还包括污染持久化的 `failureCount`，重启后错误触发 `retryBackoffMs`。新增单测全跑在默认 election-on 下，恰好测不到这条路径。

**修复**：catch 分支在 failure 计数前检查 `this.stopped` / `abortController.signal.aborted` 并直接走丢弃路径，与 election-on 对齐；或把 stopped 检查提到 election-off 早退之前（语义更优）。

### M3. election 关闭时 `onLeaderChange(true)` 仍会触发，违反文档契约

位置：`src/engine.ts:717, 780`（对照 doc `:143-146`）

两条 reconfirm 成功路径上的 `this.setLeaderStatus(true)` 无条件执行；election off 时 reconfirm 返回 fence（非 false），第一个 check 落定后 `isLeaderTab` 从 false 翻成 true 并回调——但 `onLeaderChange` 的 doc 明确承诺 "only ever called when `crossTabPollLeaderElection` is on"。次生问题：`isLeaderTab` 就此卡在 true——`stop()` 里的 `setLeaderStatus(false)`（`:340`）包在 election-on 的 if 里，永远不回调 false。

**修复**：两处 `setLeaderStatus(true)` 移进 election-on 分支，或在 `setLeaderStatus` 内部对 election-off 早退。

## Minor

1. **stop() 落在 `await claimLeadership()` 窗口内时误触发 `onLeaderChange(true)` 且 check 仍发起** — `src/engine.ts:664-683`。第三轮 Minor 1 的修复（`:659` stopped 检查提到 fence 门外）只覆盖「两个任务之间」的时机；claim await 期间发生 stop()（真实浏览器 Web Lock 仲裁让出事件循环即可达），claim resolve 后在已 stop 的 poller 上误报 leader=true 并多发一次 check。响应仍被 reconfirm 丢弃，无数据错误。
2. **新增测试关键断言缺口** — `test/engine.test.ts:997-1023`：abort 测试在 `resolveCheck({status:"pending"})` 后没有任何断言，没锁住「stop 后迟到响应被丢弃」（即 M2 的 election-on 半边无回归测试）；backoff 未测第二次失败收到 2、成功后恢复 `pollIntervalMs` 节奏；所有新钩子测试都在 election-on 下，election-off 组合零覆盖；`onLeaderChange(false)` 只测 stop() 路径，未测被其他 tab 抢走的翻转；`onTick` 未测「tick 因 in-flight 被跳过时不触发」这一 doc 承诺。
3. **size warning 阈值边界（`>` vs `>=`）未被测试隔离** — `test/store.test.ts:64-81`：若实现误写成 `>=`，现有断言照样全部通过。建议在恰好等于阈值时插一句 `not.toHaveBeenCalled()`；另缺「跌破阈值后再次越过仍不再告警」用例。
4. **`test-e2e/` 不在任何 typecheck/lint 覆盖下** — `test-e2e/tsconfig.json` 存在但无任何脚本执行它，`playwright.config.ts` 不在任何 tsconfig 内；vite/esbuild 只转译不查类型，e2e 代码可静默腐化。建议 `typecheck` 加 `&& tsc -p test-e2e` 并把 test-e2e 纳入 lint。
5. **`retryBackoffMs` 返回值无校验** — `src/engine.ts:617-621`：返回 0/负数导致每 tick 热重试，NaN 导致任务永不再到期。doc 未提醒。
6. **e2e relay 测试存在低概率 flake 窗口** — `test-e2e/leader-election.spec.ts:62-83`：`expect.poll` 在任一 tab 有结果即返回，随后立即断言两个 tab 都有结果；follower 的 storage-event 投递是异步的。建议 poll 条件改为「两者均非 null」。
7. **e2e lease 参数余量偏小** — `test-e2e/leader-election.spec.ts:29-44`：`pollTickMs: 50` → 默认 `pollLeaseTtlMs` 200ms，重负载 CI 上 leader 事件循环停顿过久会被合法接管导致断言失败。建议该用例显式调大 `pollLeaseTtlMs`。
8. **size warning 不覆盖「启动时持久化列表已超阈值」** — `src/store.ts:132-143`：检查只在 `writeTasks`，zustand persist 的初始 rehydrate 不经过它。
9. **`pnpm test:e2e` 本地跑不自动构建 dist** — fixture 刻意 import `../dist/index.js`（兼作构建冒烟，合理），但 dist 过期时本地会静默测试旧代码；CI 有 build 前置，仅本地体验问题。

## Nit

10. `src/store.ts:133` `typeof console !== "undefined"` 在目标环境恒为真，与文件风格不一致。
11. `src/store.ts:115` `taskListWarnThreshold` 无输入校验：NaN 静默禁用告警（与文档记载的禁用方式 `Infinity` 不一致），0/负值首个任务即告警。
12. `src/store.ts:132-143` warn 块在 try 之外：`console.warn` 被替换为会抛异常的实现时，写入整体丢失且 `hasUnpersistedWrites` 未置位（病态场景）。
13. `test/store.test.ts:80,95` `warnSpy.mockRestore()` 在用例末尾而非 `afterEach`，中途断言失败会泄漏 mock。
14. `CHANGELOG.md:8` 有两个尾随空格（Markdown 换行残留）。
15. `playwright.config.ts:21` 用 `npx vite`，项目是 pnpm，风格不一致。
16. CI 无 Playwright 浏览器缓存、失败不上传 `playwright-report`、无 `concurrency` 组——能跑但调试/速度体验差。
17. `prepublishOnly` 不含 `test:e2e`——合理取舍，仅记录。

## 已确认无问题的关键点

### 回归（前三轮修复项，全部完好）

- relay 写入仍不受 `dispatchDomEvent` 门控且在 `onResult` 之前（`src/engine.ts:509-518`）。
- relay 接收仍过 `claimResultOnce`（`:539-548`）。
- 第三轮 Minor 1（stopped 检查被 `fence !== undefined` 旁路）已修：`:650-663` 无条件先于 fence 门执行。
- 第三轮 Minor 2（claimResultOnce doc 未提抑制 relay）已修：`:60-67`。
- `finalCheckAttempted` 的 add/delete 配对在含新 AbortSignal 分支在内的所有出口完整；fence 每个失效点都成对出现 `setLeaderStatus(false)`。

### 新功能本身

- **AbortSignal plumbing 正确**：controller 的 finally 清理有同 identity 守卫，时序交错的 check 不会互相误清；`check(task, signal)` 对 TS 消费者纯增量，README/CHANGELOG 的「现有 handler 不受影响」属实。
- **onTick**：早退路径（stopped/空列表/isChecking 跳过）都不触发，与 doc 一致；抛异常经 `queueMicrotask` surface。
- **size warning**：挂在 `writeTasks` 唯一收口点（mutator/`flushBatch`/跨 tab 同步三条路径全覆盖）、`hasWarned` 在 warn 前置位保证至多一次、warn 在 `setState` 之前的排序正确（配额耗尽时告警依然成立）。
- **vitest.config.ts** 排除 `test-e2e/**` 必要且正确（避免与 Playwright 的 `test` 全局冲突）。
- **e2e 真实性**：fixture 导入 `dist/index.js` 兼作构建产物冒烟；vite dev server + strictPort + `workers:1` + 每用例独立 storageKey 设计合理；leader 身份不假设（用例 3 先探测）。
- **一致性**：双 README 新章节逐字对应；package.json 0.2.0 ↔ CHANGELOG 0.2.0 ↔ LICENSE MIT ↔ `"license": "MIT"` 自洽；`files: ["dist"]` 为既有字段，npm 不会打空包；`DEFAULT_TASK_LIST_WARN_THRESHOLD` 已从入口导出并出现在 `dist/index.d.ts`；react 绑定整体透传 `PendingTaskPollerOptions`，新钩子自动可用。

## 建议行动

| 优先级     | 事项                                                                            | 工作量            |
| ---------- | ------------------------------------------------------------------------------- | ----------------- |
| 推送前必修 | B1：package.json 加 `packageManager` 或 workflow 加 `version`                   | 一行              |
| 推送前必修 | M1：`pnpx` → `pnpm exec playwright install`                                     | 一行              |
| 发布前建议 | M2：catch 分支判 stopped/aborted 走丢弃路径 + 补「abort 不计 failureCount」用例 | 几行 + 一个用例   |
| 发布前建议 | M3：两处 `setLeaderStatus(true)` 移进 election-on 分支 + 补 election-off 用例   | 一行级 + 一个用例 |
| 可后续     | Minor 1-9、Nit 10-17                                                            | 各自独立          |

注：M2/M3 都集中在 election-off 与新功能的交叉路径——正是当前测试盲区；修复时建议把新钩子/abort/backoff 测试在 election-off 下参数化跑一遍。

---

## 附录：审查历史

- **第一至三轮**（提交 `2be6c90`，见 `code-review-2026-09-18.md`）：跨标签页 leader 选举 + result relay 功能，2 Major + 若干 Minor/Nit 全部修复后合并。
- **README 轮**（提交 `f97507c`）：claimResultOnce 去重 key 改为 `${task.id}:${task.startedAt}` 的文档，修复了悬空交叉引用。
- **第四轮**（提交 `cfccfdf`，本文件上半部分）：0.2.0 生产化加固，1 Blocker + 3 Major。
- **第五轮**（工作区未提交改动，基于 cfccfdf）：见下文复审结论。

---

# 第五轮复审（2026-09-19，工作区未提交改动）

验证状态：87 个 vitest 全部通过（76→87），`tsc --noEmit`（含 test-e2e）干净、oxlint 0 警告

## 结论：第四轮 1 Blocker + 3 Major 全部正确修复，可以提交

## 第四轮问题逐项核对

| 项                                               | 状态              | 依据                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1 CI 缺 pnpm 版本来源                           | ✅ 已修复         | `package.json:25` 加 `"packageManager": "pnpm@11.5.2"`；配合手工升级的 `pnpm/action-setup@v6`（另：checkout@v7 / setup-node@v5 / node 24）                                                                                                                |
| M1 `pnpx playwright install` 版本错位            | ✅ 已修复         | `ci.yml:48` 改 `pnpm exec playwright install --with-deps chromium`；缓存按 lockfile 哈希键控，cache-hit 时补 `install-deps`（浏览器有缓存但系统依赖没有，拆分正确）；另加失败上传 report、concurrency 组                                                  |
| M2 election-off 时 stop() 的 AbortError 计入失败 | ✅ 已修复         | `src/engine.ts:395-414`：stopped 检查提到 election-off 早退之前，注释明确记录「重排即修复」；回归测试 `test/engine.test.ts:1031-1069` 用 `maxFailureCount: 1` 锁住四点（onCheckError/onResult 不触发、failureCount 为 0、任务不被 finalize）              |
| M3 election-off 时 onLeaderChange(true)          | ✅ 已修复         | 守卫下沉到 `setLeaderStatus` 内部（`src/engine.ts:361`），比逐个 call site 加门更稳；次生问题（isLeaderTab 卡 true）随之消失；回归测试 `:1158-1186`                                                                                                       |
| Minor 1 stop() 落在 claimLeadership await 窗口   | ⚠️ 部分修复       | 代码已修（`engine.ts:697-708` post-claim stopped 复查），但无回归测试（jsdom 下 `forceCheckAll(); stop()` 不 await 可稳定命中，可测未测）                                                                                                                 |
| Minor 2 测试缺口                                 | ⚠️ 大部分已补     | 已补：abort 后断言（`:1024-1028`）、backoff 二次失败（`:1293-1315`）、非法值回退（`:1317-1344`，it.each 覆盖 NaN/负/Infinity）、onLeaderChange(false) 被抢（`:1188-1222`）、onTick skip（`:1257-1291`）。**未补**：backoff 成功后恢复 pollIntervalMs 节奏 |
| Minor 3 阈值边界 + dip-and-recross               | ⚠️ 部分修复       | 边界测试已补（`test/store.test.ts:93-102`，恰好等于阈值不告警）；dip-and-recross 未补                                                                                                                                                                     |
| Minor 4 test-e2e 无 typecheck/lint               | ✅ 已修复         | `package.json:47-48` + `test-e2e/tsconfig.json:3` 纳入 playwright.config.ts                                                                                                                                                                               |
| Minor 5 retryBackoffMs 无校验                    | ⚠️ 已修复但有瑕疵 | 见下方新发现 M-1（0 边界矛盾）                                                                                                                                                                                                                            |
| Minor 6 e2e relay 竞态                           | ✅ 已修复         | poll 条件改为两 tab 均非 null（`leader-election.spec.ts:70-81`）                                                                                                                                                                                          |
| Minor 7 e2e lease TTL 余量                       | ⚠️ 部分修复       | 用例 1、2 显式 `pollLeaseTtlMs: 2_000`；用例 3 仍为 300（`:102`），takeover 阶段需要短 TTL 合理，但关闭前断言（`:111`）仍暴露在 ~300ms 停顿窗口                                                                                                           |
| Minor 8 rehydrate 不告警                         | ✅ 已修复         | `src/store.ts:212-214` `onRehydrateStorage` 钩子 + 测试（`store.test.ts:131-154`）                                                                                                                                                                        |
| Minor 9 本地 test:e2e 不构建 dist                | ❌ 未修复         | 维持上轮定性（本地体验取舍）                                                                                                                                                                                                                              |
| Nit 10-17                                        | 大部分已修        | 10 ✅（改 try/catch）、11 ⚠️（只挡 NaN，0/负值未挡）、12 ✅、13 ✅（afterEach）、14 ✅、15 ✅（pnpm exec vite）、16 ✅（缓存/artifact/concurrency）、17 未变（已记录取舍）                                                                                |

## 新发现

### M-1（Minor，建议顺手修）：`retryBackoffMs` 返回 0 被信任，与自身注释/doc 矛盾

位置：`src/engine.ts:641`（对照注释 `:635-639`、`src/types.ts:72-77`）

守卫是 `backoffMs >= 0`，**放行了 0**：`interval = 0` → `now - lastChecked >= 0` 恒真 → 该任务每个 tick 热重试——正是注释明确说要防的情况（"0/negative would make this task retry on essentially every tick"）。测试覆盖了 NaN/-100/Infinity，唯独漏了 0。

**修复**：`>= 0` → `> 0`（一行）+ 补一个返回 0 的用例。

### 其他残留（nit 级）

- Minor 1 修复（post-claim stopped 复查）无回归测试。
- 「backoff 成功后恢复节奏」「dip-and-recross」用例未补。
- `taskListWarnThreshold` 的 0/负值未挡（只挡了 NaN），doc 未记载 NaN 回退默认的行为。
- `retryBackoffMs` 抛异常未包裹（`engine.ts:634`）——同函数内 `onCheckError` 有 try/catch + queueMicrotask，处理不一致；抛出会炸掉整个 tick 循环。
- stop 期间完成的 claim 会留下无人续约的租约（其他 tab 需等满 TTL），上轮已定性无数据错误，仅记录。

## 回归检查

前四轮已修复项全部完好：relay 写入不受 `dispatchDomEvent` 门控且在 `onResult` 之前（`engine.ts:525-534`）；relay 接收仍过 `claimResultOnce`（`:555-564`）；fence 重置配对（`:739-741`、`:802-804`）；`finalCheckAttempted` 配对含新增的 post-claim stopped 分支（`:706`）；M2/M3 修复未改变 election-on 任何路径语义。

## 建议行动

| 优先级   | 事项                           |
| -------- | ------------------------------ |
| 可提交   | 当前状态不阻塞                 |
| 建议顺手 | M-1：`>= 0` → `> 0` + 一个用例 |
| 可后续   | 其余测试缺口与退化输入校验     |

---

# 第六轮复审（2026-09-19，增量：相对第五轮的新改动）

验证状态：89 个 vitest 全部通过（87→89），tsc 干净

## 结论：M-1 已修复且实现/注释/doc/测试四层一致，可以提交

## 逐项核对

| 项                                      | 状态      | 依据                                                                                                                                                                                                                             |
| --------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M-1 `retryBackoffMs` 守卫放行 0         | ✅ 已修复 | `src/engine.ts:657` 改为 `backoffMs > 0`，0/负/NaN/Infinity 全部回落正常 interval；注释（`:650-655`）与 `src/types.ts:72-79` doc 同步；`test/engine.test.ts:1346` 专门回归 0（断言 check 只调 1 次，钉死旧的 "always due" 行为） |
| nit：`retryBackoffMs` 抛异常未包裹      | ✅ 已修复 | `src/engine.ts:636-648`：catch → `queueMicrotask` 重抛 → 回落正常 interval，与引擎内既有 6 处 consumer callback 处理模式完全一致；测试 `:1373` 断言不拖垮同 tick 其他任务                                                        |
| nit：post-claim stopped 复查无测试      | ❌ 未补   | `src/engine.ts:719` 分支仍无专项用例                                                                                                                                                                                             |
| nit：backoff 成功恢复节奏无测试         | ❌ 未补   | 现有用例只覆盖连续失败                                                                                                                                                                                                           |
| nit：`taskListWarnThreshold` 0/负值未挡 | ❌ 未挡   | `src/store.ts:120-123` 只挡 NaN                                                                                                                                                                                                  |

## 回归检查

第五轮已修项均未破坏：M2 stopped 检查顺序（`engine.ts:395` 先于 `:415`）、M3 setLeaderStatus 守卫（`:361`）、fence/finalCheckAttempted 配对（`:710-722`）保持原样。retryBackoffMs 的调用条件与旧代码等价（仍 `failureCount > 0` 时才调），无行为回归。

## 新发现

无 blocker/major。唯一 minor：新增用例用真实定时器（pollTickMs 15ms、60-80ms 窗口），极度拥挤的 CI 上理论可 flake，余量可接受，记录在案。
