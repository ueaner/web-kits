import { useState } from "react"
import { PollerMount } from "./demo/PollerMount"
import { ResultFeed } from "./demo/ResultFeed"
import { StatusPanel } from "./demo/StatusPanel"
import { TaskCreateForm } from "./demo/TaskCreateForm"
import { TaskList } from "./demo/TaskList"

export function App() {
  const [leaderElection, setLeaderElection] = useState(true)

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800">
      {/* crossTabPollLeaderElection 是 poller 构造期选项，用 key 重挂载来重建 poller */}
      <PollerMount key={leaderElection ? "election-on" : "election-off"} leaderElection={leaderElection} />

      <div className="mx-auto max-w-6xl px-6 py-8">
        <h1 className="text-2xl font-bold">pending-task-kit 演示</h1>
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          跨标签页行为需要再开一个相同 URL 的标签页观察：保持本页开着，新开一个 http://localhost:5175 的标签页，两边对比 leader 状态、tick
          计数和结果通知。
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <div className="space-y-6">
            <section className="rounded-xl bg-white p-5 shadow-sm">
              <TaskCreateForm />
            </section>
            <section className="rounded-xl bg-white p-5 shadow-sm">
              <TaskList />
            </section>
          </div>
          <div className="space-y-6">
            <section className="rounded-xl bg-white p-5 shadow-sm">
              <StatusPanel leaderElection={leaderElection} onLeaderElectionChange={setLeaderElection} />
            </section>
            <section className="rounded-xl bg-white p-5 shadow-sm">
              <ResultFeed />
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
