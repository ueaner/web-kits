import { Suspense, useState } from "react"
import type { DbClient } from "cross-sqlite-client"
import { DatabaseProvider } from "cross-sqlite-client/react"
import { createClient, type LockMode } from "./db"
import { DbErrorBoundary } from "./DbErrorBoundary"
import { appendLog } from "./log"
import { LogPanel } from "./LogPanel"
import { NotesPanel } from "./NotesPanel"
import { StatusPanel } from "./StatusPanel"
import { LockModeSwitch } from "./LockModeSwitch"

const Loading = ({ text }: { text: string }) => (
  <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500 shadow-sm">{text}</section>
)

export function App() {
  const [lockMode, setLockMode] = useState<LockMode>("fail")
  const [clientPromise, setClientPromise] = useState<Promise<DbClient>>(() => createClient("fail"))
  // 重试时换一个新的 client Promise，同时换掉错误边界的 key，让它从出错状态回到正常渲染
  const [attempt, setAttempt] = useState(0)

  function reconnect(mode: LockMode) {
    // 先关掉当前连接（如果已经打开），放开标签页锁，再按新的模式重开：不等它关完就重开的话，
    // 新连接会撞上自己还没放开的锁
    setClientPromise(
      clientPromise
        .then((client) => client.close())
        .catch(() => {})
        .then(() => createClient(mode)),
    )
    setAttempt((n) => n + 1)
  }

  function retry() {
    appendLog("info", "重试初始化：创建新的数据库连接…")
    reconnect(lockMode)
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-800">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <header>
          <h1 className="text-2xl font-bold">cross-sqlite-client 演示 · 便签</h1>
          <p className="mt-1 text-sm text-slate-500">sqlite-wasm + OPFS 持久化 · 迁移 · 写入通知 · 单标签页锁</p>
        </header>
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <div className="flex flex-col gap-6">
            {/* 放在错误边界外面：这个标签页因为锁失败时，也能切到 "wait" 再试 */}
            <LockModeSwitch
              value={lockMode}
              onChange={(mode) => {
                setLockMode(mode)
                reconnect(mode)
              }}
            />
            <DatabaseProvider client={clientPromise}>
              <DbErrorBoundary key={attempt} onRetry={retry}>
                <Suspense fallback={<Loading text="数据库初始化中…" />}>
                  <StatusPanel />
                  <NotesPanel />
                </Suspense>
              </DbErrorBoundary>
            </DatabaseProvider>
          </div>
          <LogPanel />
        </div>
      </div>
    </main>
  )
}
