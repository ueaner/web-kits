# pending-task-kit

框架无关的长任务跟踪/轮询引擎(AI 生成任务、异步搜索、支付确认、批量操作等),
用于处理那些"可能比发起它的页面活得更久"的后台任务,附带一个可选的 React 绑定。

从某个生产环境应用的 `PendingTaskNotifier` 子系统中抽取而来。通知渠道
(toast、跳转、缓存失效)被刻意排除在这个包之外——你需要自己通过 `onResult` 接入。

## 安装

```bash
pnpm add pending-task-kit zustand
# React 绑定还需要 react 作为 peer dependency(在 React 应用里通常已经有了)
```

## 核心概念

- **Task**(`PendingTask`)—— `{ id, type, taskId, startedAt, ttlMs?, metadata? }`,代表一条
  会被持续跟踪、直到 resolve 或过期的记录。它没有专门的"owner"/"title"/"link"字段——引擎
  自身只会读取 `id`/`type`/`taskId`/`startedAt`/`lastCheckedAt`/`failureCount`/`ttlMs`(后两
  者由引擎自己维护,之所以作为独立字段,正是为了不与你自己数据里可能用到的 key 冲突)。
  你的应用想附加到任务上的其它任何东西——展示用的标题、链接、用来做归属的用户/租户
  id——都放进完全自由形式的 `metadata` 里;配合 store 的 `pruneTasksBy` 按它过滤。
- **Handler**(`PendingTaskHandler`)—— 按 `type` 划分,定义 `check(task)`,负责轮询你的
  后端并返回 `{ status: "pending" | "success" | "failure", progress?, data? }`——`data` 是
  自由形式的负载(一个链接、一条消息,或任何你 `onResult` 需要的东西;见下文),此外还有
  按类型调节的选项(`pollIntervalMs`、`ttlMs`、`finalCheckOnExpiry`、
  `silentOnSuccess`/`silentOnFailure`)。
- **Registry**(`PendingTaskRegistry`)—— 一个普通的 `{ [type]: handler }` 映射。
- **Store** —— 一个 zustand store,持久化到 `localStorage`,保存任务列表。
- **Poller**(`PendingTaskPoller`)—— 引擎本体:按间隔扫描任务,调用对应的 handler,并将
  每个任务归结为 `success`/`failure`(通过 `onResult` 派发)、`error`(当 `check()` 本身
  持续抛错直到达到 `maxFailureCount` 时派发,除非设置了 `silentOnFailure`),或者在 TTL
  先耗尽时静默归结为 `expired`——`error`/`expired` 都是引擎自己的判断,handler 本身永远
  不会返回这两种状态。

## 用法(核心,不涉及 React)

```ts
import { createPendingTaskStore, createPendingTaskRegistryBinding, PendingTaskPoller } from "pending-task-kit"

type TaskType = "search" | "exportJob"

const store = createPendingTaskStore<TaskType>({ storageKey: "my-app-pending-tasks" })

const registry = {
  search: {
    // 引擎不了解身份认证——check() 只是个普通闭包,所以它会自然捕获你应用自己用的那套
    // 认证方式(一个 token、基于 cookie 的 fetch,等等)。
    check: async (task) => {
      const token = myAuthStore.getState().token
      const res = await fetch(`/api/search/${task.taskId}`, { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      // 后端自己的 data.status 取值是那个 API 自行定义的——和这里返回的 status 没有任何关系。
      if (data.status === "done") return { status: "success", data: { href: `/results/${task.taskId}` } }
      if (data.status === "error") return { status: "failure", data: { message: data.error } }
      return { status: "pending", progress: { percent: data.percent } }
    },
    pollIntervalMs: 3_000,
    ttlMs: 5 * 60_000,
  },
}

const { addTask, addTaskIfMissing } = createPendingTaskRegistryBinding(store, registry)

// 在异步任务发起后立刻开始跟踪它。如果任务需要按登录用户/租户做归属区分,把这个信息
// 放进 metadata——见下文"任务归属范围"一节。
addTask({
  id: `search-${searchId}`,
  type: "search",
  taskId: searchId,
  startedAt: Date.now(),
  metadata: { userId },
})

// 驱动轮询循环(模块级单例)。围绕你自己的认证生命周期调用 start()/stop()——比如登录后
// start(),登出时 stop()。
const poller = new PendingTaskPoller({
  store,
  registry,
  onResult: (detail) => {
    const data = detail.data as { href?: string; message?: string } | undefined
    if (detail.status === "success") showToast(data?.message ?? "Done", { href: data?.href })
    if (detail.status === "failure") showToast(data?.message ?? "Failed", { variant: "error" })
    // detail.status 也可能是 "error"(check() 自己持续失败)——是否需要单独的提示文案由你
    // 决定;"expired" 永远不会到达 onResult。
  },
  onCheckError: (error) => {
    // 对于那种意味着"终止本轮 tick、不计入正常失败次数"的错误返回 true——比如会话已过期。
    // 引擎不知道认证错误长什么样,由你来判断。
    if (isUnauthorizedError(error)) {
      poller.stop()
      return true
    }
  },
})
poller.start()
```

## 用法(React 绑定)

```tsx
import { usePendingTaskPoller } from "pending-task-kit/react"

function PendingTaskNotifier() {
  const token = useAuthStore((s) => s.token)

  usePendingTaskPoller({
    store,
    registry,
    enabled: !!token, // hook 不了解身份认证——由你决定何时应该轮询
    onResult: (detail) => {
      /* 弹 toast / 跳转 / 让某个 query 缓存失效 */
    },
  })

  return null
}
```

在应用根部挂载一次 `<PendingTaskNotifier />` 即可。

## 跨标签页轮询选主(默认开启)

多个标签页共享同一个 store 时(它们本来就是共享的——任务本身已经通过 `storage` 事件
跨标签页同步),同一时刻只会有一个标签页真正调用 `handler.check()`;其它标签页对这个
task 完全不发起任何网络请求。这就是 `crossTabPollLeaderElection`,默认开启。单标签页场景
下开着它也没有副作用——没有别的标签页竞争时,一个 poller 永远能成功认领/续租自己的
租约,行为不受影响。

选主用的是可续租、带 TTL 的声明(`pollLeaseTtlMs`,默认 `pollTickMs * 4`),不是一直持有
的锁——停止续租的 leader(被关闭、崩溃,或者被浏览器冻结进前进后退缓存)不会永久卡住
其它标签页,租约会自然过期,任意还开着的标签页在下一次 tick 就能接管。`stop()` 也会
尽力(best-effort)在持有租约时立刻发起释放——这是 fire-and-forget 的,因为 `stop()`
本身是同步 API,页面正好在这时被卸载的话仍可能来不及真正写完——优雅关闭的场景下,
通常其它标签页不需要等满整个 TTL。

因为只有 leader 会检测到任务完成,它的结果会通过第二个 localStorage key
(`resultRelayKey`,默认 `` `${storageKey}-result-relay` ``)广播给其它每个标签页:每个
标签页会用广播过来的数据触发自己的 `onResult`,以及(如果那个标签页也开着
`dispatchDomEvent`)自己的 `CustomEvent`,效果跟那个标签页自己检测到完成一样。如果你
组合使用了 `claimResultOnce`(见下一节),其它标签页收到广播后的派发也会经过和 leader
本地派发相同的这道门——两者一起用,就能同时得到"只有 leader 轮询"和"最多一个标签页
最终发出通知"这两个效果,且不受哪个标签页先检测到结果的影响。

同一个标签页、同一个 store 下应该只存在一个 `PendingTaskPoller` 实例——`storage` 事件
永远不会在发起写入的那个标签页自己身上触发,所以同一个标签页里如果有第二个 poller 实例
共享同一个 store,它将完全收不到这份广播(也收不到上面提到的任务列表同步)。

如果一条广播过来的结果,到达这个标签页时可能已经"过期"(比如中途换了个账号登录、或者
已经登出了),继续在这个标签页里重新 dispatch 出去就不对了,可以用 `acceptRelayedResult`
给接收端加一道判断:

```ts
const poller = new PendingTaskPoller({
  store,
  registry,
  acceptRelayedResult: (detail) => detail.task.metadata?.userId === myAuthStore.getState().userId,
})
```

只有在你确实需要让每个标签页各自轮询全部任务时,才整体关掉跨标签页选主:

```ts
const poller = new PendingTaskPoller({
  store,
  registry,
  crossTabPollLeaderElection: false,
})
```

## 跨标签页去重提示(可选)

上面的 `crossTabPollLeaderElection` 解决的是"轮询本身不要重复";有了 fencing 校验之后,
一次很慢的 `check()` 也不会再让 leadership 转手后的另一个标签页也走到同一个任务的
`finalize()`。但这不代表 `onResult` 在全局范围内保证只触发一次——还残留几个更窄的窗口:
你自己的 `claimResultOnce` 回调如果本身很慢,它 await 的过程中 leadership 仍可能转手到
另一个标签页,那个标签页独立完成同一个任务后,会调用它自己的 `claimResultOnce`;在没有
Web Locks API 的浏览器里,`withTabLock` 会退化为完全不加锁;租约写入偶尔静默失败(比如
配额超限、Safari 隐私模式)时,也可能让两个标签页都以为自己是 leader。如果多个标签页
可能同时处理同一个任务的完成事件(以上任意一种竞态,或者强制重新登录导致的竞态),可以
通过 `claimResultOnce` 组合内置的两个原语——它也会覆盖到其它标签页收到广播后的那次派发
(见上文),所以即使开着选主,也能拿到真正的全局保证:

```ts
import { withTabLock, createTtlDedupeCache } from "pending-task-kit"

const notified = createTtlDedupeCache("my-app-pending-task-notified", 24 * 60 * 60 * 1000)

const poller = new PendingTaskPoller({
  // ...
  claimResultOnce: (task) =>
    withTabLock(`pending-task:${task.id}`, () =>
      notified.claim(`${task.id}:${task.startedAt}`),
    ),
})
```

去重的 key 要用 `` `${task.id}:${task.startedAt}` ``,不能只用 `task.id`。`id` 的文档
(见 `PendingTask.id` 的 doc 注释)写的是"稳定、全局唯一——用同一个 id 重新 addTask 会替换掉
原来那条",也就是说同一个 id 完全可以在不同时间点先后对应好几轮互不相关的独立任务
(比如用户同一天内两次触发同一个付费动作)。只按裸 `task.id` 去重分不清这几轮:
去重记录的 TTL 必须比单轮任务自己的生命周期还长——另一个标签页完全可能更晚才到达同一次完成
(`claimResultOnce` 等待耗时、冻结的标签页被唤醒、到期时的 `finalCheckOnExpiry`),记录必须
在那时还在——这就意味着它同样会覆盖到第二轮、完全独立的那次完成:第二轮的 `onResult`/广播
派发会被当成"第一轮的重复"直接吞掉。`startedAt` 是每次真正新开一轮任务时才写入的时间戳
(见 `addTask` doc 注释里"同 id 会替换"的说明),而两个标签页在竞争**同一轮**任务时看到的
`startedAt` 是相同的——拼上它能把去重粒度收紧到"这一轮",既不会误伤下一轮独立的完成结果,
也不会打开这一节本来要堵上的跨标签页竞态口子。

如果 `claimResultOnce` 判断依据的内容(或者它跟踪的任务的 `metadata`/`data` 字段)可能
带 PII,在用户主动登出时也调用一下 `notified.clear()`,跟下面"任务归属范围"一节里
调用 store 的 `clearAllTasks()` 是同一个道理。

## 任务归属范围(比如按用户/租户区分)

`PendingTask` 没有专门的"owner"字段——引擎不知道也不关心一个任务"属于谁"。如果你的应用
需要这个(大多数都需要),在 `addTask` 时把你自选的标识符放进 `metadata`,再用 store 的
`pruneTasksBy(predicate)` 丢弃不匹配的任务——比如切换到另一个账号登录之后:

```ts
store.getState().pruneTasksBy((task) => task.metadata?.userId === currentUserId)
```

这个包在更广泛的登录/登出流程上也没有任何主张——请在你自己的认证 store 里,登录后自行
调用 `pruneTasksBy`,在用户主动登出时自行调用 `clearAllTasks()`。在*被动*登出(比如收到
401)时不调用 `clearAllTasks()`,可以让正在进行中的任务(比如一次待确认的支付)在快速
重新登录后依然存活——这是一个需要你主动做出的选择,而不是这个包默认内置的行为。

如果任务的 `metadata` 或 handler 返回的 `PendingTaskCheckResult.data` 可能带 PII,记得
开启 `crossTabPollLeaderElection` 后,这些内容也会短暂地留在 `resultRelayKey` 这个
localStorage 条目里(见上面"跨标签页轮询选主"一节)——下一次结果会覆盖它,但没有任何
东西会主动清理它。在用户主动登出时清掉它,跟调用 store 的 `clearAllTasks()`、去重缓存的
`clear()` 是同一个道理:

```ts
import { clearResultRelay } from "pending-task-kit"

clearResultRelay(resultRelayKey) // 用你传入的那个 key,没传的话就是 `${storageKey}-result-relay`
```

## 刻意排除在范围之外的东西

- Toast/通知 UI(`onResult` 只是一个普通回调——UI 部分自己实现)。
- 跳转、消息文案、操作按钮文案、缓存失效——`PendingTaskCheckResult.data` 是承载这一切的
  自由形式负载;`status` 是引擎自身唯一会读取的字段。
- 完全不涉及认证/会话管理——引擎里任何地方都没有 token 的概念。`handler.check(task)`
  只是个普通闭包,所以它会自然捕获你应用自己用的认证方式;`start()`/`stop()`(或 React
  绑定里的 `enabled`)是你用来控制"是否应该轮询"的开关;`onCheckError` 让你能够识别出一次
  认证失败并做出反应(比如调用 `stop()`),而引擎本身完全不需要知道"未授权"是什么意思。
