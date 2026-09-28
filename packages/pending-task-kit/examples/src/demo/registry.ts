import { createTtlDedupeCache, withTabLock } from "cross-tab-kit"
import { createPendingTaskRegistryBinding, createPendingTaskStore, type PendingTask, type PendingTaskRegistry } from "pending-task-kit"
import { checkAiReport, checkFlakyImport, checkQuietBackup } from "./fakeBackend"

export type DemoTaskType = "ai-report" | "flaky-import" | "quiet-backup"

export const TASK_TYPES: { type: DemoTaskType; label: string; description: string }[] = [
  { type: "ai-report", label: "AI 报告生成", description: "约 10 秒完成，进度 percent 实时推进，成功时返回下载链接" },
  {
    type: "flaky-import",
    label: "不稳定的数据导入",
    description: "check 有 50% 概率抛异常，走 onCheckError + 退避重试；第 3 次失败判定为 failure",
  },
  { type: "quiet-backup", label: "静默备份", description: "很快成功，但 handler 标了 silentOnSuccess，结果带 silent 标记" },
]

export const TASK_TYPE_LABELS: Record<DemoTaskType, string> = {
  "ai-report": "AI 报告生成",
  "flaky-import": "数据导入",
  "quiet-backup": "静默备份",
}

// store / registry / binding 必须在模块作用域创建：usePendingTaskPoller 只在它们的身份
// 变化时重建 poller，每次渲染新建会导致 poller 反复销毁重建。
export const taskStore = createPendingTaskStore<DemoTaskType>()

export const registry: PendingTaskRegistry<DemoTaskType> = {
  "ai-report": {
    check: (task, signal) => checkAiReport(String(task.taskId), signal),
    pollIntervalMs: 1_000,
  },
  "flaky-import": {
    check: (task, signal) => checkFlakyImport(String(task.taskId), signal),
    pollIntervalMs: 1_000,
    retryBackoffMs: (failureCount) => Math.min(1_000 * 2 ** failureCount, 10_000),
    silentOnFailure: false,
  },
  "quiet-backup": {
    check: (task, signal) => checkQuietBackup(String(task.taskId), signal),
    pollIntervalMs: 1_500,
    silentOnSuccess: true,
  },
}

export const binding = createPendingTaskRegistryBinding(taskStore, registry)

// 跨 tab 恰好一次通知的门闩：withTabLock 做互斥，TTL 去重缓存记录"已通知过"。
const notified = createTtlDedupeCache("ptk-demo:notified", 24 * 60 * 60 * 1000)

export function claimResultOnce(task: PendingTask<DemoTaskType>): Promise<boolean> {
  return withTabLock("ptk-demo:claim", () => notified.claim(`${task.id}:${task.startedAt}`), { waitTimeoutMs: 2_000 })
}

export function clearNotifiedCache(): void {
  notified.clear()
}
