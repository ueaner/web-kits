import { useEffect, useState } from "react"
import { createLeadershipLoop } from "cross-tab-kit"
import { DemoCard, EventLogPanel, useEventLog } from "./EventLog"

const STORAGE_KEY = "ctk-demo:leader-loop"
const BUTTON_CLASS = "rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"

export function LeadershipLoopDemo() {
  const { entries, push, clear } = useEventLog()
  const [running, setRunning] = useState(true)
  const [isLeader, setIsLeader] = useState(false)

  useEffect(() => {
    if (!running) return
    const stop = createLeadershipLoop(
      STORAGE_KEY,
      30_000,
      (ctx) => {
        setIsLeader(true)
        push(`成为 Leader（fence=${ctx.fence}），开始每秒心跳`)
        // 任期资源挂在 ctx.signal 上：失去 leadership 时 signal abort，心跳随之停止
        const heartbeat = setInterval(() => push(`心跳：本标签页是 Leader（fence=${ctx.fence}）`), 1000)
        ctx.signal.addEventListener(
          "abort",
          () => {
            clearInterval(heartbeat)
            setIsLeader(false)
          },
          { once: true },
        )
      },
      {
        onLeadershipLost: () => push("失去了 Leader 身份（被其他标签页接管，或续租时发现 lease 已易主）"),
        logger: { warn: (message) => push(`[warn] ${message}`) },
      },
    )
    return () => {
      stop()
      setIsLeader(false)
    }
  }, [running, push])

  return (
    <DemoCard
      title="2. LeadershipLoopDemo —— createLeadershipLoop"
      description="演示定时器驱动的选主：同一时刻所有标签页里只有一个 Leader。再开一个标签页，只有一边亮 Leader 徽标；关掉 Leader 页，另一个会在一次续约周期内接管。"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`rounded-full px-3 py-1 text-sm font-medium ${
            isLeader ? "bg-green-100 text-green-800" : "bg-slate-100 text-slate-500"
          }`}
        >
          {isLeader ? "我是 Leader" : "我不是 Leader"}
        </span>
        <button type="button" onClick={() => setRunning(true)} disabled={running} className={BUTTON_CLASS}>
          Start
        </button>
        <button
          type="button"
          onClick={() => setRunning(false)}
          disabled={!running}
          className="rounded bg-slate-600 px-3 py-1.5 text-sm text-white hover:bg-slate-700 disabled:opacity-50"
        >
          Stop
        </button>
        <span className="text-xs text-slate-400">storageKey: {STORAGE_KEY}，ttl: 30s</span>
      </div>
      <EventLogPanel entries={entries} onClear={clear} />
    </DemoCard>
  )
}
