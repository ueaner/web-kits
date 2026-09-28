import { useLogEntries, type LogLevel } from "./log"

const levelTextClass: Record<LogLevel, string> = {
  info: "text-slate-700",
  warn: "text-amber-700",
  error: "text-red-700",
}

const levelLabel: Record<LogLevel, string> = {
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
}

export function LogPanel() {
  const entries = useLogEntries()
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm lg:sticky lg:top-6 lg:self-start">
      <h2 className="text-lg font-semibold">
        事件日志 <span className="text-sm font-normal text-slate-400">（最新在前，最多 50 条）</span>
      </h2>
      <ul className="mt-3 max-h-[32rem] space-y-1 overflow-y-auto font-mono text-xs">
        {entries.length === 0 && <li className="text-slate-400">暂无日志。</li>}
        {entries.map((entry) => (
          <li key={entry.id} className="flex gap-2">
            <span className="shrink-0 text-slate-400">{entry.time}</span>
            <span className={`shrink-0 ${levelTextClass[entry.level]}`}>{levelLabel[entry.level]}</span>
            <span className={`break-all ${levelTextClass[entry.level]}`}>{entry.message}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
