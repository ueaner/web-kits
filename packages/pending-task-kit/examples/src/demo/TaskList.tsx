import { useEffect, useState } from "react"
import { clearResultRelay, DEFAULT_STORAGE_KEY } from "pending-task-kit"
import { usePendingTasks } from "pending-task-kit/react"
import { clearBackendJobs, removeBackendJob } from "./fakeBackend"
import { useFeedStore } from "./feed"
import { clearNotifiedCache, TASK_TYPE_LABELS, taskStore, type DemoTaskType } from "./registry"

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

function percentOf(metadata: Record<string, unknown> | undefined): number | undefined {
  const percent = metadata?.percent
  return typeof percent === "number" ? percent : undefined
}

export function TaskList() {
  const tasks = usePendingTasks(taskStore)
  const now = useNow()
  const push = useFeedStore((s) => s.push)

  const clearAll = () => {
    taskStore.getState().clearAllTasks()
    clearResultRelay(`${DEFAULT_STORAGE_KEY}-result-relay`)
    clearBackendJobs()
    clearNotifiedCache()
    push("info", "已清空全部任务、假后端状态与 result relay")
  }

  const pruneType = (type: DemoTaskType) => {
    for (const task of tasks) {
      if (task.type === type) removeBackendJob(String(task.taskId))
    }
    taskStore.getState().pruneTasksBy((task) => task.type !== type)
    push("info", `已按类型清理所有「${TASK_TYPE_LABELS[type]}」任务`)
  }

  const removeTask = (id: string, taskId: number | string) => {
    taskStore.getState().removeTask(id)
    removeBackendJob(String(taskId))
    push("info", `已手动移除任务 ${id.slice(0, 8)}`)
  }

  const presentTypes = [...new Set(tasks.map((t) => t.type))]

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">任务列表（{tasks.length}）</h2>
        <div className="flex flex-wrap gap-2">
          {presentTypes.map((type) => (
            <button
              key={type}
              onClick={() => pruneType(type)}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100"
            >
              清理「{TASK_TYPE_LABELS[type]}」
            </button>
          ))}
          <button onClick={clearAll} className="rounded-md border border-rose-300 px-2.5 py-1 text-xs text-rose-600 hover:bg-rose-50">
            清空全部任务
          </button>
        </div>
      </div>

      {tasks.length === 0 ? (
        <p className="mt-4 text-sm text-slate-400">暂无任务，先在上面创建一个。</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {tasks.map((task) => {
            const percent = percentOf(task.metadata)
            return (
              <li key={task.id} className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <span className="text-sm font-medium">{TASK_TYPE_LABELS[task.type]}</span>
                    <span className="ml-2 font-mono text-xs text-slate-400">{task.id.slice(0, 8)}</span>
                  </div>
                  <button
                    onClick={() => removeTask(task.id, task.taskId)}
                    className="shrink-0 rounded-md border border-slate-300 px-2 py-0.5 text-xs text-slate-500 hover:bg-slate-100"
                  >
                    移除
                  </button>
                </div>
                {percent !== undefined && (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-1.5 flex-1 rounded-full bg-slate-200">
                      <div className="h-1.5 rounded-full bg-indigo-500 transition-all" style={{ width: `${percent}%` }} />
                    </div>
                    <span className="w-10 text-right text-xs text-slate-500">{percent}%</span>
                  </div>
                )}
                <div className="mt-2 flex flex-wrap gap-x-4 text-xs text-slate-500">
                  <span>已运行 {Math.max(0, Math.round((now - task.startedAt) / 1000))}s</span>
                  <span>failureCount：{task.failureCount ?? 0}</span>
                  {task.lastCheckedAt !== undefined && (
                    <span>上次检查 {Math.max(0, Math.round((now - task.lastCheckedAt) / 1000))}s 前</span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
