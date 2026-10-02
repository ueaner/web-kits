import { Component, type ReactNode } from "react"
import { DbTabLockError } from "cross-sqlite-client"
import { appendLog } from "./log"
import { WAIT_MS } from "./db"

interface Props {
  onRetry: () => void
  children: ReactNode
}

/** useDbClient() / useDbQuery() 把初始化失败和查询失败抛到这里 */
export class DbErrorBoundary extends Component<Props, { error: unknown }> {
  state = { error: undefined as unknown }

  static getDerivedStateFromError(error: unknown) {
    return { error }
  }

  componentDidCatch(error: unknown) {
    appendLog(
      "error",
      error instanceof DbTabLockError
        ? "初始化失败：另一个标签页已持有该数据库的锁（DbTabLockError）"
        : `出错：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    )
  }

  render() {
    const { error } = this.state
    if (error === undefined) return this.props.children
    return (
      <section className="rounded-md border border-red-200 bg-red-50 p-4 text-sm">
        {error instanceof DbTabLockError ? (
          <p className="text-red-700">
            数据库已在另一个标签页打开。关掉它以后点「重试」；或者把锁模式切到 "wait"，这个标签页会自己排队等（最多 {WAIT_MS / 1000} 秒）。
          </p>
        ) : (
          <p className="break-all text-red-700">{error instanceof Error ? `${error.name}：${error.message}` : String(error)}</p>
        )}
        <button type="button" onClick={this.props.onRetry} className="mt-2 rounded-md bg-red-600 px-3 py-1 text-white hover:bg-red-700">
          重试
        </button>
      </section>
    )
  }
}
