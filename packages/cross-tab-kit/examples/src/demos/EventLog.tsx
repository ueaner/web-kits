import { useCallback, useState, type ReactNode } from "react"

function timestamp(): string {
  const now = new Date()
  const ms = String(now.getMilliseconds()).padStart(3, "0")
  return `${now.toLocaleTimeString("zh-CN", { hour12: false })}.${ms}`
}

export function useEventLog(): { entries: string[]; push: (message: string) => void; clear: () => void } {
  const [entries, setEntries] = useState<string[]>([])
  const push = useCallback((message: string) => {
    setEntries((prev) => [`[${timestamp()}] ${message}`, ...prev].slice(0, 50))
  }, [])
  const clear = useCallback(() => setEntries([]), [])
  return { entries, push, clear }
}

export function EventLogPanel({ entries, onClear }: { entries: string[]; onClear: () => void }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-slate-500">事件日志（最新在顶部，最多保留 50 条）</h3>
        <button type="button" onClick={onClear} className="text-xs text-slate-400 hover:text-slate-600">
          清空日志
        </button>
      </div>
      <div className="h-44 overflow-y-auto rounded bg-slate-900 p-2 font-mono text-xs leading-5 text-slate-100">
        {entries.length === 0 ? (
          <div className="text-slate-500">（暂无日志）</div>
        ) : (
          entries.map((entry, index) => <div key={`${entries.length}-${index}`}>{entry}</div>)
        )}
      </div>
    </div>
  )
}

export function DemoCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-slate-300 bg-white p-4 shadow-sm">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-slate-500">{description}</p>
      </div>
      {children}
    </section>
  )
}
