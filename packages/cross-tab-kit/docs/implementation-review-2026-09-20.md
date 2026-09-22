# 绿地重写实现审查(2026-09-20)

> 审查对象:cross-tab-kit 绿地重写的工作区(未提交,基于 v0.1.0 tag 之后)。
> 视角:源码正确性 + 测试/文档兑现度 + 对照 `docs/requirements-from-pending-task-kit.md`
> 的下游需求落实情况。
>
> **复审状态(同日第三轮)**:下表所有发现已在当日修复并逐条复核,依据见文末
> 「复审记录」。第三轮复核后验证基线:95/95 测试通过(首轮 82),`tsc --noEmit`
> 干净。残留非阻塞项见文末(R-1 已在第三轮解决,R-2 结论为不修)。

## 首轮验证基线(审查时全部通过)

`tsc --noEmit`、`oxlint src test`、`oxfmt --check`、`vitest run`(82/82,8 个文件)、
`tsdown` 构建(index/advanced 双入口 + 共享 chunk 布局正确)、`publint`。

## 总结论

重写整体质量高,绿地架构的核心机制(租约/fence/锁语义/降级)兑现完整,六个并发
竞态剧本都有真实测试。首轮问题集中在:**`LeadershipGate.release()` 的并发纪律**、
**文档/测试与实现的多处漂移**——两轮后均已闭环。

## 源码发现

### S1(中):`LeadershipGate.release()` 不经过锁 —— ✅ 已修复

`src/patterns/leadership-gate.ts:118-124`(首轮位置)— `claim` 经
`withTabLock(lockName, ...)` 串行化,但 `release()` 裸调 `claimer.release(ownerId)`。
释放可与另一个 tab 正在进行的 claim 交错:

1. release 读出「当前是我持有」
2. 对方 tab 的 claim 成功,写入新租约(fence N+1)
3. release 把过期 tombstone **连同旧 fence N** 覆盖写回

后果:fence 回退,第三方可立刻再认领,出现短暂双主窗口。兜底层(对方写入触发
storage 事件 → abort 本地 tenure;fence 再确认)能自愈,不是正确性灾难,但窗口
真实存在。相对 0.1.0 的用法也是倒退——pending-task-kit 里 release 本就包在
`withTabLock` 里(`releaseLeadership`)。

**修复**(`leadership-gate.ts:138-150`):保持同步签名,`abortActive()` 同步执行,
tombstone 写入改为 fire-and-forget 的
`void withTabLock(lockName, () => claimer.release(ownerId)).catch(() => undefined)`。
排序正确性:同一 lock name 的 Web Locks 请求按 FIFO 授权,`release()` 后紧跟
`acquire()` 时 tombstone 一定先于新 claim 的读取落盘;pagehide 时锁请求可能来不及
授予,已写入 doc comment。`leadership-loop` 的 stop/pagehide 路径一并受益。
排序的直接断言已由 R-1 的修复补齐(见文末残留项)。

### S2(低):`onStorage` 不处理 `event.key === null` —— ✅ 已修复

首轮:`localStorage.clear()` 以 `key: null` 触发,抹掉 lease 且 fence 归零——正是
tombstone 注释强调的「fence 不能忘」场景。

**修复**(`leadership-gate.ts:75-89`):`key === null`(clear)和
`newValue === null`(removeItem 抹掉 lease key)都保守 `abortActive()`;误杀当前
tenure 无害,下次 `acquire()` 自会恢复。测试:`leadership-gate.test.ts:103-122`。

### S3(低):pagehide 会触发 `onLeadershipLost` —— ✅ 已修复

首轮:`leadership-loop.ts` 的 pagehide 路径调 `gate.release()` → tenure abort →
`stopped` 仍为 false → `onLeadershipLost` 触发,与文档「主动关闭不是丢失」矛盾。

**修复**:引入 `TENURE_RELEASED_REASON`(`leadership-gate.ts:33`)区分主动释放与
被夺/失效;loop 的 `onTenureAborted`(`leadership-loop.ts:70-77`)对主动释放保持
沉默;文档改为「Not called on `stop()` or the pagehide release」。测试:
`leadership-loop.test.ts:166-179`(pagehide 沉默且 tombstone 落盘)、
`leadership-gate.test.ts:49`(reason 钉扎)。

### S4(低):主入口导出了绿地 §3 清单外的 `createLeadershipGate` —— ✅ 已修复

**修复**:绿地 §3 主入口清单已补记 `createLeadershipGate`(及 Logger 双入口口径,
见 T8)。

## 测试与文档发现

### T1(高):changeset 虚假宣传 —— ✅ 已修复

首轮:`.changeset/witty-tables-timeout.md` 把 0.1.0 已有的能力(`withTabLock` 的
`signal`/`timeoutMs`、poll-lease 的 ttlMs 告警)当新功能宣布。

**修复**:changeset 只保留真正的新增。复核时还纠正了首轮的一处误判:0.1.0 的
poll-lease 只对 `ttlMs <= 0` 告警(`NaN <= 0` 为 false,NaN 会漏网),所以
NaN/Infinity 告警确实是新增——changeset 现在的表述是准确的。

### T2(高):`test/exports.test.ts` 只钉住一半导出纪律 —— ✅ 已修复(有一处耦合注意)

**修复**:类型导出(`PollLeaseClaimResult` 等)改用「命名类型 import + 用作真实值的
注解」钉扎,删除即编译失败;构建产物面的验证由 CI 的 `build` + `pub:check`
(publint)承担,测试文件头注释写明了分工。注意:vitest 不做类型检查,这一半
依赖 CI 的 typecheck 步骤才生效——见残留项 R-2。

### T3(高):`docs/architecture.md` 已过时且无 superseded 标注 —— ✅ 已修复

**修复**(`architecture.md:3-5`):头部加了「【已取代】实际落地采用了
architecture-greenfield.md 的绿地设计……保留仅供历史参考」。

### T4(高):绿地 §7 harness 承诺未兑现、文档未回改 —— ✅ 已修复

**修复**:§7 改为如实描述现状(fake-locks 的 FIFO/ifAvailable/signal 能力 +
「永不释放/冻结由测试回调持有 promise」;steppable 是存储边界读冻结,claim 是
同步函数无法真拆步;tabs 共享 localStorage + 共享墙钟 + 手动派发 storage 事件);
§3 的 clock 行改为「测试用 vitest fake timers 全局 mock,不留注入钩子」。
`kernel/clock.ts` 的 `setNowForTesting` 冗余钩子已删除。

### T5(中):`createLeadershipLoop` 的锁内路径零覆盖 —— ✅ 已修复

**修复**:新增 `describe("createLeadershipLoop with Web Locks available")`
(`leadership-loop.test.ts:224-303`):双 loop 竞争只选出一个 leader、`lockName`
路由、自定义 `renewIntervalMs`、抛异常的 `onLeadership` 走 logger 且 loop 继续。

### T6(中):§8 失效矩阵几行无测试 —— ✅ 已修复

**修复**:读失败完全退化(`poll-lease.test.ts:112`)、`release()` 写失败
(`poll-lease.test.ts:126`)、dedupe `claim()` 写失败 fail-open
(`ttl-dedupe.test.ts:115`)、loop 错过 storage 事件后于续租时发现 fence 易主
(`leadership-loop.test.ts:181`)。

### T7(低):其余确认健康的部分(首轮结论,仍成立)

- 六个 §7 竞态剧本全部真实存在且证明了真东西:同 tick 双 claim、冻结接管、fence
  churn、try-lock 竞争、超时并存(断言了互斥空窗本身)、pagehide/stop 语义
- 无 tautology;真实计时器仅 `poll-lease.test.ts` 一处(margin 安全)
- 双语 README 与实现一致;`package.json`/`tsdown.config.ts` 双入口配置正确

### T8(低):`Logger` 主入口导出与 §3 口径不一致 —— ✅ 已修复

**修复**:绿地 §3 改为「及相关类型(含 `Logger`——主入口 API 的 options 用到它,
两个入口都导出)」,与 `src/index.ts`、`src/advanced.ts`、changeset 统一。

## 下游需求落实情况(对照 requirements-from-pending-task-kit.md)

| 需求                 | 状态           | 备注                                                                         |
| -------------------- | -------------- | ---------------------------------------------------------------------------- |
| R1 手动档选主        | ✅ 已落地      | `createLeadershipGate` 契约逐条吻合;S1 修复后 release 走锁的隐含前提也已满足 |
| R2 advanced 兜底契约 | ✅ 完全满足    | `PollLeaseClaimResult` 具名导出在内,且被 exports 测试钉住(T2)                |
| R3 降级路径保留      | ✅ 保留        | loop 的锁内路径也已有测试(T5)                                                |
| R4 safe-storage 去向 | ✅ 在 advanced | 符合绿地导出纪律                                                             |

## 复审记录(2026-09-20 第二轮)

首轮发现 S1-S4、T1-T6、T8 全部修复并逐条复核(依据见各条目)。复审验证:
`vitest run` 94/94(首轮 82,新增 12 个测试),`tsc --noEmit` 干净。

残留项(均非阻塞):

- **R-1**:~~release 走锁的**排序**只有间接断言~~ ✅ 已解决(同日第三轮):
  新增直接测试 `leadership-gate.test.ts` 的「release()'s tombstone write is ordered
  through the lock」——外部持有者占住 mutex 后调 `release()`,断言 tombstone 在锁
  被占期间不落盘(`expiresAt !== 0`)、竞争者 claim 经 FIFO 排在 tombstone 之后,
  最终 fence 单调到 2。变异验证:把 `release()` 退化回裸写,该测试如期失败。
- **R-2**:exports 测试的类型钉扎依赖 CI 的 typecheck 步骤才生效(vitest 不做类型
  检查),这层耦合目前只在测试文件头注释里说明;typecheck 若从 CI 移除会静默失效。
  第三轮复核结论:**不修**——钉扎现在就是生效的(`tsconfig.json` 的 `include`
  覆盖 `test/`,CI 与 `prepublishOnly` 都跑 `tsc --noEmit`),为「有人删掉 CI 步骤」
  这一假设引入 vitest typecheck 模式(第二套类型检查工具链)得不偿失。
- **R-3**:`poll-lease.test.ts` 仍有一处真实计时器(`sleep(20)` vs ttl 10ms,
  margin 安全,沿用旧状)。
- **R-4**:两份架构 review 文档(`architecture-review.md`、
  `architecture-greenfield-review.md`)的已修复条目仍未标注 resolved——本文档的
  标注方式(逐条 ✅ + 复审记录)可作为样式参考。
