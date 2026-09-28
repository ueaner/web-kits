import { usePendingTaskPoller } from "pending-task-kit/react"
import { useFeedStore, useStatusStore } from "./feed"
import { claimResultOnce, registry, TASK_TYPE_LABELS, taskStore, type DemoTaskType } from "./registry"

function describeData(data: unknown): string {
  if (data == null) return ""
  if (typeof data === "string") return data
  try {
    return JSON.stringify(data)
  } catch {
    return String(data)
  }
}

const STATUS_TEXT: Record<string, string> = {
  success: "成功",
  failure: "失败",
  error: "出错（check 持续抛错达到上限）",
}

export function PollerMount({ leaderElection }: { leaderElection: boolean }) {
  const push = useFeedStore((s) => s.push)
  const setLeader = useStatusStore((s) => s.setLeader)
  const recordTick = useStatusStore((s) => s.recordTick)

  usePendingTaskPoller<DemoTaskType>({
    store: taskStore,
    registry,
    crossTabPollLeaderElection: leaderElection,
    claimResultOnce,
    onResult: (detail) => {
      const label = TASK_TYPE_LABELS[detail.task.type]
      const statusText = STATUS_TEXT[detail.status] ?? detail.status
      const dataText = describeData(detail.data)
      push(
        // onResult 实际不会收到 expired（文档语义），这里只为满足类型收窄
        detail.status === "expired" ? "error" : detail.status,
        `「${label}」${statusText}（本标签页已通知）${detail.silent ? "［silent 标记］" : ""}${dataText ? `：${dataText}` : ""}`,
      )
    },
    onCheckError: (error, task) => {
      const message = error instanceof Error ? error.message : String(error)
      push("check-error", `「${TASK_TYPE_LABELS[task.type]}」check 抛错：${message}（将按 retryBackoffMs 退避重试）`)
    },
    acceptRelayedResult: (detail) => {
      push("relay", `经 result relay 收到「${TASK_TYPE_LABELS[detail.task.type]}」的 ${detail.status} 结果（另一标签页已通知）`)
      return true
    },
    onLeaderChange: (isLeader) => {
      setLeader(isLeader)
      push("leader", isLeader ? "本标签页成为轮询 leader，开始负责 check" : "本标签页失去 leader 身份，改为等待中继结果")
    },
    onTick: (info) => recordTick(info),
  })

  return null
}
