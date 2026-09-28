# pending-task-kit 演示应用

单页演示 `pending-task-kit` 的核心能力：后台任务轮询、进度展示、失败退避、跨标签页选主与结果中继、跨 tab 恰好一次通知。

## 启动

在仓库根目录：

```bash
pnpm example:ptk
```

或在本目录：

```bash
pnpm dev
```

然后打开 http://localhost:5175 。

## 演示场景

**任务创建（主流程）**：选择任务类型后点"提交任务"。

- `ai-report`（AI 报告生成）：假后端每次 check 推进 `progress.percent`，约 10 秒完成，成功结果带下载链接（`data.url`）。
- `flaky-import`（不稳定的数据导入）：check 有 50% 概率抛异常——异常走 `onCheckError`（进 feed），并按 `retryBackoffMs: (n) => min(1000 * 2 ** n, 10_000)` 退避重试，列表里能看到 `failureCount` 增长；假后端第 3 次失败后返回 `failure`，也可能偶然成功。
- `quiet-backup`（静默备份）：很快成功，但 handler 标了 `silentOnSuccess: true`，结果在 feed 里带 `［silent 标记］`——`onResult` 照常触发，是否跳过 toast 由应用自己决定。

任务列表实时显示类型、进度条、`failureCount`、已运行时间。刷新页面后，未完成的任务从 localStorage 恢复并自动继续轮询（store 的 persist 负责恢复，poller 直接接管）。

**假后端跨标签页共享**：`src/demo/fakeBackend.ts` 把任务状态直接存 localStorage（`ptk-demo:backend`），每次 check 读-推进-写回，所以两个标签页看到的进度一致。check 通过 `AbortSignal` 支持取消（poller 停止时中止进行中的 check）。

**跨标签页选主与结果中继**：再开一个相同 URL 的标签页观察——

- 状态面板显示本标签页是否 leader（`onLeaderChange`）和累计 tick 数（`onTick`）。
- 选主开启时（默认），只有一个标签页是 leader、tick 计数在涨，另一个标签页不发起 check。
- 任务完成时，非 leader 标签页通过 result relay 收到结果，feed 里出现"中继"条目；leader 标签页出现"本标签页已通知"。
- 状态面板的开关可切换 `crossTabPollLeaderElection`。切换会用 `key` 重挂载销毁并重建 poller（进行中的 check 被中止）——这是 poller 构造期选项，只能重建。关闭后每个标签页各自轮询，靠 `claimResultOnce` 保证通知恰好一次。

**跨 tab 恰好一次通知**：`claimResultOnce` 用 cross-tab-kit 组合实现（`withTabLock` + `createTtlDedupeCache`，key 前缀 `ptk-demo:`），与库 README 的写法一致。feed 里区分"本标签页已通知"（claim 成功的 tab）和"另一标签页已通知（中继）"（通过 `acceptRelayedResult` 记录）。

**清理**：任务列表右上角——

- "清空全部任务"：`clearAllTasks()` + `clearResultRelay("pending-tasks-result-relay")`，同时清掉假后端状态和去重缓存。
- "清理「某类型」"：`pruneTasksBy` 按类型清理（仅列出当前存在的类型）。

## 涉及的 localStorage key

- `pending-tasks`：任务 store（库默认 key）
- `pending-tasks-poll-leader` / `pending-tasks-result-relay`：选主租约与结果中继（库默认派生 key）
- `ptk-demo:backend` / `ptk-demo:notified`：假后端状态与通知去重缓存
