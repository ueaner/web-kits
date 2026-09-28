import { useState } from "react"
import { tryWithTabLock, withTabLock } from "cross-tab-kit"
import { DemoCard, EventLogPanel, useEventLog } from "./EventLog"

const LOCK_NAME = "ctk-demo:refresh-token"
const BUTTON_CLASS = "rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"

async function fakeRefreshToken(push: (message: string) => void): Promise<string> {
  push("本标签页持有锁，执行中…（模拟 2s 的刷新 token 请求）")
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const token = `token-${Math.random().toString(36).slice(2, 8)}`
  push(`刷新完成：${token}`)
  return token
}

function describeError(error: unknown): string {
  if (error instanceof DOMException) return `${error.name}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

export function TabLockDemo() {
  const { entries, push, clear } = useEventLog()
  const [waitTimeoutMs, setWaitTimeoutMs] = useState(3000)
  const [busy, setBusy] = useState(false)

  const runWaiting = async () => {
    setBusy(true)
    push(`withTabLock 请求锁（waitTimeoutMs=${waitTimeoutMs}）…`)
    try {
      const token = await withTabLock(LOCK_NAME, () => fakeRefreshToken(push), { waitTimeoutMs })
      push(`拿到结果：${token}`)
    } catch (error) {
      push(`失败：${describeError(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const runSkipping = async () => {
    setBusy(true)
    try {
      const result = await tryWithTabLock(LOCK_NAME, () => fakeRefreshToken(push))
      push(result.acquired ? `拿到结果：${result.value}` : "acquired: false —— 锁正被其他标签页持有，本次直接跳过")
    } catch (error) {
      push(`失败：${describeError(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <DemoCard
      title="1. TabLockDemo —— withTabLock / tryWithTabLock"
      description="演示 Web Locks 命名互斥锁。两个标签页同时点「等待模式」：一个先执行，另一个排队等锁释放后执行；同时点「跳过模式」：一个执行，另一个立刻得到 acquired: false。"
    >
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={runWaiting} disabled={busy} className={BUTTON_CLASS}>
          withTabLock（等待模式）
        </button>
        <label className="flex items-center gap-1 text-sm text-slate-600">
          waitTimeoutMs
          <input
            type="number"
            min={1}
            step={500}
            value={waitTimeoutMs}
            onChange={(event) => setWaitTimeoutMs(Number(event.target.value) || 3000)}
            className="w-24 rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <button type="button" onClick={runSkipping} disabled={busy} className={BUTTON_CLASS}>
          tryWithTabLock（跳过模式）
        </button>
      </div>
      <EventLogPanel entries={entries} onClear={clear} />
    </DemoCard>
  )
}
