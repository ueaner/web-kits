# 来自 pending-task-kit 的需求

> 背景:[pending-task-kit](https://github.com/ueaner/pending-task-kit) 是一个浏览器端
> 长任务跟踪/轮询引擎(0.4.0),目前 pin 在 `cross-tab-kit@0.1.0`,用它做跨标签页
> 轮询选主和安全存储。cross-tab-kit 按 `docs/architecture-greenfield.md` 重写时,
> 本文是 pending-task-kit 作为下游用户提出的需求清单。
>
> pending-task-kit 的自我约束:**只消费主入口(场景级 API),不碰 `advanced`**。
> R1 是这个约束下的核心诉求;R2 是 R1 不被接纳时的兜底契约。

## R1(P0,核心):调用方驱动节奏的选主 —— LeadershipLoop 的"手动档"

### 现状用法

`PendingTaskPoller` 的选主不是常驻任期,而是**与轮询 tick 耦合的惰性认领**:

1. 一个 tick 扫到没有到期任务时,完全不碰 localStorage——零存储流量是成本模型的
   一部分(`engine.ts` `runTick` 的 pre-check 块,认领只发生在第一个真正要做网络
   请求的任务之前)
2. 认领后,**每次 `handler.check()` 返回都用 fence 再确认一次 leadership**(成功
   路径和异常路径各一处),防止慢请求期间 leadership 易主后响应被误用;fence 比对
   覆盖"lease 过期→别的 tab 接管并完成→lease 再过期的完整 churn"场景
3. `stop()` 是同步 API,release 是同步、best-effort 的 tombstone 写入
4. 健康的前台 tab 之间 leadership 例行轮换(lease TTL 8s,只在有活的 tick 上
   续约,两个 check 之间自然过期)——这是有意设计,不是副作用

### 为什么 `createLeadershipLoop` 不满足

绿地 §6 的 loop 是内置定时器的常驻任期模型(`renewIntervalMs = ttlMs/3`),差异:

- 空闲 leader 也有周期性存储写入,破坏上面第 1 条的成本模型
- 健康 leader 持续持有,破坏第 4 条的轮换语义
- 认领时机由库内的定时器决定,而 poller 需要"认领发生在 tick 内、网络调用之前"
  的精确时序

### 语义契约(验收标准)

1. **认领/续租由调用方触发,库不内置定时器**——看到 "loop" 以外的名字就知道没有
   后台定时器(呼应绿地 §9 的"命名即文档")
2. 认领返回带 fence 的任期凭证;提供"再确认"操作,语义 = **带锁 re-claim +
   fence 比对 + 顺带续租**(与 `LeadershipContext.isStillLeader()` 相同),返回
   false 表示任期已断,调用方丢弃在途结果
3. 任期 TTL 自愈:holder 死亡/冻结后任一下游调用即可接管,无需死者配合
4. release 同步、best-effort、写 tombstone 而非删除(防 fence 代际回退)
5. 任期凭证上带 `AbortSignal`,失主时 abort——调用方可以把它链接进自己在途的
   网络请求,让"失主"从事后丢弃升级为真正取消
6. fail-open:存储写失败时认领报成功(最坏双主一个 tick,下一次读到对方真实
   租约自愈),不报失败
7. `ttlMs` 校验(正、有限)+ 可注入 `logger`

### 建议形态(供讨论,不绑定实现)

`createLeadershipLoop` 加 `driver: "manual"` 变体,或独立导出,例如:

```ts
const gate = createLeadershipGate(storageKey, ttlMs, { logger })

// tick 内、首次网络调用前:
const tenure = await gate.acquire() // null = 当前不是 leader,跳过本轮网络工作
if (!tenure) return

// 每次网络调用后:
if (!(await tenure.isStillValid())) return // fence 比对失败,丢弃响应

// stop():
gate.release() // 同步、best-effort
```

## R2(P0,兜底):R1 不接纳时的 `advanced` 契约

如果 R1 不在 v1.0 范围内,pending-task-kit 将破例依赖 `advanced` 子路径。此时需要
以下导出和语义**全部保留**(对照 0.1.0):

- 导出:`createPollLeaseClaimer`、`generatePollOwnerId`,类型 `PollLeaseClaimer`、
  **`PollLeaseClaimResult`(必须是具名导出**——绿地 §5.1 把返回类型写成了内联联合,
  本文是唯一明确点名的下游使用方)、`PollLeaseClaimerOptions`、`Logger`
- `claim()`/`release()` 保持**同步、不隐式加锁**(调用方自己用 `withTabLock`
  包裹做仲裁);fail-open 语义不变;release 保持同步 tombstone

## R3(P1):降级路径保留

无 Web Locks 环境(jsdom、老浏览器、非安全上下文)下,锁和选主降级为"直接执行/
各自为政"。pending-task-kit 的 vitest 套件结构性地跑在这条降级路径上,其 e2e 套件
(真实 Chromium)覆盖真锁路径——降级语义改变会静默废掉前者。

## R4(供参考,非需求):safe-storage 的去向

`store.ts`/`result-relay.ts` 用到 `safeGetItem`/`safeSetItem`/`safeRemoveItem`
(异常全吞、`safeSetItem` 返回 boolean)。在"不碰 advanced"的约束下,
pending-task-kit 会把这三个 helper 内联回自己仓库(它们本来就出生在那里,约 30
行)。如果 cross-tab-kit 认为 S4/S5 的场景用户同样会需要安全存储读写,留在主入口
是纯加法;但尊重绿地 §3 的导出纪律,不作为正式需求提出。

## 版本与时间

pending-task-kit 的 `package.json` pin 在精确的 `cross-tab-kit@0.1.0`,rewrite
期间不受任何影响,升级窗口完全自由——R1/R2 无论哪个落地,配合一次 import 路径
调整即可完成迁移。
