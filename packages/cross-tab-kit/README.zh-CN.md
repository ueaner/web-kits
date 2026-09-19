# cross-tab-kit

框架无关的浏览器跨标签页协调原语:一把 Web Locks 互斥锁、一份可续租的选主租约、一个
TTL "只认领一次"去重缓存,以及安全的 localStorage 读写封装。零运行时依赖,不预设任何
框架——都是可以直接放进任意浏览器代码库的普通函数,只要这个代码库同源开着多个标签页、
需要它们互相协调:让某段代码只在一个标签页里跑、在多个标签页里选出一个"leader"、或者
保证某个动作不管多少个标签页同时抢着触发,最终都只会真正执行一次。

## 安装

```bash
pnpm add cross-tab-kit
```

## 核心概念

- **`withTabLock(name, operation, options?)`** —— 把 `operation` 包在一个具名的
  [Web Locks API](https://developer.mozilla.org/zh-CN/docs/Web/API/Web_Locks_API) 锁
  (`navigator.locks`)里执行,保证同一时刻只有一个打开的标签页在跑它。Web Locks 不可用时
  (老浏览器、非安全上下文)退化为直接、不加锁地执行 `operation`。`options.signal` 可以
  中止*等待*锁的过程(以 `AbortError` 拒绝);`options.timeoutMs` 在 `operation` 迟迟不
  了结时以 `TimeoutError` 拒绝并释放锁——挂起的操作就不会永久卡住其它所有标签页(操作
  本身无法被取消,它会继续在后台跑,最终结果直接被丢弃)。
- **`createPollLeaseClaimer(storageKey, ttlMs, options?)`** —— 一份可续租、基于
  localStorage 的租约:同一时刻只认一个 owner,但跟"一直持有的锁"不同,这份认定会
  自己过期(上一次成功 `claim` 之后 `ttlMs`),不需要显式释放——停止续租的 owner
  (标签页被关闭、崩溃、冻结)不会永久卡住其它标签页接管。`claim(ownerId)` 在
  `{ leader: true }` 之外还会返回一个 `fence`(世代号)——留着它,后续就能区分出
  "现在没人持有这份租约"和"这份租约从我拿到这个 fence 起就一直是我的,中间没被别人
  抢走过又还回来"。它本身不是跨标签页原子的——要靠 `withTabLock` 组合(见下文)。
- **`createTtlDedupeCache(storageKey, ttlMs)`** —— 一个基于 localStorage、TTL 过期的
  "只认领一次"缓存:`claim(id)` 在 TTL 窗口内第一次认领某个 id 时返回 `true`,之后
  重复认领返回 `false`——比如保证一次跨标签页的通知/上报事件,即使好几个标签页同时
  抢着处理同一个 id,也只会真正触发一次。TTL 窗口从首次认领起算、固定不变——重复
  `claim(id)` 不会续期。`clear()` 清空所有认领记录。
- **`safeGetItem` / `safeSetItem` / `safeRemoveItem`** —— 一层很薄的 `localStorage`
  封装,遇到 `localStorage` 完全不可用(SSR、没有 `window`)或者调用本身会抛错(配额
  超限、Safari 隐私模式、存储被禁用、cookie/站点数据被拦截)时优雅降级而不是抛出异常。
  包里其它每一个原语都是在这几个函数上搭出来的;如果你要自己搭一个基于 localStorage
  的原语,可以直接用它们。

## 用法

```ts
import { withTabLock, createPollLeaseClaimer, createTtlDedupeCache, generatePollOwnerId } from "cross-tab-kit"

// 互斥:同一时刻只有一个打开的标签页会跑这段代码。
await withTabLock("my-app:sync-fcm-token", async () => {
  await registerPushToken()
})

// 选主:同一时刻只有一个打开的标签页扮演"轮询者"这个角色。
const lease = createPollLeaseClaimer("my-app:poll-leader", 30_000)
const ownerId = generatePollOwnerId()
const result = await withTabLock("my-app:poll-leader", () => lease.claim(ownerId))
if (result.leader) {
  // 在租约的 TTL 到期之前,这个标签页就是 leader——除非它持续调用 claim() 续租
}

// 去重:即使两个标签页同时完成了同一件事,也只触发一次。
const notified = createTtlDedupeCache("my-app:notified-once", 24 * 60 * 60 * 1000)
if (await withTabLock("my-app:notified-once", () => notified.claim(orderId))) {
  showToast("Order confirmed")
}
```

`withTabLock` 和 `createPollLeaseClaimer`/`createTtlDedupeCache` 是刻意分开的:租约和去重
缓存本身就是纯粹的、不加锁的"读 → 判断 → 写"原语——要不要把某一次 `claim()` 调用包进
`withTabLock`、怎么包,由调用方自己决定,而不是这个包替所有调用方强行绑死一种加锁策略。

## 运行环境说明

- **Web Locks 不可用**:`withTabLock` 退化成不加锁直接执行 `operation`——每个标签页都会
  跑一遍,没有互斥。`createPollLeaseClaimer`/`createTtlDedupeCache` 本身不依赖 Web
  Locks,但如果拿一个已经退化的 `withTabLock` 去组合它们,它们自己的读-改-写就可能在
  标签页之间产生竞态。这是调用方在这种环境下要自己权衡的真实可用性/一致性取舍,这个包
  没法帮你兜底。
- **localStorage 不可用或抛错**:包里每个原语都会优雅降级(具体降级方式见
  `safeGetItem`/`safeSetItem`/`safeRemoveItem` 各自的文档注释)。一个写不进去的
  `createPollLeaseClaimer`/`createTtlDedupeCache` 仍然会返回结果,只是失去了跨标签页
  保证——跟 `withTabLock` 自己的退化是同一种"协调变成尽力而为,而不是直接出错"的取舍。

## 刻意不在这个包的范围内

- 这几个原语之上的任何东西——任务队列、轮询引擎、重试/退避策略、通知分发。这个包只
  提供协调用的基础构件,协调的对象是什么完全由使用方决定。
- 一个带丢锁检测(`assertOwned()`)的、基于 IndexedDB 的独占资源锁——用在"即使 Web
  Locks 不可用,也不能接受两个标签页都以为自己持有"这类场景。这个包的
  `createPollLeaseClaimer` 是刻意接受这种退化的(见上文"运行环境说明");接受不了这种
  退化的调用方,可能需要比这个包提供的更重的原语。

## 贡献

Issue 和 PR 欢迎提到 <https://github.com/ueaner/cross-tab-kit>。

```bash
pnpm install
pnpm run test
pnpm run typecheck
pnpm run lint
```

## License

MIT
