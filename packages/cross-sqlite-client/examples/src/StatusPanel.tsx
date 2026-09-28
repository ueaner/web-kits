import { useEffect, useState } from "react"
import { DbTabLockError } from "cross-sqlite-client"
import { useDatabase } from "cross-sqlite-client/react"
import { appendLog } from "./log"

interface StatusPanelProps {
  onRetry: () => void
}

export function StatusPanel({ onRetry }: StatusPanelProps) {
  const { dbClient, isDbReady, isLoading, dbError } = useDatabase()
  const [versions, setVersions] = useState<number[]>([])

  useEffect(() => {
    if (!dbError) return
    appendLog(
      "error",
      dbError instanceof DbTabLockError
        ? "初始化失败：另一个标签页已持有该数据库的锁（DbTabLockError）"
        : `初始化失败：${dbError.name}: ${dbError.message}`,
    )
  }, [dbError])

  useEffect(() => {
    if (!dbClient || !isDbReady) {
      setVersions([])
      return
    }
    let cancelled = false
    dbClient
      .select<{ version: number }>("SELECT version FROM schema_version ORDER BY version")
      .then((rows) => {
        if (!cancelled) setVersions(rows.map((row) => row.version))
      })
      .catch((error: unknown) => appendLog("error", `查询迁移版本失败：${error instanceof Error ? error.message : String(error)}`))
    return () => {
      cancelled = true
    }
  }, [dbClient, isDbReady])

  const isolated = window.crossOriginIsolated

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-lg font-semibold">状态面板</h2>
      <dl className="mt-3 space-y-2 text-sm">
        <div className="flex items-center justify-between gap-4">
          <dt className="shrink-0 text-slate-500">初始化状态</dt>
          <dd>
            {isLoading ? (
              <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-700">初始化中…</span>
            ) : isDbReady ? (
              <span className="rounded bg-green-100 px-2 py-0.5 text-green-700">就绪</span>
            ) : (
              <span className="rounded bg-red-100 px-2 py-0.5 text-red-700">失败</span>
            )}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="shrink-0 text-slate-500">crossOriginIsolated</dt>
          <dd className={`text-right ${isolated ? "text-green-700" : "text-amber-700"}`}>
            {String(isolated)}（{isolated ? "OPFS 持久化可用，刷新后数据仍在" : "OPFS 不可用，已降级为内存模式，刷新即丢"}）
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="shrink-0 text-slate-500">已应用迁移版本</dt>
          <dd>{versions.length > 0 ? versions.join(", ") : "—"}</dd>
        </div>
      </dl>

      {dbError && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm">
          {dbError instanceof DbTabLockError ? (
            <p className="text-red-700">数据库已在另一个标签页打开，本页面为只读演示。关闭另一个标签页后点击「重试」。</p>
          ) : (
            <p className="break-all text-red-700">
              <span className="font-medium">{dbError.name}：</span>
              {dbError.message}
            </p>
          )}
          <button type="button" onClick={onRetry} className="mt-2 rounded-md bg-red-600 px-3 py-1 text-white hover:bg-red-700">
            重试
          </button>
        </div>
      )}
    </section>
  )
}
