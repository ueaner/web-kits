import { createDbClient, type DbClient, type Logger } from "cross-sqlite-client"
import { createWebAdapter, transactionalExecutor } from "cross-sqlite-client/adapters/web"
import { migrations } from "./migrations"
import { appendLog } from "./log"

const logger: Logger = {
  warn: (message, ...args) => appendLog("warn", [message, ...args].map(String).join(" ")),
  error: (message, ...args) => appendLog("error", [message, ...args].map(String).join(" ")),
}

export function createClient(): Promise<DbClient> {
  appendLog("info", "开始初始化数据库 csc-demo-notes…")
  const promise = createDbClient({
    name: "csc-demo-notes",
    // OPFS 持久化需要跨域隔离响应头；不可用时静默降级为 :memory:（刷新即丢）
    adapter: createWebAdapter({ logger }),
    migrations,
    // web 适配器是单连接，可以安全使用事务型迁移 executor
    migrationOptions: { executor: transactionalExecutor },
    pragmas: { foreign_keys: true },
    logger,
  })
  promise.then(
    () => appendLog("info", "数据库初始化完成，迁移已应用"),
    // 失败由 useDatabase() 的 dbError 统一展示，这里只避免 unhandled rejection
    () => {},
  )
  return promise
}

export const initialClient = createClient()
