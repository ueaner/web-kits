import { useState } from "react"
import { startBackendJob } from "./fakeBackend"
import { useFeedStore } from "./feed"
import { binding, TASK_TYPES, type DemoTaskType } from "./registry"

export function TaskCreateForm() {
  const [type, setType] = useState<DemoTaskType>("ai-report")
  const push = useFeedStore((s) => s.push)

  const createTask = () => {
    const id = crypto.randomUUID()
    startBackendJob(id, type)
    binding.addTask({ id, type, taskId: id, startedAt: Date.now() })
    push("info", `已创建「${TASK_TYPES.find((t) => t.type === type)?.label ?? type}」任务 ${id.slice(0, 8)}`)
  }

  const selected = TASK_TYPES.find((t) => t.type === type)

  return (
    <div>
      <h2 className="text-lg font-semibold">创建任务</h2>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <select
          value={type}
          onChange={(e) => setType(e.target.value as DemoTaskType)}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
        >
          {TASK_TYPES.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}（{t.type}）
            </option>
          ))}
        </select>
        <button onClick={createTask} className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">
          提交任务
        </button>
      </div>
      {selected && <p className="mt-2 text-sm text-slate-500">{selected.description}</p>}
      <p className="mt-2 text-xs text-slate-400">
        刷新页面后，未完成的任务会从 localStorage 恢复并自动继续轮询（zustand persist 负责恢复，poller 直接接管，无需手动重注册）。
      </p>
    </div>
  )
}
