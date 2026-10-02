import { createDbClient, type DbClient, type Logger } from "cross-sqlite-client"
import { createWebAdapter, transactionalExecutor } from "cross-sqlite-client/adapters/web"
import { migrations } from "./migrations"
import { appendLog } from "./log"

const logger: Logger = {
  warn: (message, ...args) => appendLog("warn", [message, ...args].map(String).join(" ")),
  error: (message, ...args) => appendLog("error", [message, ...args].map(String).join(" ")),
}

/** 另一个标签页占着数据库时："fail" 立即报错，"wait" 排队等它关掉（最多等 WAIT_MS） */
export type LockMode = "fail" | "wait"
export const WAIT_MS = 10_000

export function createClient(lockMode: LockMode): Promise<DbClient> {
  appendLog("info", `开始初始化数据库 csc-demo-notes（singleTabLock: "${lockMode}"）…`)
  const promise = createDbClient({
    name: "csc-demo-notes",
    // OPFS 持久化需要跨域隔离响应头；不可用时静默降级为 :memory:（刷新即丢）
    adapter: createWebAdapter({ logger, singleTabLock: lockMode }),
    migrations,
    // web 适配器是单连接，可以安全使用事务型迁移 executor
    migrationOptions: { executor: transactionalExecutor },
    pragmas: { foreign_keys: true },
    logger,
    signal: lockMode === "wait" ? AbortSignal.timeout(WAIT_MS) : undefined,
  })
  promise.then(
    (client) => {
      appendLog("info", "数据库初始化完成，迁移已应用")
      // 演示写入通知：每次写入（或一组 groupWrites）结束后打一行日志，useDbQuery 也靠它自动刷新
      client.onWrite(() => appendLog("info", "onWrite：有写入，正在重新查询"))
    },
    // 失败由错误边界统一展示，这里只避免 unhandled rejection
    () => {},
  )
  return promise
}
