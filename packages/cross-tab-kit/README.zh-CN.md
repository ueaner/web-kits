# cross-tab-kit

框架无关的浏览器跨标签页协调库:一把 Web Locks 互斥锁(等待型和拿不到就跳过两种)、
选主(定时器驱动 / 调用方驱动两种)、一个 TTL "只认领一次"去重缓存。零运行时依赖,不
预设任何框架——都是可以直接放进任意浏览器代码库的普通函数,只要这个代码库同源开着多
个标签页、需要它们互相协调:让某段代码只在一个标签页里跑、在多个标签页里选出一个
"leader"、或者保证某个动作不管多少个标签页同时抢着触发,最终都只会真正执行一次。

## 安装

```bash
pnpm add cross-tab-kit
```

## 用法

### 只在一个标签页里刷新 token(`tryWithTabLock`)

拿不到就跳过的互斥锁:别的标签页正在刷时,不要在它后面排队——每个排队的标签页各刷
一次,正是刷新接口被服务端限流的原因。

```ts
import { tryWithTabLock } from "cross-tab-kit"

async function getValidToken(): Promise<string> {
  const cached = readCachedToken()
  if (cached) return cached

  const result = await tryWithTabLock("my-app:refresh-token", (ctx) => refreshToken(ctx.timeoutSignal))
  if (result.acquired) return result.value

  // 别的标签页正在刷:等它把新 token 写进 localStorage——写入触发的 storage 事件恰好只在
  // *其它*标签页里触发,正是这个场景——但等待必须带超时:刷新方可能失败,那时不能永久挂起,
  // 轮到自己再试一次。
  const token = await waitForStorageValue("my-app:token", { timeoutMs: 5_000 })
  if (token === null) return getValidToken() // 刷新方失败了——自己上场
  return token
}
```

`waitForStorageValue` 是调用方侧几行代码(一个 storage 事件监听加一个超时),不属于
这个包——等待和事件不是协调原语。

### 跨标签页复用单条 WebSocket / 单点轮询(`createLeadershipLoop`)

定时器驱动的选主:一个标签页持有 leadership 并按间隔续租(默认 `ttlMs / 3`),其它
标签页待命;leader 的租约一旦过期(关闭、崩溃、冻结的标签页永远不会卡住接管——TTL
就是兜底),立刻有人顶上。

```ts
import { createLeadershipLoop } from "cross-tab-kit"

const stop = createLeadershipLoop(
  "my-app:ws-leader",
  30_000,
  (ctx) => {
    // 这个标签页是 leader。失主的那一刻 ctx.signal 就会 abort——把它链接进工作里,
    // 让"失主"成为真正的取消,而不是事后丢弃。
    const socket = new WebSocket("wss://example.com/stream")
    ctx.signal.addEventListener("abort", () => socket.close(), { once: true })
  },
  { onLeadershipLost: () => console.log("leadership 漂移到了其它标签页") },
)

// 关闭时:stop()——幂等;停掉定时器并释放租约。
```

`onLeadership` 每段任期触发一次——包括失去后夺回——同一段任期内不会重复。注意后台
标签页的定时器会被节流:`ttlMs` 小于约 3 分钟时,leadership 会漂移到可见标签页(通常
正是期望行为);需要后台保持时把 `ttlMs` 调大。

### 认领时机耦合业务 tick 的手动档选主(`createLeadershipGate`)

手动档:不内置定时器,空闲 tick 零存储流量,认领时机由调用方精确控制——比如在轮询
tick 内、第一个网络请求之前认领。

```ts
import { createLeadershipGate } from "cross-tab-kit"

const gate = createLeadershipGate("my-app:poll-leader", 8_000)

async function runTick() {
  const tenure = await gate.acquire()
  if (!tenure) return // 这一轮是别的标签页领先——跳过网络工作
  const response = await fetch("/api/pending", { signal: tenure.signal })
  // 使用响应前再确认一次:慢请求期间 leadership 可能已经易主。
  if (!(await tenure.isStillValid())) return
  await handle(response)
}

// 关闭时:gate.release()——同步、尽力而为的 tombstone。
```

`tenure.signal` 在别的标签页认领成功写盘的那一刻就会 abort(gate 监听了那次写入触发
的 storage 事件),而不是等到你下次复查。

### 跨标签页"只做一次"(`createTtlDedupeCache`)

```ts
import { createTtlDedupeCache, withTabLock } from "cross-tab-kit"

const notified = createTtlDedupeCache("my-app:notified-once", 24 * 60 * 60 * 1000, {
  maxEntries: 1_000, // 可选上限:超出时按认领时间最旧逐出
})

// claim() 是纯粹的不加锁"读-改-写"——需要跨标签页原子时用 withTabLock 包一层。
// 等待给短上限:认领是微秒级的工作,等得久说明持有者卡死了,而不是忙。
if (await withTabLock("my-app:notified-once", () => notified.claim(orderId), { waitTimeoutMs: 2_000 })) {
  showToast("Order confirmed")
}

// 无副作用的查询,比如 UI 问"这条通知过了没"
if (notified.has(orderId)) disableResendButton()
```

## 核心概念

- **`withTabLock(name, operation, options)`** —— 把 `operation` 包在一个具名的
  [Web Locks API](https://developer.mozilla.org/zh-CN/docs/Web/API/Web_Locks_API) 锁
  (`navigator.locks`)里执行,保证同一时刻只有一个打开的标签页在跑它。Web Locks 不可
  用时(老浏览器、非安全上下文)退化为直接、不加锁地执行。`options` 是必传的,因为
  其中有 `waitTimeoutMs`——*等待*锁的上限(超时以 `TimeoutError` 拒绝;显式传
  `Infinity` 表示无限等)。`options.signal` 同样可以中止等待(以 `AbortError` 拒绝)。
  `options.timeoutMs` 是另一个独立的超时,管的是 _operation_:迟迟不了结时以
  `TimeoutError` 拒绝、释放锁并 abort `ctx.timeoutSignal`——操作本身无法被取消(JS
  没法中断任意代码),所以超时之后可能有两个标签页短暂地同时处于 `operation` 里,副
  作用要幂等。
- **`tryWithTabLock(name, operation, options?)`** —— 拿不到就跳过的版本:结果是
  `{ acquired: true, value }` 或 `{ acquired: false }`,而不是排在持有者后面(它从不
  排队,所以没有 `waitTimeoutMs`)。无 Web Locks 的降级路径上没有锁可争,一律报
  `acquired: true`。
- **`createLeadershipLoop(storageKey, ttlMs, onLeadership, options?)`** —— 定时器驱
  动的选主,用于持续持有的角色(轮询、共享连接)。`onLeadership(ctx)` 每段任期触发
  一次;`ctx = { fence, signal, isStillLeader() }`。返回 `stop()` 函数。某一轮 tick
  在 `waitTimeoutMs`(默认 `ttlMs`)内拿不到仲裁锁,这一轮就当选不出人(见下面
  `createLeadershipGate`)——下一轮 tick 自动自愈。
- **`createLeadershipGate(storageKey, ttlMs, options?)`** —— 同一套机制的无定时器版
  本:`acquire()` 返回 `Tenure`(`{ fence, signal, isStillValid() }`)或 null;等待仲
  裁锁超过 `waitTimeoutMs` 和"锁被别人占着"是同等地位——都是 resolve null,不是拒
  绝。等待过半 `waitTimeoutMs`(封顶 5 秒)仍未拿到锁,每个 gate 实例只会 warn 一次
  ——既然这种情况不再抛错,这条日志就是唯一能看见"卡在谁后面"的地方。`release()`
  是同步、尽力而为的 tombstone。
- **`createTtlDedupeCache(storageKey, ttlMs, options?)`** —— 基于 localStorage、TTL
  过期的"只认领一次"缓存:`claim(id)` 在 TTL 窗口内首次认领返回 `true`,重复返回
  `false`(窗口从首次认领起算、固定不变——重复认领不续期)。`has(id)` 只查询不认领;
  `clear()` 清空全部。`options.maxEntries` 给缓存加上限,超出时按认领时间最旧逐出。
- **配置错误快速失败**:`ttlMs` / `renewIntervalMs` / `maxEntries` 及各超时选项非法
  时在构造期或调用时 throw `RangeError`——app 首次启动或首个测试就会暴露——而不是
  让协调悄悄退化。
- **`Logger`** —— 包里所有 `options.logger` 都是最小的 `{ warn(message): void }`,
  `console` 或你现有的任何 logger 都可以直接赋值。

## `advanced` 子路径

场景级 API 底下垫着的原语,留给要自己组合协调逻辑的调用方:

```ts
import {
  createPollLeaseClaimer,
  generatePollOwnerId,
  safeGetItem,
  safeSetItem,
  safeRemoveItem,
  type PollLeaseClaimer,
  type PollLeaseClaimResult,
  type PollLeaseClaimerOptions,
  type Logger,
} from "cross-tab-kit/advanced"
```

`createPollLeaseClaimer(storageKey, ttlMs)` 是两个选主 API 底下那份可续租、基于
localStorage 的租约:`claim(ownerId)` 返回 `{ leader: true, fence }` 或
`{ leader: false }`——留下 `fence`,之后就能区分"现在没人持有这份租约"和"这份租约
从我拿到这个 fence 起就一直是我的,中间没被别人抢走过又还回来"。`claim`/`release`
是同步的、不隐式加锁(要跨标签页原子性就自己包 `withTabLock`——`createLeadershipGate`
内部正是这个组合)、存储写失败时 fail-open,`release` 写的是过期 tombstone 而不是删
除,所以 fence 严格递增。`safeGetItem`/`safeSetItem`/`safeRemoveItem` 是包里每个原语
共用的一层很薄的 localStorage 封装:无论存储完全不可用(SSR、没有 `window`)还是调
用本身抛错(配额超限、Safari 隐私模式、存储被禁用),都优雅降级而不是抛出异常。

## 注意事项

- **怎么选 `waitTimeoutMs`**:短临界区(一次认领、一次比较-写入)给短上限——微秒级
  的工作等很久,说明持有者卡死了而不是忙,短超时(几百毫秒到几秒)让它以
  `TimeoutError` 暴露,而不是拖死所有标签页里的同名等待者。真要排队的场景,显式传
  `Infinity`——这是"愿意一直等"的刻意写法。
- **`operation` 里做网络请求**:必须配合 `timeoutMs`,并把 `ctx.timeoutSignal` 传给
  `fetch`——否则挂起的请求会一直占着锁直到标签页死亡,其它标签页的等待者各自撞上
  自己的 `waitTimeoutMs`。
- **禁止嵌套同名锁**:Web Locks 不可重入,`withTabLock("a", () => withTabLock("a", ...))`
  (直接或间接)必然死锁——表现为内层调用的 `waitTimeoutMs` 超时,错误消息会指认这
  是嵌套调用导致的。需要多把锁名时,所有代码路径用同一个固定顺序获取。
- **构造参数会被校验**:`ttlMs`、`renewIntervalMs`、`maxEntries` 和各超时选项取非法
  值(`0`、`NaN`、在不允许无界的场合传 `Infinity`、`renewIntervalMs >= ttlMs`)时
  throw `RangeError`——续租间隔不小于 TTL 的 loop 会让租约在两次续租之间过期,
  leadership 在标签页之间反复抖动。

## 运行环境说明

- **Web Locks 不可用**:`withTabLock` 退化成不加锁直接执行 `operation`——每个标签页
  都会跑一遍,没有互斥;`tryWithTabLock` 报 `acquired: true`。选主 API 仍然可用(租约
  基于存储而不是锁),但认领可能在标签页之间产生竞态,短暂出现双主——TTL 和 fence 保
  证它自愈,而不是出错。
- **Web Locks 的死锁与冻结陷阱**:Web Locks 不可重入——在同一个锁名下嵌套
  `withTabLock`(直接或间接)必然死锁;跨代码路径以不一致的顺序获取两个锁名同样会死
  锁。这两种情况下等待仍然有界:`waitTimeoutMs` 会让等待者超时(本 tab 自己持有该锁
  时错误消息会指认嵌套调用),`signal` 让等待可中止——光靠 `timeoutMs` 救不了,因为它
  只约束 `operation` 阶段,管不到等锁阶段。被冻结在前进/后退缓存(bfcache)里的标签页
  会一直持有它已获得的锁,直到浏览器销毁该页面,期间等待同名锁的其它标签页全被卡住
  ——这正是 `waitTimeoutMs` 兜底的情形。基于租约的选主 API 在设计上免疫冻结场景(租
  约会自己过期),但长耗时的 `withTabLock` 临界区不行。
- **localStorage 不可用或抛错**:包里每个原语都会优雅降级。写不进去的租约或去重缓存
  仍然会返回结果,只是失去了跨标签页保证——跟 `withTabLock` 自己的退化是同一种"协调
  变成尽力而为,而不是直接出错"的取舍。
- **后台标签页节流**:Chrome 对隐藏超过 5 分钟的标签页启用 intensive throttling(定
  时器对齐到分钟级)。`createLeadershipLoop` 的 leader 如果被切到后台且 `ttlMs` 小于约
  3 分钟,续租会断,leadership 漂移到可见标签页——通常正是期望行为;需要后台保持时请
  用 `ttlMs >= 3 分钟`。

## 刻意不在这个包的范围内

- 这几个原语之上的任何东西——任务队列、轮询引擎、重试/退避策略、通知分发。这个包只
  提供协调用的基础构件,协调的对象是什么完全由使用方决定。
- 强一致、跨浏览器/跨设备协调、消息广播(`BroadcastChannel` 原生足够)、高频状态同
  步。
- Web Locks 的 `steal`、读写锁、锁检视——有真实需求时都是纯加法。

## 贡献

Issue 和 PR 欢迎提到 <https://github.com/ueaner/web-kits/issues>。

```bash
pnpm install
pnpm run test
pnpm run typecheck
pnpm run lint
```

## License

MIT
