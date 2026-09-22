# 代码审查报告（未提交改动）

日期：2026-09-18（第三轮复审）
范围：工作区未提交改动（9 个修改文件 + 5 个新增源码/测试文件）
验证状态：65 个测试全部通过，`tsc --noEmit` 无错误

## 总体评价

**可以合并。** 第二轮提出的 8 项问题全部妥善了结，3 个新增测试精准锁定修复点（测试数 62→65 与之一一对应，无注水）。本轮无 blocker、无新 Major。剩余 1 个 Minor 和少量 Nit 均为可选改进，不阻塞合并。

## 第二轮问题逐项核对

| #          | 问题                                                         | 结论                | 依据                                                                                                                                                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 新 Major 1 | `leadershipLost`/`stopped` 检查被 `fence === undefined` 旁路 | ✅ 已修复           | 两条 reconfirm 失败路径均同时 `leadershipLost = true; fence = undefined`（`src/engine.ts:605-617` 错误分支、`:668-676` 成功分支），注释解释了为何必须重置 fence；新增两任务回归测试 `test/engine.test.ts:637`（task a 的 stale 响应被丢弃 + task b 完全不调用 check()）。stop()-mid-check 场景由 reconfirm 的 stopped 早退汇入同一路径覆盖 |
| Minor 2    | `writeResultRelay` 排在故意不 catch 的 `onResult` 之后       | ✅ 已修复           | relay 写入挪到 `onResult` 之前（`src/engine.ts:440-450`），注释说明动机（单 tab 的 consumer bug 不应拖垮其他 tab）；测试 `test/engine.test.ts:777` 锁定（relay 仍写入 + 异常仍被 surface 而非吞掉）                                                                                                                                        |
| Minor 3    | safe-storage doc 的 safeSetItem 返回值例子失实               | ✅ 已修复           | `src/safe-storage.ts:5-10` 如实说明当前无消费方、poll-lease 是刻意的 fail-open                                                                                                                                                                                                                                                             |
| Nit 4      | `dispatchRelayedResult` 无 stopped 检查                      | ✅ 已处理（文档化） | `src/engine.ts:464-468` doc 明确 in-flight relay dispatch 在 stop 后仍会跑完，与 in-flight tick 容忍度一致                                                                                                                                                                                                                                 |
| Nit 5      | `clear()` 跨标签页竞态 doc 未说明                            | ✅ 已修复           | `src/ttl-dedupe-cache.ts:74-80` 点明 best-effort、可被并发 claim 复活，并给出 `withTabLock` 组合建议                                                                                                                                                                                                                                       |
| Nit 6      | `isPendingTaskShape` 未从包入口 re-export                    | ✅ 已修复           | `src/store.ts:55` + `src/index.ts:14`                                                                                                                                                                                                                                                                                                      |
| 测试缺口   | lease TTL 自然到期接管集成测试                               | ✅ 已补齐           | `test/engine.test.ts:510`：pollerA 不 stop（模拟崩溃 tab），真实等待 30ms 让 20ms TTL 过期后 pollerB 接管                                                                                                                                                                                                                                  |
| 测试缺口   | jsdom 无 Web Locks 的测试注释说明                            | ✅ 已补齐           | `test/engine.test.ts:482-487` 块注释                                                                                                                                                                                                                                                                                                       |

## 本轮新发现

### Minor 1. stop() 发生在 tick 两个任务之间时，后续任务仍会多发一次 `check()`

位置：`src/engine.ts:571-597`

本轮修复覆盖了 stop() 发生在 `check()` 进行中的场景（reconfirm 的 stopped 分支返回 false → fence 重置 → 后续任务短路）。但 stop() 还有第二个可达时机：任务 A 的 `finalize()` 内部（consumer 在 `onResult` 里调用 `poller.stop()`，或 React 组件恰好此时卸载触发 `stop()`）——此时 `fence` 仍持有 A 续约后的有效值，循环推进到任务 B 时 `:571` 的整块（含 `:572` 的 `this.stopped` 检查）因 `fence !== undefined` 被跳过，B 照常发起一次网络请求。响应随后被 reconfirm 的 stopped 分支正确丢弃，**无数据错误**，仅多发一次请求，与引擎文档化的 in-flight 容忍度不冲突。

**修复建议**（一行级）：把 `this.stopped` 检查提到 `fence === undefined` 条件之外，或在 for 循环顶部加 `if (this.stopped) break`。可补一个「onResult 里调 stop() 后第二个任务不再 check()」的用例。

### Minor 2. `claimResultOnce` 的 doc 未提「返回 false 也会抑制 relay 写入」

位置：`src/engine.ts:437-448`，对照 doc `:43-59`

claim 检查在 relay 写入之前，leader 的 `claimResultOnce` 若因「另一个 tab 已认领」之外的原因返回 false（如 doc 自己提到的 session 有效性检查），relay 不写、其他 tab 永远收不到该结果。非数据正确性问题（文档化的 withTabLock + dedupeCache 组合下，leader claim 失败意味着已有其他 tab 认领并会负责 dispatch），且该排序自第二轮就存在。建议在 doc 中点明这一语义，或引导需要 veto 语义的消费者改用 `acceptRelayedResult`。

## Nit

3. **错误分支的 mid-tick leadership 丢失无对应用例** — `test/engine.test.ts:637` 只覆盖成功路径（check() resolve 后 reconfirm 失败）；错误路径（check() throw 后 reconfirm 失败）是同构但独立的两段代码，建议补对称用例。
4. **`parseResultRelay` 接受 `"expired"` 状态，但引擎从不 relay expired** — `src/result-relay.ts:5-10` vs `src/engine.ts:421`。`RESULT_STATUSES` 里的 `"expired"` 是死状态（测试还 round-trip 了它），无害但与「relay 只承载 leader 实际 dispatch 的结果」的模型略有出入。
5. **README 的 lease 释放措辞略强于实现** — `README.md:140-141`："stop() also releases the lease immediately if held"。实现是 best-effort、不 await 的 fire-and-forget，极端场景（页面正在卸载）下 "immediately" 略失真。
6. **TTL 接管测试用真实计时器，余量较小** — `test/engine.test.ts:523`：真实 `setTimeout(30)` 等 20ms TTL，余量 1.5x，极度过载的 CI 上理论存在抖动（方向安全：setTimeout 只延迟不提前，lease 只会更过期；与项目既有的真实时间模式一致）。

## 回归检查结论

- 第一、二轮已修复项全部复核，未被本轮改动重新破坏：relay 发送仍不受 `dispatchDomEvent` 门控（`:440`，测试 `:757` 在位）；relay 接收仍过 `claimResultOnce`（`:470-496`）；`finalCheckAttempted` 的 add/delete 配对在全部新旧分支完整（含本轮两个 fence 重置分支）；stop-in-flight 不重认领（`:322-330`，测试 `:882`）；`JSON.stringify` 在 try 内。
- fence 的全部赋值点（`:592`、`:618`、`:677`）与重置点（`:615`、`:674`）已逐一枚举核对：除 Minor 1 的 stopped 窗口外，不存在 fence 失效但非 undefined 的残留路径；election 关闭时 fence 恒为 undefined、reconfirm 为 no-op，旧行为不变。
- 双语 README 与实现一致：TTL 默认值、relay 机制与 `acceptRelayedResult` 门禁、exactly-once 残留窗口的三条因果、PII 清理路径均与代码吻合；`clearResultRelay` 从包入口可达。

## 建议行动

| 优先级   | 事项                                                                               | 工作量     |
| -------- | ---------------------------------------------------------------------------------- | ---------- |
| 可合并   | 当前状态不阻塞合并                                                                 | —          |
| 建议顺手 | Minor 1：stopped 检查移出 `fence === undefined` 条件（或循环顶部 break）+ 一个用例 | 一行级改动 |
| 建议顺手 | Minor 2：`claimResultOnce` doc 补一句「返回 false 也抑制 relay」                   | 文档一句   |
| 可后续   | Nit 3-6                                                                            | 各自独立   |

---

## 附录：审查历史

- **第一轮**：2 Major（relay 发送被 `dispatchDomEvent` 误门控；relay 接收绕过 `claimResultOnce` 与 README 矛盾）+ 6 Minor + 5 Nit + 测试缺口。
- **第二轮**：13 项中 12 项已修复；Nit 10 部分修复并引出新 Major 1（`leadershipLost` 被 `fence !== undefined` 旁路）+ Minor 2（relay 写入位于可抛异常的 `onResult` 之后）。
- **第三轮（本轮）**：第二轮 8 项全部了结；新发现 1 个 Minor（stop()-between-tasks 残留窗口）+ 1 个 doc 级 Minor + 4 个 Nit。结论：可以合并。
