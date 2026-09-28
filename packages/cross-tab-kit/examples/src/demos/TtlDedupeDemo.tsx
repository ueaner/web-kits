import { useEffect, useState } from "react"
import { createTtlDedupeCache, withTabLock, type TtlDedupeCache } from "cross-tab-kit"
import { DemoCard, EventLogPanel, useEventLog } from "./EventLog"

const STORAGE_KEY = "ctk-demo:dedupe"
const LOCK_NAME = "ctk-demo:dedupe-lock"
const NOTIFICATION_ID = "order-123"
const BUTTON_CLASS = "rounded px-3 py-1.5 text-sm text-white disabled:opacity-50"

export function TtlDedupeDemo() {
  const { entries, push, clear } = useEventLog()
  const [cache, setCache] = useState<TtlDedupeCache | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setCache(createTtlDedupeCache(STORAGE_KEY, 60_000))
  }, [])

  const fire = async () => {
    if (!cache || busy) return
    setBusy(true)
    try {
      // claim 本身是“读-改-写”，跨标签页并不原子；包一层 withTabLock 后，所有标签页的
      // claim 被串行化，同一个 notificationId 全局只会被处理一次
      const won = await withTabLock(LOCK_NAME, () => cache.claim(NOTIFICATION_ID), { waitTimeoutMs: 2_000 })
      push(won ? `claim("${NOTIFICATION_ID}") → true：本标签页完成了通知` : `claim("${NOTIFICATION_ID}") → false：已被其他标签页处理`)
    } catch (error) {
      push(`claim 失败：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const clearCache = () => {
    cache?.clear()
    push("已清空去重缓存，下一次触发会重新处理")
  }

  return (
    <DemoCard
      title="4. TtlDedupeDemo —— createTtlDedupeCache（+ withTabLock 组合）"
      description="演示 localStorage TTL 去重缓存：两个标签页同时点「触发通知」，同一个 notificationId 全局只会有一个标签页得到 true。60s TTL 内重复触发一律 false。"
    >
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={fire} disabled={!cache || busy} className={`${BUTTON_CLASS} bg-blue-600 hover:bg-blue-700`}>
          触发通知（id: {NOTIFICATION_ID}）
        </button>
        <button type="button" onClick={clearCache} disabled={!cache} className={`${BUTTON_CLASS} bg-slate-600 hover:bg-slate-700`}>
          清空缓存
        </button>
        <span className="text-xs text-slate-400">storageKey: {STORAGE_KEY}，ttl: 60s</span>
      </div>
      <EventLogPanel entries={entries} onClear={clear} />
    </DemoCard>
  )
}
