# 接入 cross-tab-kit 0.4.0(0.3.0 + 本次新增导出)的方案

> **状态更新(2026-09-21)**:cross-tab-kit 0.4.0 已经发布——`main` 已推送
> (`a27fa88` feat + `c863f1b` chore: version packages)、`v0.4.0` 标签已推送、
> release workflow 跑完并 `pnpm publish --provenance` 成功,`registry.npmjs.org`
> 已核实可查到(`dist-tags.latest = "0.4.0"`,`exports` map 与本地一致),
> `unpkg.com/cross-tab-kit@0.4.0/dist/index.d.ts` 里能直接看到
> `SHORT_TTL_WARN_MS`/`SLOW_WAIT_WARN_MS`/`linkAbortSignal` 三个导出。下面 §7
> 步骤 0 的「前置发布」已完成,不再是待办。
>
> 目标:pending-task-kit 从 `cross-tab-kit@0.1.0`(精确 pin)升级到 0.4.0——
> 0.3.0 基础上,cross-tab-kit 侧新增导出了 `SHORT_TTL_WARN_MS`/`SLOW_WAIT_WARN_MS`
> 两个阈值常量和 `linkAbortSignal` 工具函数,专门为下面 §3.3 的接线需求准备,
> 已发布、已核实、可以直接依赖。
> 收益:选主机制从手工租约管理切换到 R1 催生的 `createLeadershipGate`(主入口),
> 并获得 0.2.0/0.3.0 的三项能力——等锁有界、失主即时检测、在途请求真取消——
> 其中「在途请求真取消」现在有 cross-tab-kit 官方导出的 `linkAbortSignal`
> 可以直接复用,不用自己手搓监听器生命周期管理。
> 代价:engine.ts 约 120 行选举代码重写,三处可观察行为变化。
> 入口纪律:场景级 API(gate、`linkAbortSignal`)用主入口;safe-storage 这类
> 底层工具按上游的分层设计从 `cross-tab-kit/advanced` 导入——这正是 advanced
> 子路径设立的用途(「给要自建 localStorage 持久化的人」),不违反纪律。

## 0. 0.1.0 → 0.3.0 的关键 API 事实(方案的事实基础)

- `createLeadershipGate(storageKey, ttlMs, options?)`(主入口):`acquire()` →
  `Tenure | null`;`Tenure = { fence, signal, isStillValid() }`;`release()` 同步,
  tombstone 经锁串行化。同一 tenure 续期返回**同一个对象**(可按 identity 比较)
- `acquire()`/`isStillValid()` 在等仲裁锁超过 `waitTimeoutMs`(默认 = `ttlMs`)时
  **resolve null/false 而不是 reject**(0.3.0 语义:与「别人持有」同等地位);
  等待超过 `min(waitTimeoutMs / 2, SLOW_WAIT_WARN_MS)`(即 5000ms 封顶,不是单纯
  「一半」)时经 logger 告警一次(每实例)——`SLOW_WAIT_WARN_MS` 现在是主入口的
  公开常量(值 `5_000`),不用再去猜源码里的字面量
- 任期凭证的 `signal` 在对方 claim 写盘落地时(storage 事件)即刻 abort
- **无效 `ttlMs` 在构造时抛 `RangeError`**(0.1.0 是 logger 告警,行为变化);
  `ttlMs < SHORT_TTL_WARN_MS`(公开常量,值 `1_000`)有一条短 TTL 成本告警——
  这条校验其实在 0.2.0 就已经存在于 `createPollLeaseClaimer` 里,`engine.ts:290`
  今天就在**无条件**调用它(不受 `crossTabPollLeaderElection` 开关影响),所以哪怕
  不做 §3 的 gate 重写、只做最小依赖升级,这条 `RangeError` 行为变化也会发生——
  不是「选了 gate 架构才引入」的代价,而是版本号升级本身就带的,见 §5 B3 的更正
- `withTabLock` 的 `options` 及其中 `waitTimeoutMs` 现在是**必填**(传 `Infinity`
  表示无界)——影响 README 的 `claimResultOnce` 组合示例
- safe-storage 三件套(`safeGetItem`/`safeSetItem`/`safeRemoveItem`)在
  `cross-tab-kit/advanced` 子路径,直接从那里导入(见 §2)
- **新增**:主入口导出 `linkAbortSignal(source: AbortSignal, target: AbortController): () => void`——
  `source` abort 时(或已经 abort 时立即)让 `target` 跟着 abort 并透传
  `source.reason`,返回值必须在关联的工作结束后调用以摘除监听器。`withTabLock`
  自己合并 `options.signal` 时内部也改用了这个工具(0.3.0 之前是手搓的,行为不变)。
  这就是 §3.3 需要的原语,不用自己重新实现一遍监听器生命周期管理

## 1. 依赖与配置

1. `package.json`:`"cross-tab-kit": "0.1.0"` → `"0.4.0"`(`linkAbortSignal`/
   两个常量在 0.4.0 已发布可用,见文首状态更新;维持精确 pin 风格,若想跟
   patch 可用 `~0.4.0`,0.x 下 `^` 只覆盖 0.4.x 也等价)
2. `pnpm-workspace.yaml`:`minimumReleaseAgeExclude` 里的 `cross-tab-kit@0.1.0` 改为
   `cross-tab-kit@0.4.0`——0.4.0 是刚发布的版本,会被供应链冷却期挡住,不改会
   导致 `pnpm install`/CI 卡住
3. `pnpm install` 更新 lockfile

## 2. safe-storage 改用 `cross-tab-kit/advanced`

`src/store.ts:1` 和 `src/result-relay.ts:1` 的 import 从 `"cross-tab-kit"` 改为
`"cross-tab-kit/advanced"`(`safeGetItem`/`safeSetItem`/`safeRemoveItem` 三个符号,
0.1.0 时代就在用,语义未变)。不内联回本地——避免两仓库各维护一份相同的
try/catch 薄封装,且 advanced 子路径本来就是为此设立的。

打包注意:tsdown 按 `dependencies` 外置依赖,需确认子路径 import
(`cross-tab-kit/advanced`)同样被外置而不是被打包内联——在 §7 验证步骤里检查
`dist/*.js` 的产物中该 import 保持原样。`exports` map 里 `./advanced` 带
`types` + `default` 条件,`publint` 已在 CI 覆盖这个面。

## 3. engine.ts 选举机制重写(核心)

### 3.1 删除

- 字段:`ownerId`、`pollLease`(`src/engine.ts:227-228`);构造函数里的
  `createPollLeaseClaimer`(`src/engine.ts:290-292`)
- 方法:`claimLeadership`、`reconfirmLeadership`、`releaseLeadership`
  (`src/engine.ts:400-486`)
- `runTick` 里的 `fence` 变量及其跨任务传递(`src/engine.ts:663` 起)

### 3.2 新增:gate 生命周期

```ts
// 构造函数——仅在 crossTabPollLeaderElection 开启时才构造 gate(今天的
// createPollLeaseClaimer 调用是无条件的,见 engine.ts:290;这里顺手把它改成
// 有条件,是这次重写真正引入的行为变化,不是 RangeError 那条——见下方注释):
if (this.options.crossTabPollLeaderElection) {
  this.gate = createLeadershipGate(pollLeaseKey, pollLeaseTtlMs, { logger })
}
// 无效 pollLeaseTtlMs 在构造时抛 RangeError,这本身是版本升级自带的(见 §0),
// 跟选不选 gate 架构无关。这里改成有条件构造之后,才第一次让「关闭选主时传
// 非法 pollLeaseTtlMs 不应该报错」成立——今天(哪怕只做最小依赖升级不动选举
// 逻辑)是做不到的,因为 pollLease 字段现在就是无条件构造的。

// 实例字段:let tenure: Tenure | null = null(每个 tick 内复用,等价于今天的 fence)

// runTick 内,需要 leadership 的任务:
//   前:fence === undefined 时 claimLeadership()
//   后:if (!tenure) tenure = await gate.acquire()
//       acquire 返回 null → 与今天「认领失败」同路:本 tick 后续到期任务跳过网络工作
// 每次 check() 后(成功/异常两条路径):
//   前:reconfirmLeadership(task, expired, fence)
//   后:await tenure.isStillValid() —— false 则丢弃响应、tenure = null、
//       本 tick 后续任务跳过(与今天 leadershipLost 短路相同的形状)

// stop():
//   前:void this.releaseLeadership().catch(...); setLeaderStatus(false)
//   后:this.gate?.release(); setLeaderStatus(false)
```

`setLeaderStatus(true)` 在 acquire 成功时调用,`(false)` 在 acquire 返回 null、
`isStillValid()` 返回 false、stop() 时调用——`onLeaderChange` 语义不变。

### 3.3 tenure.signal 接入在途取消(用 cross-tab-kit 新导出的 `linkAbortSignal`)

把当前 tenure 的 `signal` 链接到 `inFlightAbortController`(stop() 已用的那个
通道):leadership 被夺时(对方写盘触发 storage 事件),在途的 `handler.check()`
收到**真正的 abort**,而不只是响应回来后丢弃。

这**不是**免费的——`tenure` 在同一任期内跨多个 task 复用同一个对象,而
`abortController` 是每个 task 的 `handler.check()` 各自新建的(见
`src/engine.ts:808`),所以每次新建 `abortController` 都要重新挂一次监听器,
并在这次 check 结束(成功/失败/超时任一路径)后主动摘掉——否则要么监听器在
长任期里跨 task 累积不清理,要么某次 check 早已结束后 `tenure.signal` 才 abort,
触发一次对着已经用完的旧 `abortController` 的空操作。cross-tab-kit 这次专门
为这个模式导出了 `linkAbortSignal(source, target): () => void`(见 §0),
用它可以把生命周期管理收窄成一行 + 一个 `finally`:

```ts
const abortController = new AbortController()
this.inFlightAbortController = abortController
const unlink = tenure ? linkAbortSignal(tenure.signal, abortController) : undefined
try {
  result = await handler.check(task, abortController.signal)
} finally {
  unlink?.()
  if (this.inFlightAbortController === abortController) this.inFlightAbortController = undefined
}
```

`finalCheckAttempted` 簿记的清理逻辑(现在在 `reconfirmLeadership` 各分支里)
随 abort/invalid 路径一并保留。

## 4. 测试调整

- **现有选举测试基本不动**:它们直接往 localStorage 写
  `{ ownerId: "other-tab", fence: 2, expiresAt: ... }` 模拟对手——租约记录格式
  0.3.0 未变,这些 fixture 继续有效;jsdom 无 `navigator.locks`,gate 走降级路径,
  与今天测试的同一路径。jsdom 里同 tab 写盘不触发 storage 事件,失主检测仍由
  `isStillValid()` 完成(与今天行为一致)
- **新增**:
  - 派发一个「对手租约」的真实 `StorageEvent`(在 jsdom 里手动
    `window.dispatchEvent(new StorageEvent(...))`,不能用 `localStorage.setItem`
    模拟——后者同 tab 不触发 storage 事件,见上一条)→ 当前 tenure 的 `signal`
    abort、在途 `handler.check()` 收到的 `signal` 变成 `aborted`(3.3 的新接线;
    `linkAbortSignal` 本身的单测已经在 cross-tab-kit 侧覆盖 `test/abort.test.ts`,
    这里只需要覆盖「接线在 engine.ts 里确实生效」这一层)
  - 无效 `pollLeaseTtlMs`(`crossTabPollLeaderElection` 默认开启时)→ 构造抛
    `RangeError`(B3)
  - **反向回归**:`crossTabPollLeaderElection: false` + 非法 `pollLeaseTtlMs`
    (如 `0`)**不应该**抛错——验证 §3.2「仅开启选主才构造 gate」确实生效,这是
    本次重写相对于「只做最小依赖升级」多修的一个既有小问题(见 §0 关于 B3
    归因的说明)
  - `acquire()` 返回 null 时本 tick 后续任务不发起 `check()`(替代原
    「认领失败短路」用例的断言形态)
- **e2e**(`test-e2e/leader-election.spec.ts`):真实双 tab,逻辑不变;注意
  `pollLeaseTtlMs: 300` 的用例会触发 gate 的短 TTL 告警(< `SHORT_TTL_WARN_MS`
  = 1000ms),把该值调到 ≥1000 或接受 console 噪音
- **单测同样有一处会撞到短 TTL 告警**:`test/engine.test.ts` 里 "lets a second
  poller naturally take over once the first tab's lease expires" 用例用的是
  `pollLeaseTtlMs: 20`(比 e2e 那个 300 还小),重写后会在两个 `new PendingTaskPoller`
  的构造阶段各触发一次 `SHORT_TTL_WARN_MS` 告警。这个用例默认 logger 是
  `console`,不会导致断言失败,但如果之后给这类用例加了「不允许有意外 console.warn」
  的全局校验,这里会先炸——升级时要么把它也一并列进「接受告警噪音」的清单,要么
  改用一个吞掉这条告警的 logger

## 5. 可观察行为变化(写进 changeset,minor)

- **B1**:leadership 被夺时,在途 `handler.check()` 会收到 abort(原:仅事后丢弃
  响应)——对接了 `signal` 的 handler 表现为请求被取消,未接的无变化
- **B2**:认领等待从「理论上可无限排队」变为「超过 `pollLeaseTtlMs` 视为本轮非
  leader,下个 tick 再来」——消除了 holder 挂起时的永久卡死面
- **B3**:无效 `pollLeaseTtlMs`(非正/非有限)、且 `crossTabPollLeaderElection`
  未显式关闭时,在构造 `PendingTaskPoller` 时抛 `RangeError`(原:logger 告警后
  带病运行)——**这一条其实是升级 cross-tab-kit 版本号本身带来的**(`createPollLeaseClaimer`
  的 ttlMs 校验是 0.2.0 就有的,`engine.ts:290` 今天无条件调用它),哪怕不做本方案
  的 gate 重写、只做 §1/§2 的最小依赖升级也会发生,不是选择 gate 架构才引入的代价
- **B4**(本次重写新增,B3 的修复):`crossTabPollLeaderElection: false` 时不再
  构造任何 lease/gate,因此这条路径下非法 `pollLeaseTtlMs` **不会**抛错——修复了
  现状「关掉选主也会被无条件校验」的问题,详见 §3.2

## 6. 文档更新

- `README.md` / `README.zh-CN.md` 的 `claimResultOnce` 组合示例:
  `withTabLock(name, op)` → `withTabLock(name, op, { waitTimeoutMs: ... })`
  (0.3.0 必填项);正文补一句「等待上限按你的会话/刷新超时取,传 `Infinity`
  表示无界」
- 双语 README 的选主章节:B1/B2 两点的语义描述更新(「失主检测从事后丢弃升级
  为即时取消」「等锁有界」)
- `src/engine.ts` doc comment:`claimResultOnce` 里对 `withTabLock` 的引用表述
  检查一遍(「genuine async yield」等说法仍成立,但可顺手指明 `waitTimeoutMs`
  必填)

## 7. 实施顺序与验证

0. ~~前置:cross-tab-kit 发布 0.4.0~~ ——**已完成**,见文首状态更新,可直接进入下一步
1. §1 依赖升级(`"cross-tab-kit": "0.4.0"`)→ `pnpm install`
2. §2 safe-storage 切换到 `cross-tab-kit/advanced`
3. §3 engine.ts 重写(§3.3 直接从主入口导入 `linkAbortSignal`)
4. §4 测试调整与新增
5. §6 文档 + changeset(minor)
6. 验证:`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
&& pnpm test:e2e && pnpm pub:check` 全绿;另查 `dist/index.js` 与分 chunk 产物中
   `"cross-tab-kit"` 和 `"cross-tab-kit/advanced"` 均为 external import(未被内联)

风险评估:engine.ts 的重写是「同构替换」——gate 的 acquire/isStillValid/release
与现有 claim/reconfirm/releaseLeadership 一一对应,租约记录格式未变(滚动发布期间
新旧版本 tab 可互认租约,fence 语义一致);最大风险点在 §3.3 的 abort 链接引入的
时序变化,由 §4 新增测试覆盖。
