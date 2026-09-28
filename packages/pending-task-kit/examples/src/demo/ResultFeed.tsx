import { useFeedStore, type FeedKind } from "./feed"

const KIND_STYLES: Record<FeedKind, string> = {
  info: "text-slate-600",
  success: "text-emerald-700",
  failure: "text-rose-700",
  error: "text-rose-700",
  "check-error": "text-amber-700",
  leader: "text-indigo-700",
  relay: "text-sky-700",
}

const KIND_LABELS: Record<FeedKind, string> = {
  info: "信息",
  success: "成功",
  failure: "失败",
  error: "错误",
  "check-error": "check 抛错",
  leader: "选主",
  relay: "中继",
}

export function ResultFeed() {
  const entries = useFeedStore((s) => s.entries)
  const clear = useFeedStore((s) => s.clear)

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">结果 / 事件（最新在上，限 50 条）</h2>
        <button onClick={clear} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100">
          清空
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="mt-4 text-sm text-slate-400">onResult / onCheckError / onLeaderChange / 中继结果都会出现在这里。</p>
      ) : (
        <ul className="mt-3 max-h-96 space-y-1.5 overflow-y-auto">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-baseline gap-2 text-sm">
              <span className="shrink-0 font-mono text-xs text-slate-400">{entry.time}</span>
              <span className={`shrink-0 rounded px-1.5 py-px text-xs ${KIND_STYLES[entry.kind]} bg-slate-100`}>
                {KIND_LABELS[entry.kind]}
              </span>
              <span className={`${KIND_STYLES[entry.kind]} break-all`}>{entry.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
