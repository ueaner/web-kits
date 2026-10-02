import { useDbClient, useDbQuery } from "cross-sqlite-client/react"
export function StatusPanel() {
  // 到这里数据库一定已经就绪：没就绪时 <Suspense> 显示 fallback，失败时错误边界接手
  const client = useDbClient()
  const versions = useDbQuery(["schema-versions"], (db) =>
    db.select<{ version: number }>("SELECT version FROM schema_version ORDER BY version"),
  )
  const { storage } = client

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-lg font-semibold">状态面板</h2>
      <dl className="mt-3 space-y-2 text-sm">
        <div className="flex items-center justify-between gap-4">
          <dt className="shrink-0 text-slate-500">数据存在哪里</dt>
          <dd className={`text-right ${storage.persistent ? "text-green-700" : "text-amber-700"}`}>
            {storage.persistent ? "OPFS 文件，刷新后数据仍在" : `内存（${storage.reason}），刷新即丢`}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="shrink-0 text-slate-500">已应用迁移版本</dt>
          <dd>{versions.map((row) => row.version).join(", ") || "—"}</dd>
        </div>
      </dl>
    </section>
  )
}
