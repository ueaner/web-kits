# cross-tab-kit 架构方案

> **【已取代】本文是面向 v0.2 的演进方案;实际落地采用了
> [architecture-greenfield.md](./architecture-greenfield.md) 的绿地设计(0.2.0 为
> breaking 重写,含 `./advanced` 子路径)。保留仅供历史参考。**

> 版本:面向 v0.2(下一次 minor 发布)
> 状态:提案
> 范围:明确库的定位与一致性天花板,给出分层架构和 API 变更方案,逐条记录取舍。
> 本文允许并指导对 `src/` 代码结构与导出方法的调整。

## 1. 问题域

同源多标签页需要协调的三类典型诉求:

1. **互斥**:某段副作用(写 storage、同步 token)同一时刻只在一个标签页执行。
2. **选主**:持续性的单点角色(轮询者、心跳上报者),且 holder 消失后别人能接管。
3. **去重**:一个事件(通知、上报)不管多少标签页抢着处理,只真正触发一次。

共同约束:浏览器没有跨标签页的事务原语;标签页随时可能崩溃、被冻结(bfcache)、被
杀死;localStorage / Web Locks 都可能不可用或静默失效。

## 2. 定位(Positioning)

**cross-tab-kit 是"降低碰撞概率的浏览器端协调工具",不是分布式锁服务。**

三条设计信条:

1. **诚实优先**:每个原语的能力边界和失效模式必须写在 API 文档里,不用抽象去掩盖
   "协调可能失败"这件事。降级方向永远是"各标签页独立行动"(fail-open),永不静默
   阻塞或抛错把应用拖死。
2. **原语最小、可组合**:底层原语不做隐藏策略(不隐式加锁、不隐式续租),让需要
   定制的人能拿到干净的积木。
3. **样板收口**:从 v0.2 起增加一条推论——凡是有固定形状、人人都要写、写错就出事
   的样板代码(选主循环),由库以高阶 API 提供,不让用户靠文档抄对。

明确不做(Non-goals):

- 强一致协调。涉及资金、库存等"绝不能双主"的场景,唯一正解是服务端仲裁。
- 跨浏览器、跨设备、跨隐身边界的协调(物理上不可见)。
- 跨标签页消息广播。`BroadcastChannel` 原生 API 已足够简单,封装没有增量价值。
- 高频状态同步(每秒上千次)。localStorage 全量读写的成本模型只适用于低频事件。

## 3. 一致性天花板:为什么浏览器端只能 best-effort

| 平台事实                     | 后果                              | 本库对策                                                                              |
| ---------------------------- | --------------------------------- | ------------------------------------------------------------------------------------- |
| localStorage 读-改-写非原子  | 裸 claim 存在检查-认领竞态        | 引导与 `withTabLock` 组合;高阶 API 内置                                               |
| Web Locks 不可重入           | 同名嵌套/顺序不一致 → 死锁        | 平台语义无法运行时检测(浏览器无 AsyncLocalStorage),文档 + 高阶 API 内部只用一把锁规避 |
| Web Locks 无租约语义         | 冻结标签页持锁不放,阻塞所有等待者 | 持续性角色用 poll-lease(TTL 自愈),mutex 只用于短临界区                                |
| operation 无法被强制取消     | 超时只能"放弃等待",不能"中止执行" | `timeoutMs` 释放锁 + 透传 `AbortSignal`,可取消成为一等能力(见 §5.2)                   |
| localStorage 可写失败/被清空 | 协调状态丢失                      | fail-open 降级,fence tombstone 防代际回退                                             |
| 系统时钟回拨                 | 租约实际有效期变长                | 同源同机共钟,风险可接受,不引单调时钟复杂度                                            |

天花板结论:以上任何一条都不因换实现而消失,除非换架构(见 §8 备选方案评估)。

## 4. 分层架构

```
┌─────────────────────────────────────────────┐
│ L2 模式层(v0.2 新增)                        │
│   createLeadershipLoop                      │
│   —— 选主循环完整样板:ownerId/续租/fence/    │
│      失主通知/退出释放 全部内置              │
├─────────────────────────────────────────────┤
│ L1 原语层(现状,保持向后兼容)               │
│   withTabLock · createPollLeaseClaimer ·    │
│   createTtlDedupeCache · generatePollOwnerId│
├─────────────────────────────────────────────┤
│ L0 环境防御层(现状,不变)                  │
│   safeGetItem / safeSetItem / safeRemoveItem│
│   Logger                                    │
└─────────────────────────────────────────────┘
```

依赖方向严格向下(L2 → L1 → L0),L1/L0 的现有导出**全部保留、语义不变**。

## 5. API 变更方案

### 5.1 新增 `createLeadershipLoop`(L2)

把"正确的选主用法"从文档样板固化成库代码:

```ts
export interface LeadershipLoopOptions {
  /** Web Locks 锁名,默认与 storageKey 同名 */
  lockName?: string
  /** 续租间隔,默认 ttlMs / 3(不设人工下限,保证恒满足"显著小于 ttlMs")。
   *  注意真实平台约束:Chrome 对隐藏超过 5 分钟的标签页启用 intensive throttling,
   *  定时器对齐到约每分钟一次——ttlMs 小于约 3 分钟时,后台标签页的续租可能赶不上,
   *  leadership 会漂移到可见标签页。这通常正是想要的行为(轮询发生在用户正看着的
   *  tab);若要求 holder 在后台也保持 leadership,ttlMs 需 >= 3 分钟。 */
  renewIntervalMs?: number
  /** pagehide 时尽力 release(同步存储写,可靠执行;但崩溃/移动端划杀时事件本身
   *  不触发,此时兜底为 TTL 自然过期——租约设计本就为此兜底)。默认 true */
  releaseOnExit?: boolean
  /** 失去 leadership 时调用(在 ctx.signal 触发 abort 之后);可用于清理资源、
   *  停止本 tab 的轮询循环等 */
  onLeadershipLost?: () => void
  logger?: Logger
}

export interface LeadershipContext {
  /** 本任期的代际号 */
  readonly fence: number
  /** 失去 leadership 时 abort;可传给 fetch 等,让"前 leader 的在途请求"自行取消 */
  readonly signal: AbortSignal
  /** 提交副作用前复查:租约仍连续属于本任期才为 true。
   *  实现上是一次带锁 re-claim + fence 比对,顺带完成一次续租 */
  isStillLeader(): Promise<boolean>
}

/** 返回 stop()。语义契约:onLeadership 在每次获得新任期时调用——包括首次当选,
 *  也包括失去后重新夺回("loop"循环的是完整的 当选→续租→失主→再当选 周期,
 *  不是只循环续租);同一任期内不重复触发;stop() 后不再触发任何回调。
 *  失去 leadership 时:ctx.signal 触发 abort,随后 onLeadershipLost(如有)被调用。 */
export function createLeadershipLoop(
  storageKey: string,
  ttlMs: number,
  onLeadership: (ctx: LeadershipContext) => void | Promise<void>,
  options?: LeadershipLoopOptions,
): () => void
```

消灭的用户侧错误(此前只能靠文档提醒):忘记组合加锁、忘记续租、续租间隔 >= TTL、
提交前不查 fence、退出不 release、ownerId 每次重建。

### 5.2 `withTabLock` 支持可取消 operation

```ts
// operation 签名由 () => T 扩展为 (ctx) => T,向后兼容(零参函数仍合法)
withTabLock(
  "name",
  async ({ signal }) => {
    await fetch("/sync", { signal }) // timeoutMs 触发时 fetch 真正中止
  },
  { timeoutMs: 5_000 },
)
```

`timeoutMs` 到期时:释放锁(现状)+ abort 内部 controller(新增)。文档继续如实说明:
不响应 signal 的 operation 仍在后台跑完,超时后互斥短暂失效,副作用需幂等。

### 5.3 新增 `tryWithTabLock`(try-lock 语义)

"别的标签页正在做,我就跳过"是多标签页场景最常见的互斥模式之一——尤其 **auth token
刷新去重**(生产头号真实场景):发现别人在刷新就跳过、等 storage 事件拿新 token;排队
锁在这里反而是错的(每个 tab 排队各刷一次,刷新接口可能被服务端限流)。Web Locks
原生支持 `ifAvailable`,但**不透传为 `withTabLock` 的重载选项**,而是独立函数:

```ts
export type TabLockResult<T> = { acquired: true; value: T } | { acquired: false }

export function tryWithTabLock<T>(
  name: string,
  operation: (ctx: TabLockContext) => Promise<T> | T,
  options?: TabLockOptions,
): Promise<TabLockResult<T>>

const result = await tryWithTabLock("my-app:refresh-token", refresh)
if (result.acquired) {
  // 拿到了锁,refresh 已执行,result.value 是其返回值
} else {
  // 别的 tab 正在刷新,本次跳过——通常接着等 storage 事件即可
}
```

为什么不用重载(审查修正):重载匹配依赖调用点 options 的**静态字面量类型**——
`const opts: TabLockOptions = { ifAvailable: someCondition }` 这种非字面量调用会静默
落到普通签名,返回类型是 `Promise<T>` 而运行时按 try-lock 执行,编译期不报错。
独立函数名让返回类型与语义一一对应,零歧义、零兼容成本。

行为约定:降级路径(无 Web Locks)下无锁可争,按 acquired 执行;`timeoutMs`/`signal`
语义与 `withTabLock` 一致。Web Locks 的 `steal` 选项**刻意不透传**:它单方面作废
所有等待者的互斥假设,与库的安全定位冲突。

### 5.4 `TtlDedupeCache` 补查询与有界化:`has(id)` + `maxEntries`

```ts
export interface TtlDedupeCache {
  claim(id: string): boolean
  /** 无副作用查询:id 是否仍在有效认领期内(同样先 prune,过期即不存在)。
   *  供 UI 判断"通知是否已触发过"——不像 claim 那样会改变状态 */
  has(id: string): boolean
  clear(): void
}

export interface TtlDedupeCacheOptions {
  logger?: Logger
  /** 条目上限,超出时按 claimedAt 最旧逐出。防止 TTL 窗口内 id 量不受控时 state
   *  无限增长、写爆 quota 后 dedupe 静默失效——把该失效模式从"静默"变为"有界"。
   *  默认无上限(保持现状语义) */
  maxEntries?: number
}
```

### 5.5 模块结构调整

```
src/
  logger.ts             # Logger 从 poll-lease 迁出(目前 ttl-dedupe 反向 import,
                        # 依赖方向别扭);index.ts 从 logger.ts 导出 Logger
  safe-storage.ts       # 不变
  tab-lock.ts           # operation 增加 ctx 参数
  poll-lease.ts         # 仅改为从 logger.ts import
  ttl-dedupe-cache.ts   # 仅改为从 logger.ts import
  leadership-loop.ts    # 新增
  index.ts              # 新增 L2 导出;Logger 保持导出不变
```

对使用方而言唯一的导入路径仍是 `cross-tab-kit` 包根,模块迁移不可见。

## 6. 问题映射:方案如何解决使用层的 15 条注意事项

前一轮评审从用户使用层面归纳了 15 条注意事项。本节逐条说明本方案**用什么机制解决、
为什么该机制有效**;对架构上无法根除的,如实说明为什么、以及缓解到什么程度。

### 6.1 A 类:样板固化后结构性消除(L2 / API 扩展)

**#1 裸 claim 的检查-认领竞态 → 由 L2 消除。**
`createLeadershipLoop` 内部固定以同一把 `withTabLock` 包裹每一次 claim。
有效的原因:Web Locks 在同源内按锁名串行化所有等待者,"读 → 判断 → 写"三步从此
不会被打断——竞态的前提(两步之间插入另一个 tab 的读写)在结构上不存在了。
用户不再手写组合,也就不存在"忘记组合"这个错误模式。

**#3 同名锁嵌套/顺序不一致死锁 → 结构性规避 + 声明,无法运行时根除。**
浏览器没有 AsyncLocalStorage,库无法在并发 async 上下文里可靠判断"当前调用栈已持有
哪把锁",所以运行时检测做不到,这是诚实的边界。但死锁的最高频来源是**用户自己写的
样板互相嵌套**;L2 把整个协调过程收进库内、且内部自始至终只用一把锁,这一类来源被
结构性移除。剩余的(用户业务代码里自己的多把锁)只能靠 README 的死锁反例与纪律。

**#4 超时后 operation 仍在后台跑、互斥短暂失效 → signal 透传,大幅收窄。**
`timeoutMs` 到期时库 abort 内部 controller 并把 signal 交给 operation。有效的原因:
浏览器侧绝大多数可等待的异步原语(fetch、stream、timer 包装)都接受 AbortSignal,
"合作的" operation 会在超时点真正停止,互斥空窗从"必然持续到 operation 自然跑完"
收窄为"只有不响应 signal 的代码才存在"。对不合作的代码,JS 没有可强制中断的语义,
剩余风险如实文档化并要求副作用幂等——这是能力范围内的最强答案,不夸大。

**#5 持续性角色用 mutex 导致冻结持锁 → 由 L2 的选型消除。**
L2 选主走 TTL 租约而非持锁:holder 被冻结/杀死后停止续租,认定会自己过期,其他
tab 在下一次 claim 接管。有效的原因:自愈不依赖任何"死者必须做的事"(释放锁、发
消息),只依赖"活着的人重新检查"。mutex 在库的定位里收缩为"短临界区"专用。

**#7 续租间隔与 TTL 的关系 → L2 默认值保证。**
默认 `renewIntervalMs = ttlMs / 3`,不设人工下限——之前的 `max(ttlMs / 3, 1000)` 公式
对小 TTL 自相矛盾(ttlMs=1500 时间隔被顶到 TTL 的 2/3,"容忍两次节流"的保证失效,
还违反"必须显著小于 ttlMs"自己的硬约束),已修正。同时把真实平台约束写进设计:
Chrome 对隐藏超过 5 分钟的标签页启用 intensive throttling(定时器对齐到约每分钟一
次),ttlMs < 约 3 分钟时后台 tab 续租必然赶不上,leadership 漂移到可见 tab——这通常
正是期望行为;需要 holder 在后台持续保持时,文档指引 ttlMs >= 3 分钟。

**#8 提交副作用前不复查 fence → `ctx.isStillLeader()` 固化动作。**
复查实现为一次带锁 re-claim + fence 比对,比对通过才允许提交。有效的原因:
比对的是**代际号**而不是 ownerId——"被别的 tab 拿走又还回来"后 ownerId 可能恰好
相同,但 fence 一定已经递增,两类历史必然可区分。且复查顺带完成一次续租,一个动作
同时解决"验证任期连续"和"延长任期",用户没有第二个需要记得的步骤。

**#9 忘记 release / ownerId 每次重建 → L2 生命周期托管。**
ownerId 在 loop 启动时生成一次并贯穿始终;`pagehide` 钩子里尽力 release(release 是
同步存储写,事件触发即可靠执行;但崩溃/移动端划杀时 pagehide 根本不触发,此时兜底
为 TTL 自然过期——诚实声明,不承诺"一定释放")。选 `pagehide` 的原因:它是 bfcache
时代唯一对"页面即将消失(含进入缓存)"都可靠的钩子——`beforeunload` 在进入 bfcache
的路径上不触发,选错钩子等于没做。

### 6.2 B 类:已修复或文档级解决

**#6 非法 ttlMs** —— 已在 v0.1 后修复:`Number.isFinite` 校验 + logger 告警覆盖
`0 / NaN / Infinity`;`Infinity` 这个最危险的值(租约永不过期、holder 死后无人能
接管)从"静默击穿核心保证"变为"创建时即告警"。L2 继承同样校验。

**#11 clear() 与并发 claim 不原子** —— 不新增机制,由 `AtomicLogoutClear` recipe
给出完整加锁组合代码。判断:登出清 PII 是低频运维动作,为它增加 L2 API 的收益不
足以抵消表面积膨胀;recipe 级解决足够。

### 6.3 C 类:架构天花板,只能声明不能解决

**#2 降级环境无强一致、#15 跨浏览器/设备/隐身边界** —— 见 §3 天花板分析:
没有服务端或 SharedWorker 这样的单点权威,任何浏览器端实现都只能 best-effort。
方案的态度是把天花板写进定位(§2 Non-goals)并指引强一致需求去服务端,而不是用
更复杂的抽象假装能解决。**SharedWorker 列为 v2 评估项(§8),它能把 #2/#5/#15(同源
内)从"缓解"升级为"解决":worker 内存状态天然单线程权威,port.close 让失主检测
从 TTL 过期变为即时。**

**#10 固定窗口不滑动、#12 全量读写的规模上限、#13 key 命名空间、#14 SSR** ——
均为定位与文档问题:固定窗口是"事件只触发一次"语义的正确选择(滑动窗口反而破坏
该语义);规模上限来自 localStorage 成本模型,README 明示适用量级;命名空间不做
隐式前缀(隐式前缀会让调试时 storage 里的 key 与代码对不上,显式是可调试性更好的
选择);SSR 已天然安全,只需一句话说明。

### 6.4 映射总览

| #   | 注意事项          | 结局                      | 机制                     |
| --- | ----------------- | ------------------------- | ------------------------ |
| 1   | 裸 claim 竞态     | **消除**                  | L2 内置同一把锁          |
| 2   | 降级无强一致      | 声明 + v2 路线            | 定位 / SharedWorker      |
| 3   | 锁死锁            | **高频来源消除**,残余声明 | L2 单锁 + 文档           |
| 4   | 超时互斥空窗      | **大幅收窄**              | timeoutMs + AbortSignal  |
| 5   | 冻结持锁阻塞      | **消除**                  | L2 用 TTL 租约           |
| 6   | 非法 ttlMs        | **已修复**                | 有限性校验 + 告警        |
| 7   | 续租间隔 < TTL    | **消除**                  | L2 默认 ttl/3 + 节流指引 |
| 8   | fence 复查        | **消除**                  | isStillLeader() 固化     |
| 9   | release / ownerId | **消除**                  | pagehide 尽力 + TTL 兜底 |
| 10  | 固定窗口          | 声明(语义正确)            | 文档                     |
| 11  | clear 原子性      | 缓解                      | Recipe                   |
| 12  | 规模上限          | 声明                      | 定位                     |
| 13  | key 命名空间      | 声明                      | Recipe 示范              |
| 14  | SSR               | 已安全                    | L0 防御                  |
| 15  | 跨边界            | 声明 + v2 路线            | 定位 / SharedWorker      |

15 条中:8 条由本方案消除或已修复,2 条收窄/缓解,5 条为天花板与定位声明——其中
#2/#15 在 v2 SharedWorker 路线下有明确的"从缓解到解决"的升级路径。

**原语粒度评审**(互斥/选主/去重三诉求逐条核对,独立于上述 15 条)结论:三大诉求
闭环、无半成品原语,但发现三个实现完整性缺口——互斥缺 try-lock 语义、dedupe 缺无副
作用查询、dedupe 增长无界——已分别并入 §5.3/§5.4 实施清单;Presence(标签页计数)
被认定为唯一值得讨论的新原语,记入 §10 开放问题。

### 6.5 真实场景支撑(回应"是否只是假设性走查")

v0.2 的每一项新增都对应具名的生产场景,不是从评审清单倒推的面积膨胀:

| 场景                                          | 频率 | 支撑的 API                   |
| --------------------------------------------- | ---- | ---------------------------- |
| S1 auth token 刷新去重(别人在刷我就跳过)      | 极高 | **tryWithTabLock**           |
| S2 WebSocket/SSE 单连接复用 + 失主接管        | 高   | **createLeadershipLoop**     |
| S3 后台轮询单点化(限流/成本)                  | 高   | **createLeadershipLoop**     |
| S4 推送 token 注册/刷新每浏览器一次(FCM 模式) | 高   | withTabLock / tryWithTabLock |
| S5 通知只弹一次 + UI 查询"是否已弹过"         | 中高 | ttl-dedupe + **has(id)**     |
| S6 埋点/上报去重(长会话条目累积)              | 中   | ttl-dedupe + **maxEntries**  |
| S7 "已在其他标签页打开"单实例                 | 中   | createLeadershipLoop / lease |
| S8 最后一个 tab 关闭时清理                    | 中   | Presence(§10 #3,v0.3 候选)   |

15 条注意事项按真实场景含金量分类:**真实高发** 6 条(#1/#4/#7/#8/#9,其中 #7 有
Chrome intensive throttling 实锤——隐藏标签页定时器对齐到分钟级,手写 30s TTL + 10s
续租在后台必然断租),**真实低频** 2 条,**长尾防御** 3 条,**定位声明** 4 条。
高发条目全部落在 L2 + tryWithTabLock 覆盖范围内——API 面积有场景背书,无需 @alpha
试水,直接作为 v0.2 稳定 API 发布。

## 7. 关键取舍记录

1. **为什么加锁不内置进 L1 原语,而是新增 L2?**
   内置会让原语失去"干净的积木"属性(嵌套锁、自定义锁粒度、测试注入都变难),
   且改变现有语义破坏兼容。新增 L2 是加法:要省心用 L2,要控制用 L1。
2. **为什么超时是"释放 + signal",而不是强制中断?**
   JS 无法取消不合作的代码;signal 把"可取消"变成协议,是能力范围内最强的语义。
3. **为什么选主用 TTL 租约而不是持锁?**
   冻结/崩溃的 holder 无法释放任何持有物;只有"认定会自己过期"能自愈。
4. **为什么 fence 是必须的?**
   ownerId 相同 ≠ 任期连续(中途可能被别人拿走又还回);代际号严格递增才能区分。
5. **为什么写失败 fail-open?**
   报"claim 失败"会让本 tab 永久沉默(存储持续坏时);报成功则最坏是双主一个
   tick,下一次 claim 读到对方的真实租约即自愈。两害相权后者轻。
6. **为什么 dedupe 是固定窗口?**
   语义简单、无写放大;滑动窗口需要每次 claim 都写,且"事件只触发一次"的典型
   场景本就需要固定窗口。
7. **为什么不现在做 SharedWorker 后端?**
   复杂度与调试成本跳变,且 localStorage 路线已覆盖绝大多数低频场景;列为 v2
   评估项(见 §8),届时 L1 接口可作为其前端保持不变。

## 8. 备选架构评估

| 方案                           | 一致性                | 失主检测        | 代价                                     | 结论                |
| ------------------------------ | --------------------- | --------------- | ---------------------------------------- | ------------------- |
| localStorage + Web Locks(现状) | best-effort           | TTL 过期        | 最低                                     | 采用                |
| **SharedWorker 仲裁**          | 精确(单线程权威状态)  | port.close 即时 | API/调试复杂度跳变,worker 生命周期不受控 | **v2 评估方向**     |
| BroadcastChannel 心跳          | best-effort(仍有竞态) | 心跳超时        | 中                                       | 不优于现状,不采用   |
| 服务端仲裁                     | 强一致                | 即时            | 需要服务端                               | 超出库定位,文档指引 |

## 9. 验证与发布计划

- **测试**:L2 用 fake timers 覆盖续租节奏、TTL 到期失主、fence 变化失主、stop()
  幂等、releaseOnExit;沿用"共享 localStorage 模拟双 tab 交错"的现有手法。
  tab-lock 增加 signal 中止 fetch 的用例;tryWithTabLock 覆盖 acquired/跳过两种分支;
  ttl-dedupe 增加 `has()` 无副作用、`maxEntries` 逐出最旧条目的用例。
- **文档**:中英 README 增加 Recipes 章节,示例全部改写为完整可复制的模式
  (LeadershipLoop / ExactlyOnceNotification / CancelableLock / AtomicLogoutClear /
  TryLockSkip),现有"claim 一次"的残缺示例替换掉。
- **发布**:全部变更向后兼容(新 API、新可选参数、重载签名),changeset 走
  minor(v0.2.0)。

## 10. 开放问题

1. `isStillLeader()` 兼作续租是否需要在文档中显式承诺(影响用户调用频率策略)?
2. SharedWorker 后端若做,是独立包(`cross-tab-kit/worker`)还是同包条件导出?
3. **Presence / 标签页计数**(候选新原语,v0.3 评估):`createTabPresence(storageKey,
ttlMs)`——heartbeat + 带 TTL 的成员登记表,回答"现在有几个标签页开着""最后一个
   标签页关闭时做一次清理"。原语评审认定这是唯一值得新增的粒度;它不能靠现有
   poll-lease 硬凑(lease 设计为单 holder,数记录数既别扭又不可靠)。
4. `PollLeaseClaimer.inspect()` 只读窥探(诊断/UI 提示"另一个标签页正在同步")——
   锦上添花,等真实需求再加。
5. Web Locks `mode: "shared"`(读写锁)——透传成本极低但需求频率低,保持不加;
   若未来需要,是纯加法,零兼容成本。

已解决(评审后关闭):

- ~~`LeadershipLoopOptions` 缺 `onLeadershipLost` 声明~~ → 已补进接口(§5.1)。
- ~~失去 leadership 后是否重新夺回~~ → 是:loop 循环完整的"当选→续租→失主→再当选"
  周期,每次获得新任期都触发 `onLeadership`,同一任期内不重复,`stop()` 后不再触发
  (§5.1 语义契约)。
- ~~`renewIntervalMs` 公式 `max(ttlMs/3, 1000)` 对小 TTL 自相矛盾~~ → 改为纯
  `ttlMs / 3` 不设下限,intensive throttling 约束写进文档(§5.1、§6.1 #7)。
- ~~`releaseOnExit` 措辞过度承诺~~ → 改为"尽力 release + TTL 兜底"(§5.1、§6.1 #9)。
- ~~`ifAvailable` 重载在非字面量调用点静默失配~~ → 改为独立函数 `tryWithTabLock`,
  返回类型与语义一一对应(§5.3)。
- ~~v0.2 API 面积是否过大~~ → 经真实场景核实(§6.5):每项新增均有 S1-S6 具名场景
  背书,不标 @alpha,直接作为稳定 API。
