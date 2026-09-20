# cross-tab-kit 绿地架构设计

> 视角:假设今天从零开始,没有 0.1.0、没有兼容包袱,已知全部真实场景(S1-S8)和
> 平台约束。回答:这个库应该长什么样。
> 与 `architecture.md`(面向 v0.2 的现状演进方案)并存:本文是"应然",该文是"实然
> 路径"。两者结论高度一致,差异集中在 §7 测试设施、§3 API 呈现方式、§8 导出纪律。

## 1. 定位

**一个浏览器端、尽力而为(best-effort)的跨标签页协调库。**

- 服务对象:同源多标签页需要互斥、选主、去重的低频协调场景。
- 不服务:强一致(去服务端)、跨浏览器/设备(物理不可见)、消息广播
  (BroadcastChannel 原生足够)、高频状态同步(成本模型不符)。
- 最高原则:**诚实**——每个 API 的能力边界写在类型和文档里;失败时降级为
  "各标签页独立行动"(fail-open),永不静默阻塞或拖死应用。

## 2. 场景驱动:API 从场景倒推,不从原语正推

| 场景                                                                | 频率           | 绿地 API                                |
| ------------------------------------------------------------------- | -------------- | --------------------------------------- |
| S1 auth token 刷新去重("别人在刷我就跳过")                          | 极高           | `tryWithTabLock`                        |
| S2 WebSocket/SSE 单连接复用 + 失主接管                              | 高             | `createLeadershipLoop`                  |
| S3 后台轮询单点化                                                   | 高             | `createLeadershipLoop`                  |
| S3' 轮询引擎手动档选主(认领耦合业务 tick、空闲零存储流量、健康轮换) | 高(引擎类下游) | `createLeadershipGate`                  |
| S4 推送 token 注册每浏览器一次                                      | 高             | `withTabLock` / `tryWithTabLock`        |
| S5 通知只弹一次 + UI 查询"弹过没"                                   | 中高           | `createTtlDedupeCache`(含 `has`)        |
| S6 埋点去重(长会话条目累积)                                         | 中             | `createTtlDedupeCache`(含 `maxEntries`) |
| S7 "已在其他标签页打开"单实例                                       | 中             | `createLeadershipLoop`(不续租用法)      |
| S8 最后一个 tab 关闭时清理                                          | 中             | Presence(演进项,见 §10)                 |

> 场景成色说明:S1-S8 来自行业公认模式(token 跨 tab 刷新去重是 Auth0/Firebase 级
> SDK 的标准做法,单连接复用是实时应用的常见架构),**不是本库自己的用户遥测**;
> **S3' 例外——它来自首个真实下游
> [pending-task-kit](https://github.com/ueaner/pending-task-kit) 的显式需求清单**(见
> `docs/requirements-from-pending-task-kit.md` R1),是本文档第一个有真实消费方背书的
> 场景。其余场景在 v1.0 前应根据早期采用者反馈复核频率列。

绿地设计的第一原则由此确立:**用户首先接触的是场景级 API;原语存在,但默认藏在
`advanced` 子路径后面**(见 §3)。用户不需要先理解"lease 是什么"才能选对主。

## 3. 模块结构与导出纪律

```
src/
  kernel/               # 内部,不导出
    storage-cell.ts     # createStorageCell<T>:JSON 序列化 + 校验 + 静默降级,
                        #   lease/dedupe/presence 共用,消灭各自重写的 read/write
    logger.ts           # Logger 接口 + 告警通道(所有模块共用,不反向引用)
    clock.ts            # Date.now 封装(单一墙钟来源;跨 tab 只能比墙钟,测试用
                        #   vitest fake timers 全局 mock,不留注入钩子)
  locks/
    tab-lock.ts         # withTabLock(等待型)+ tryWithTabLock(跳过型)
  primitives/
    poll-lease.ts       # createPollLeaseClaimer(claim/release/fence)
    ttl-dedupe.ts       # createTtlDedupeCache(claim/has/clear)
  patterns/
    leadership-gate.ts  # createLeadershipGate(按需任期凭证,无定时器)
    leadership-loop.ts  # createLeadershipLoop = gate + 定时器驱动
  index.ts              # 主入口:场景级 API
  advanced.ts           # 子路径导出:原语 + 底层工具
```

package.json 导出映射:

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./advanced": "./dist/advanced.js"
  }
}
```

**主入口只导出**:`createLeadershipGate`、`createLeadershipLoop`、`withTabLock`、
`tryWithTabLock`、`createTtlDedupeCache` 及相关类型(含 `Logger`——主入口 API 的
options 用到它,两个入口都导出)。
**`./advanced` 导出**:`createPollLeaseClaimer`、`generatePollOwnerId`、safe-storage
三件套、`Logger`,以及具名类型 `PollLeaseClaimer`、**`PollLeaseClaimResult`**、
`PollLeaseClaimerOptions`——具名类型导出是下游契约(首个下游 pending-task-kit 显式
依赖 `PollLeaseClaimResult`,见 R2),不许退化为内联联合。语义约束:`claim`/`release`
保持同步、不隐式加锁、fail-open,release 写 tombstone 而非删除。

纪律:主入口的每个导出都必须能回答"它服务哪个 S 场景";答不上来的,去 advanced 或
不导出。版本承诺:1.0 之前允许破坏性调整(绿地阶段不给自己焊死表面积);自 1.0 起,
导出只增不减。主入口**新增**导出的采纳判据(三条须同时成立,防止主入口被单家下游
的定制需求渗透):①服务一类场景而非一家下游;②边际成本接近零——是既有内核的导出
而非新增实现;③手写替代有真实错法。gate 是首个按此判据入场的例子(判据全文见
§6.1)。

## 4. 锁层设计(tab-lock)

两个函数,语义与返回类型一一对应,不靠重载:

```ts
// 等待型:排队拿锁,拿到后执行。options 必传——waitTimeoutMs(等锁上限)不许缺省,
// 强制调用方显式做权衡;传 Infinity 表示刻意无限等
export function withTabLock<T>(
  name: string,
  operation: (ctx: TabLockContext) => Promise<T> | T,
  options: { signal?: AbortSignal; timeoutMs?: number; waitTimeoutMs: number },
): Promise<T>

// 跳过型:拿不到就跳过(S1 的正确语义——排队锁在 token 刷新场景是错的:
// 每个 tab 排队各刷一次,刷新接口会被服务端限流)。不排队,所以没有 waitTimeoutMs
export type TabLockResult<T> = { acquired: true; value: T } | { acquired: false }
export function tryWithTabLock<T>(
  name: string,
  operation: (ctx: TabLockContext) => Promise<T> | T,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<TabLockResult<T>>

export interface TabLockContext {
  /** timeoutMs 到期时 abort;传给 fetch 等,让超时成为真取消。
   *  注意:这与 options.signal 是两个独立信号——options.signal 中止的是"等锁"
   *  阶段(沿用 Web Locks 平台命名),timeoutSignal 通知的是"operation 该收手了"。
   *  名字不同是有意的:生命周期和触发条件都不同,共用一个名字必然被误读。 */
  readonly timeoutSignal: AbortSignal
}
```

设计决策:

- **timeoutMs 到期 = 释放锁 + abort ctx.timeoutSignal**。JS 无法强制中断不合作的代码;
  signal 把"可取消"变成协议。文档如实说明残余风险(互斥空窗)并要求副作用幂等。
- **不透传 Web Locks 的 `steal`**(单方面作废所有等待者的互斥假设)和
  `mode: "shared"`(需求频率低,需要时纯加法)。
- **死锁声明**:Web Locks 不可重入,同名嵌套/乱序多锁必死锁;运行时无法可靠检测
  (浏览器无 AsyncLocalStorage)。缓解靠两点:patterns 层内部自始至终一把锁;
  文档给出反例。
- 降级(无 Web Locks):两者都直接执行;`tryWithTabLock` 报 acquired——无锁可争时
  "跳过"没有语义,如实文档化。

**S1 的完整闭环**("跳过的人怎么拿到结果"——tryWithTabLock 只回答"谁来刷",
这半截必须写全):

```ts
const result = await tryWithTabLock("my-app:refresh-token", refreshToken)
if (!result.acquired) {
  // 别人在刷:等它把新 token 写进 localStorage 所触发的 storage 事件
  // (storage 事件只在其他标签页触发,"本 tab 等别人写入"正是它的适用场景)。
  // 等待必须带超时——刷新方可能失败,届时不能永久挂起,轮到自己再 try 一次。
  const token = await waitForStorageValue("my-app:token", { timeoutMs: 5_000 })
  if (token === null) return refreshFlow() // 超时:刷新方失败,自己上场
  return token
}
```

`waitForStorageValue` 是调用方侧几行代码(监听 storage 事件 + 超时),不属于本库
——等待/事件不是协调原语(§9)。

## 5. 原语设计

### 5.1 poll-lease(选主租约)

```ts
export interface PollLeaseClaimer {
  claim(ownerId: string): { leader: true; fence: number } | { leader: false }
  release(ownerId: string): void
}
```

核心不变式:

- **TTL 自愈**:holder 崩溃/冻结/被杀后停止续租,认定自动过期,接管不需要死者配合。
- **fence 严格递增**:ownerId 相同 ≠ 任期连续;release 写过期 tombstone 而非删除,
  防止代际回退与在途 fence 碰撞。
- **fail-open 写失败**:报成功(最坏双主一个 tick,下一次 claim 读到对方真实租约自愈),
  不报失败(会让本 tab 在存储持续损坏时永久沉默)。
- **校验**:ttlMs 必须正有限(`Infinity` 会永不过期、holder 死后无人接管);
  存储记录要求 ownerId/expiresAt/fence 齐备且数字有限,否则按垃圾数据处理。

### 5.2 ttl-dedupe(去重缓存)

```ts
export interface TtlDedupeCache {
  claim(id: string): boolean // 窗口内首次 true;固定窗口,重复不续期
  has(id: string): boolean // 无副作用查询(S5 的 UI 场景)
  clear(): void
}
// options: { logger?, maxEntries? } —— maxEntries 按 claimedAt 最旧逐出,
// 把"写爆 quota 后静默失效"变为有界失效
```

### 5.3 kernel:storage-cell(绿地新增的内部抽象)

0.1.0 里 lease 和 dedupe 各自手写了一遍"读 JSON → 校验 → 写回"。绿地里收敛为
`createStorageCell<T>(key, { validate })`,统一处理:JSON 解析异常、垃圾数据
(validate 逐条校验形状)、quota/隐私模式写失败的静默降级。

**原型污染防护要真正住进 cell,cell 的集合形态就必须以 `Map` 为规范表示**(审查修
正):读出时校验后还成 `Map`;写入时由 cell 统一走 `Object.fromEntries`——它用数据
属性定义而非 `[[Set]]`,`__proto__` 这类 key 才能安全落盘。如果 cell 只是通用对象
外壳,这项防护实质上仍留在 ttl-dedupe 自己手里,"统一处理原型污染"就是一句兑现不
了的话;把 Map 定为集合形态的合同,防护才真正归 cell 所有。单条记录形态
(poll-lease)没有此风险,走同一 cell 的普通对象路径。原语层只写业务判断。
**这是内部抽象,不导出**——它不服务任何 S 场景。

## 6. 模式层:LeadershipGate 与 LeadershipLoop

### 6.1 `createLeadershipGate`:按需任期(无定时器)

来源:首个真实下游 pending-task-kit 的显式需求(R1)。它证明"常驻任期 + 内置定时
器"不是选主的唯一正确形态——轮询引擎需要**与业务 tick 耦合的惰性认领**:空闲 tick
零存储流量(成本模型的一部分)、认领时机精确到"tick 内、首个网络请求之前"、健康
tab 之间随 TTL 自然轮换(有意设计,不是副作用)。

```ts
const gate = createLeadershipGate(storageKey, ttlMs, { logger })

// tick 内、首次网络调用前:
const tenure = await gate.acquire() // null = 当前不是 leader,本轮网络工作跳过
if (!tenure) return

// 每次网络调用后:
if (!(await tenure.isStillValid())) return // fence 比对失败,丢弃响应

gate.release() // 同步、best-effort tombstone
```

语义契约:

- **无内置定时器**:认领/续租全由调用方触发(命名即文档:gate ≠ loop)。
- `acquire()` = 带锁 claim;`tenure.isStillValid()` = 带锁 re-claim + fence 比对 +
  顺带续租——与 `LeadershipContext.isStillLeader()` 同语义,gate 才是它真正的归属。
- `tenure.signal`:失主时 abort。**检测时机必须点破**:手动档没有定时器,若只在
  `isStillValid()` 时检测,abort 永远晚于在途请求完成,"从事后丢弃升级为真正取消"
  就不成立。因此 gate 额外挂 `storage` 事件监听:其他 tab 认领成功会写租约 key,
  本 tab 即时收到事件(storage 事件恰好只在其他 tab 触发,正是"被别人夺走"的唯一
  情形),失主检测从"下次复查时"提前到"对方写盘时"。冻结 tab 的事件排队到解冻,
  语义安全。
- TTL 自愈 / fail-open / ttlMs 校验 / 同步 tombstone release:全部继承 poll-lease。

定位(诚实标注):gate 面向**引擎/tick 驱动型消费者**——它的两个卖点(空闲零存储
流量、健康 tab 轮换)是引擎级的讲究;应用层若需求是持续持有角色(轮询、长连接),
直接用 loop,不要为了"省几次存储写"上手动手档。采纳判据留痕:gate 进主入口不是
因为"一个下游要了",而是三条同时成立——**一类场景**(事件驱动的单主,不止
pending-task-kit 一家)、**边际成本约等于零**(它是 loop 本来就必须包含的内核,
导出 ≈ 零新增实现)、**手写替代有真坑**(fence 再确认、tombstone、abort 时机)。
未来下游新需求用同一把尺子量,防止主入口被单家定制渗透。

### 6.2 `createLeadershipLoop` = gate + 定时器驱动

实现上 loop 是 gate 之上的**薄驱动**(定时 acquire/isStillValid + 回调编排):
fence 比对、abort 链接、tombstone release 的全部逻辑只在 gate 里存在一份——
两个 API,一套实现。

```ts
export function createLeadershipLoop(
  storageKey: string,
  ttlMs: number,
  onLeadership: (ctx: LeadershipContext) => void | Promise<void>,
  options?: LeadershipLoopOptions,
): () => void // stop

export interface LeadershipContext {
  readonly fence: number
  readonly signal: AbortSignal // 失去 leadership 时 abort
  isStillLeader(): Promise<boolean> // 带锁 re-claim + fence 比对,顺带续租
}

export interface LeadershipLoopOptions {
  lockName?: string // 默认 = storageKey
  renewIntervalMs?: number // 默认 ttlMs / 3;必须正有限且 < ttlMs(否则构造期 RangeError:
  //   租约会在两次续租间过期,领导权 flap)
  waitTimeoutMs?: number // 继承自 gate:单次 claim 的等锁上限,默认 ttlMs
  releaseOnExit?: boolean // 默认 true;pagehide 尽力 release
  onLeadershipLost?: () => void
  logger?: Logger
}
```

语义契约(状态机):

```
        ┌──────────┐   claim 成功(新 fence)   ┌─────────┐
  ───▶  │ 跟随者    │ ───────────────────────▶ │ 领导者   │
        │ 定时 claim │                          │ 定时续租 │
        │          │ ◀─────────────────────── │         │
        └──────────┘   续租发现 fence 易主/被夺  └─────────┘
                          此时:旧 ctx.signal abort → onLeadershipLost
```

- `onLeadership` **每次获得新任期都触发**(含失去后夺回)——"loop"循环的是完整的
  当选→续租→失主→再当选周期;同一任期内不重复;`stop()` 后静默。
- **后台节流是设计输入,不是意外**:Chrome 对隐藏超 5 分钟的 tab 启用 intensive
  throttling(定时器对齐到分钟级)。ttlMs < 约 3 分钟时,后台 tab 续租必然断租,
  leadership 漂移到可见 tab——这通常正是期望行为(轮询发生在用户正看着的 tab);
  需要后台保持时文档指引 ttlMs ≥ 3 分钟。
- **release 是尽力而为**:pagehide 里同步写 tombstone 可靠,但崩溃/划杀时事件不
  触发,兜底为 TTL 过期。文档不承诺"一定释放"。

## 7. 测试设施:并发优先(绿地与现状最大的差异)

这个库的全部风险都长在并发交错上,绿地里测试夹具先于功能代码:

```
test/harness/
  fake-locks.ts      # 可控 Web Locks mock:FIFO 授权顺序、ifAvailable、signal 中止
                     #   等锁;"永不释放/授权后冻结"等剧本由测试回调自行持有 promise
  steppable.ts       # 在存储边界冻结读快照(getItem 拦截)来重演"读→判断→写"竞态
                     #   窗口——claim 是同步函数无法真拆步;冻结读快照覆盖了
                     #   localStorage RMW 的全部交错窗口,且跑的是真实代码路径
  tabs.ts            # 多 tab 模拟:共享 localStorage + 共享墙钟(真实 tab 比的就是
                     #   共享墙钟)+ 手动派发 storage 事件;"冻结的 tab"就是没人再
                     #   替它续租的 gate
```

要重演的剧本(每个对应一个真实失效模式):双 tab 同 tick claim(检查-认领竞态)、
leader 冻结后接管、fence 在"拿走又还回"后易主、pagehide 未触发的 TTL 兜底、
try-lock 撞上持锁者、超时后双 tab 短暂并存。单 tab 的 happy path 是第二梯队。

jsdom 给不了真多上下文,但**竞态窗口的本质是交错顺序,交错顺序是可模拟的**——
这是"测试能证明什么"的边界,写进测试文档。

## 8. 失效模式矩阵(对外承诺)

| 环境/事件                     | 行为                      | 用户感知                           |
| ----------------------------- | ------------------------- | ---------------------------------- |
| Web Locks 不可用              | 无互斥,直接执行           | try 报 acquired;选主退化为各自为政 |
| localStorage 写失败           | claim 报成功,下 tick 自愈 | 最坏双主一个 tick                  |
| localStorage 读也失败         | 完全退化                  | 与不开此库相同                     |
| 后台 tab intensive throttling | 续租断租,leadership 漂移  | ttlMs ≥ 3min 可避免                |
| 崩溃/划杀(无 pagehide)        | 无 release                | TTL 兜底,最坏等待一个 TTL          |
| 同名锁嵌套                    | 死锁                      | 文档反例;patterns 层内部单锁       |

## 9. 明确不做

- 强一致、跨浏览器/设备、消息广播、高频同步(同定位节)
- `steal`、读写锁、`inspect()`(等真实需求,都是纯加法)
- 任何隐式行为:原语不隐式加锁、不隐式续租;隐式策略只存在于明确叫 "loop" 的
  模式层 API 里——**用户看到"loop"就知道有后台定时器,看到 "gate" 就知道是无
  定时器的任期凭证,看到 "claim" 就知道是同步一次性动作**。命名即文档。

## 10. 演进路线

1. **v1.0**:本文全部内容(锁层 + 原语 + leadership gate/loop + harness)。
2. **v1.x**:Presence(`createTabPresence`:heartbeat + TTL 成员登记表,S8)。
3. **v2 评估**:SharedWorker 后端——worker 内存单线程权威 + port.close 即时失主
   检测,把"尽力而为"升级为"精确"(同源内)。届时 patterns 层 API 不变,只换
   底层 substrate;这就是接口与实现分离的红利。

## 11. 与 0.1.0 路径的差异摘要

| 维度                             | 0.1.0 → v0.2 路径   | 绿地设计                           |
| -------------------------------- | ------------------- | ---------------------------------- |
| API 呈现                         | 原语优先,L2 后补    | 场景优先,原语在 advanced 子路径    |
| 导出表面积                       | 全量顶层导出        | 主入口最小,advanced 收纳定制向 API |
| 存储防御                         | 每个原语各自实现    | kernel/storage-cell 统一           |
| 测试                             | 单 tab 逻辑测试先行 | 并发 harness 先行                  |
| 核心机制(租约/fence/锁语义/降级) | —                   | **完全一致,独立成立**              |
