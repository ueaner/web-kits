import { useStatusStore } from "./feed"

interface StatusPanelProps {
  leaderElection: boolean
  onLeaderElectionChange: (value: boolean) => void
}

export function StatusPanel({ leaderElection, onLeaderElectionChange }: StatusPanelProps) {
  const isLeader = useStatusStore((s) => s.isLeader)
  const tickCount = useStatusStore((s) => s.tickCount)
  const lastTick = useStatusStore((s) => s.lastTick)

  return (
    <div>
      <h2 className="text-lg font-semibold">状态面板</h2>
      <dl className="mt-3 space-y-2 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-slate-500">本标签页是轮询 leader</dt>
          <dd>
            {leaderElection ? (
              isLeader ? (
                <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700">是</span>
              ) : (
                <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-medium text-slate-500">否</span>
              )
            ) : (
              <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700">选举已关闭</span>
            )}
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-slate-500">本标签页累计 tick 数</dt>
          <dd className="font-mono">{tickCount}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-slate-500">最近一次 tick</dt>
          <dd className="font-mono text-xs text-slate-600">{lastTick ? `${lastTick.durationMs}ms / ${lastTick.taskCount} 个任务` : "—"}</dd>
        </div>
      </dl>

      <label className="mt-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={leaderElection}
          onChange={(e) => onLeaderElectionChange(e.target.checked)}
          className="h-4 w-4 accent-indigo-600"
        />
        启用跨标签页选主（crossTabPollLeaderElection）
      </label>
      <p className="mt-1 text-xs text-slate-400">
        切换该开关会通过 key 重挂载销毁并重建 poller，进行中的 check 会被中止，leader 状态与 tick 计数随之重置观察。
        关闭后每个标签页各自轮询全部任务，结果通知由 claimResultOnce 保证恰好一次。
      </p>
    </div>
  )
}
