import { useEffect, useMemo, useState } from "react"
import { createPollLeaseClaimer, generatePollOwnerId, type PollLeaseClaimer } from "cross-tab-kit/advanced"
import { DemoCard, EventLogPanel, useEventLog } from "./EventLog"

const STORAGE_KEY = "ctk-demo:poll-lease"
const BUTTON_CLASS = "rounded px-3 py-1.5 text-sm text-white disabled:opacity-50"

export function PollLeaseDemo() {
  const { entries, push, clear } = useEventLog()
  const ownerId = useMemo(() => generatePollOwnerId(), [])
  const [claimer, setClaimer] = useState<PollLeaseClaimer | null>(null)
  const [fence, setFence] = useState<number | null>(null)

  useEffect(() => {
    const created = createPollLeaseClaimer(STORAGE_KEY, 10_000)
    setClaimer(created)
    return () => created.release(ownerId)
  }, [ownerId])

  const claim = () => {
    if (!claimer) return
    const result = claimer.claim(ownerId)
    if (result.leader) {
      setFence(result.fence)
      push(`claim → leader: true，fence=${result.fence}（10s 内重复 claim 是续租，fence 不变）`)
    } else {
      setFence(null)
      push("claim → leader: false（另一标签页持有未过期的 lease）")
    }
  }

  const release = () => {
    if (!claimer) return
    claimer.release(ownerId)
    setFence(null)
    push("release：主动释放 lease，其他标签页可立即接管（无需等 TTL）")
  }

  return (
    <DemoCard
      title="5. PollLeaseDemo —— createPollLeaseClaimer（advanced 子路径）"
      description="演示最底层的 TTL 租约原语：A 标签页 claim 后，B 标签页 claim 返回 leader: false；A release 后 B 立即可 claim 成功；A 不 release 直接关页面，约 10s（TTL）后 B 也能 claim 成功。"
    >
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={claim} disabled={!claimer} className={`${BUTTON_CLASS} bg-blue-600 hover:bg-blue-700`}>
          claim
        </button>
        <button type="button" onClick={release} disabled={!claimer} className={`${BUTTON_CLASS} bg-slate-600 hover:bg-slate-700`}>
          release
        </button>
        <span className="text-sm text-slate-600">本标签页持有 fence：{fence === null ? "（未持有）" : fence}</span>
        <span className="text-xs text-slate-400">ownerId: {ownerId.slice(0, 8)}…，ttl: 10s</span>
      </div>
      <EventLogPanel entries={entries} onClear={clear} />
    </DemoCard>
  )
}
