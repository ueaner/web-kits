import { TabLockDemo } from "./demos/TabLockDemo"
import { LeadershipLoopDemo } from "./demos/LeadershipLoopDemo"
import { LeadershipGateDemo } from "./demos/LeadershipGateDemo"
import { TtlDedupeDemo } from "./demos/TtlDedupeDemo"
import { PollLeaseDemo } from "./demos/PollLeaseDemo"

export function App() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
        <header className="space-y-2">
          <h1 className="text-2xl font-bold">cross-tab-kit 演示</h1>
          <p className="text-sm text-slate-500">
            跨标签页协调原语：Web Locks 互斥锁、选主（定时器驱动 / 调用者驱动）、TTL 去重缓存、TTL 租约。
          </p>
          <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
            这些演示需要跨标签页观察：请再开一个相同 URL 的标签页（{window.location.href}
            ），在两个标签页里同时操作，对比各自的事件日志。
          </div>
        </header>
        <TabLockDemo />
        <LeadershipLoopDemo />
        <LeadershipGateDemo />
        <TtlDedupeDemo />
        <PollLeaseDemo />
      </div>
    </div>
  )
}
