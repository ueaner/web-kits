# cross-tab-kit 演示应用

`cross-tab-kit` 的跨标签页行为演示：Web Locks 互斥锁、选主（定时器驱动 / 调用者驱动）、TTL 去重缓存、TTL 租约。

## 启动

仓库根目录：

```bash
pnpm example:ctk
```

或在本目录：

```bash
pnpm dev
```

然后打开 <http://localhost:5174>。

## 怎么观察

**这些演示必须在两个标签页之间观察。** 打开页面后，再开一个相同 URL 的标签页（复制地址栏粘贴到新标签页即可），两边同时操作、对比各自的「事件日志」面板——日志按时间倒序（最新在顶部），每个 demo 独立保留最近 50 条。

## 各 demo 演示什么

### 1. TabLockDemo —— `withTabLock` / `tryWithTabLock`

模拟「刷新 token」：拿到锁的标签页执行一个 2s 的异步任务。

- 两个标签页同时点「withTabLock（等待模式）」：一个先执行，另一个排队等锁释放后再执行；如果等待超过 `waitTimeoutMs`（可调，默认 3000ms），会以 `TimeoutError` 拒绝并写日志。
- 同时点「tryWithTabLock（跳过模式）」：一个执行，另一个立刻显示 `acquired: false`——不排队，直接跳过。

### 2. LeadershipLoopDemo —— `createLeadershipLoop`

定时器驱动的选主（ttl 30s，默认每 10s 续约一次）。同一时刻所有标签页里只有一个 Leader，Leader 每秒写一条心跳日志。

- 两个标签页只有一边亮「我是 Leader」徽标。
- 关掉 Leader 标签页：因为库默认监听 `pagehide` 主动释放租约，另一个标签页会在下一次 tick（≤10s）接管；若是崩溃/强杀，则等 TTL（30s）过期后接管。
- 失去 Leader 身份时 `onLeadershipLost` 写日志；任期内启动的资源（心跳定时器）挂在 `ctx.signal` 上，失去身份即自动停止。

### 3. LeadershipGateDemo —— `createLeadershipGate`

调用者驱动的选主：没有内置定时器，点「poll tick」按钮才抢一次锁（ttl 15s）。

- 拿到 tenure 时显示 fence 序号，并调 `isStillValid()` 验证（顺带续租）。
- 两个标签页交替点按钮：lease 未过期时只有持有者那边能拿到，另一边的 `acquire()` 解析为 `null`（日志显示「本 tick 跳过」）。

### 4. TtlDedupeDemo —— `createTtlDedupeCache`（+ `withTabLock` 组合）

localStorage TTL 去重缓存（ttl 60s），notificationId 固定为 `order-123`。`claim()` 本身是「读-改-写」、跨标签页不原子，所以触发时先用 `withTabLock` 把 claim 包进临界区——这是 README 推荐的组合用法。

- 两个标签页同时点「触发通知」：全局只有一个标签页得到 `claim → true`（「本标签页完成了通知」），其余都是 `false`（「已被其他标签页处理」）。
- 60s TTL 内重复触发一律 false；点「清空缓存」后可重新演示。

### 5. PollLeaseDemo —— `createPollLeaseClaimer`（`cross-tab-kit/advanced` 子路径）

最底层的 TTL 租约原语（ttl 10s），每个标签页有自己的 `ownerId`（`generatePollOwnerId()` 生成）。

- A 标签页 claim 后，B 标签页 claim 返回 `leader: false`。
- A 点「release」主动释放后，B 立即可 claim 成功（fence 递增）。
- A 不 release 直接关掉页面：没有续约，约 10s（TTL）后租约自然过期，B 也能 claim 成功——这就是 TTL 租约相对「持有的锁」的意义：持有者崩溃也不会永久阻塞其他标签页。
