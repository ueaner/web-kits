import { useEffect, useState } from "react"
import { createLeadershipGate, type LeadershipGate } from "cross-tab-kit"
import { DemoCard, EventLogPanel, useEventLog } from "./EventLog"

const STORAGE_KEY = "ctk-demo:leader-gate"

export function LeadershipGateDemo() {
  const { entries, push, clear } = useEventLog()
  const [gate, setGate] = useState<LeadershipGate | null>(null)
  const [fence, setFence] = useState<number | null>(null)
  const [ticking, setTicking] = useState(false)

  useEffect(() => {
    const created = createLeadershipGate(STORAGE_KEY, 15_000, { logger: { warn: (message) => push(`[warn] ${message}`) } })
    setGate(created)
    return () => created.release()
  }, [push])

  const pollTick = async () => {
    if (!gate || ticking) return
    setTicking(true)
    try {
      const tenure = await gate.acquire()
      if (!tenure) {
        setFence(null)
        push("本 tick 跳过（另一标签页持有 lease，或竞争仲裁锁超时）")
        return
      }
      setFence(tenure.fence)
      push(`拿到 tenure（fence=${tenure.fence}）`)
      tenure.signal.addEventListener(
        "abort",
        () => {
          setFence((current) => (current === tenure.fence ? null : current))
          push(`tenure（fence=${tenure.fence}）已失效：被其他标签页接管，或已释放`)
        },
        { once: true },
      )
      const valid = await tenure.isStillValid()
      if (!valid) setFence(null)
      push(`isStillValid() → ${valid}${valid ? "（顺带完成一次续租）" : "，本 tenure 已失效"}`)
    } finally {
      setTicking(false)
    }
  }

  return (
    <DemoCard
      title="3. LeadershipGateDemo —— createLeadershipGate"
      description="演示调用者驱动的选主（没有内置定时器，何时抢锁由调用方决定）。两个标签页交替点「poll tick」：lease 未过期（15s）时，只有持有者那一边能拿到 tenure，另一边解析为 null。"
    >
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={pollTick}
          disabled={!gate || ticking}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
        >
          poll tick（acquire + isStillValid）
        </button>
        <span className="text-sm text-slate-600">当前 fence：{fence === null ? "（未持有）" : fence}</span>
        <span className="text-xs text-slate-400">storageKey: {STORAGE_KEY}，ttl: 15s</span>
      </div>
      <EventLogPanel entries={entries} onClear={clear} />
    </DemoCard>
  )
}
