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

## 跨标签页去重提示(可选)

如果多个标签页可能同时处理同一个任务的完成事件(比如强制重新登录导致的竞态),可以
通过 `claimResultOnce` 组合内置的两个原语:

```ts
import { withTabLock, createTtlDedupeCache } from "pending-task-kit"

const notified = createTtlDedupeCache("my-app-pending-task-notified", 24 * 60 * 60 * 1000)

const poller = new PendingTaskPoller({
  // ...
  claimResultOnce: (task) => withTabLock(`pending-task:${task.id}`, () => notified.claim(task.id)),
})
```

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

## 刻意排除在范围之外的东西

- Toast/通知 UI(`onResult` 只是一个普通回调——UI 部分自己实现)。
- 跳转、消息文案、操作按钮文案、缓存失效——`PendingTaskCheckResult.data` 是承载这一切的
  自由形式负载;`status` 是引擎自身唯一会读取的字段。
- 完全不涉及认证/会话管理——引擎里任何地方都没有 token 的概念。`handler.check(task)`
  只是个普通闭包,所以它会自然捕获你应用自己用的认证方式;`start()`/`stop()`(或 React
  绑定里的 `enabled`)是你用来控制"是否应该轮询"的开关;`onCheckError` 让你能够识别出一次
  认证失败并做出反应(比如调用 `stop()`),而引擎本身完全不需要知道"未授权"是什么意思。
