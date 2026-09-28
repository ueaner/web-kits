import { useState } from "react"
import type { DbClient } from "cross-sqlite-client"
import { DatabaseProvider } from "cross-sqlite-client/react"
import { createClient, initialClient } from "./db"
import { appendLog } from "./log"
import { LogPanel } from "./LogPanel"
import { NotesPanel } from "./NotesPanel"
import { StatusPanel } from "./StatusPanel"

export function App() {
  const [clientPromise, setClientPromise] = useState<Promise<DbClient>>(initialClient)

  function retry() {
    appendLog("info", "重试初始化：创建新的数据库连接…")
    // 库的重试约定：DatabaseProvider 不重试，换一个新的 client Promise 引用传进去即可
    setClientPromise(createClient())
  }

  return (
    <DatabaseProvider client={clientPromise}>
      <main className="min-h-screen bg-slate-50 text-slate-800">
        <div className="mx-auto max-w-5xl px-6 py-8">
          <header>
            <h1 className="text-2xl font-bold">cross-sqlite-client 演示 · 便签</h1>
            <p className="mt-1 text-sm text-slate-500">sqlite-wasm + OPFS 持久化 · 迁移 · 单标签页锁</p>
          </header>
          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <div className="flex flex-col gap-6">
              <StatusPanel onRetry={retry} />
              <NotesPanel />
            </div>
            <LogPanel />
          </div>
        </div>
      </main>
    </DatabaseProvider>
  )
}
