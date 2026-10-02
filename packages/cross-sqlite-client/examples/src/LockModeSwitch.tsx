import { WAIT_MS, type LockMode } from "./db"

interface LockModeSwitchProps {
  value: LockMode
  onChange: (mode: LockMode) => void
}

/** singleTabLock 的两种模式。再开一个标签页打开这个页面，就能看到区别 */
export function LockModeSwitch({ value, onChange }: LockModeSwitchProps) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <span className="text-slate-500">另一个标签页占着数据库时</span>
        <span className="flex gap-2">
          {(["fail", "wait"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => onChange(mode)}
              className={`rounded px-2 py-0.5 ${mode === value ? "bg-sky-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
            >
              {mode === "fail" ? '"fail" 立即报错' : '"wait" 排队等'}
            </button>
          ))}
        </span>
      </div>
      <p className="mt-2 text-xs text-slate-400">
        "wait" 最多等 {WAIT_MS / 1000} 秒（AbortSignal.timeout）。再开一个标签页打开这个页面，就能看到两种模式的区别。
      </p>
    </section>
  )
}
