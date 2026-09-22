import { assertIdentifier, runMigrations } from "./migrate"
import type { CreateDbClientOptions, DbClient } from "./types"

/** PRAGMA 的字符串值只允许枚举式 token（WAL、NORMAL……），杜绝拼 SQL 注入 */
const PRAGMA_VALUE_RE = /^[A-Za-z0-9_]+$/

async function applyPragmas(client: DbClient, pragmas: Record<string, string | number | boolean>): Promise<void> {
  for (const [key, rawValue] of Object.entries(pragmas)) {
    assertIdentifier(key, "PRAGMA name")
    let value: string
    if (typeof rawValue === "boolean") {
      value = rawValue ? "1" : "0"
    } else if (typeof rawValue === "number") {
      if (!Number.isFinite(rawValue)) {
        throw new Error(`PRAGMA ${key}: number values must be finite, got ${rawValue}.`)
      }
      value = String(rawValue)
    } else {
      if (!PRAGMA_VALUE_RE.test(rawValue)) {
        throw new Error(`PRAGMA ${key}: string values must match ${PRAGMA_VALUE_RE}, got ${JSON.stringify(rawValue)}.`)
      }
      value = rawValue
    }
    await client.execute(`PRAGMA ${key} = ${value};`)
  }
}

export async function createDbClient(options: CreateDbClientOptions): Promise<DbClient> {
  const { adapter } = options
  // 靠 executor 上的标记判断（见 types.ts 的 MigrationExecutor），不做函数引用比较
  if (options.migrationOptions?.executor?.requiresSingleConnection && !adapter.singleConnection) {
    throw new Error(
      "This MigrationExecutor requires a single-connection adapter " +
        "(adapter.singleConnection !== true); a custom executor that manually manages " +
        "BEGIN/COMMIT is not safe here. Use the default executor or an adapter with " +
        "singleConnection: true.",
    )
  }

  const logger = options.logger ?? console

  const client = await adapter.initialize({ name: options.name })
  try {
    if (options.pragmas) {
      // 连接级 PRAGMA（foreign_keys、busy_timeout 等）只作用于执行它的那一条物理连接；
      // 连接池适配器上后续查询可能落到其他连接，配置会静默失效
      if (!adapter.singleConnection) {
        logger.warn(
          "[PRAGMA] This adapter uses a connection pool; connection-level pragmas " +
            "(e.g. foreign_keys, busy_timeout) apply only to one pooled connection and will " +
            "silently not hold for later queries. Database-level pragmas (e.g. journal_mode, user_version) are unaffected.",
        )
      }
      await applyPragmas(client, options.pragmas)
    }
    if (options.migrations) {
      await runMigrations(client, options.migrations, {
        ...options.migrationOptions,
        logger: options.migrationOptions?.logger ?? logger,
      })
    }
  } catch (error) {
    // 初始化成功但 PRAGMA/迁移失败：必须关闭已打开的连接（worker、OPFS 文件、跨标签页锁），
    // 否则泄漏的连接会让调用方的重试撞上自己持有的资源（比如 DbTabLockError）
    await client.close().catch(() => {})
    throw error
  }
  return client
}

export { runMigrations, defaultExecutor } from "./migrate"
export type {
  DbClient,
  DbAdapter,
  DbAdapterConfig,
  BatchStatement,
  Logger,
  Migration,
  MigrationExecutor,
  MigrationOptions,
  CreateDbClientOptions,
} from "./types"
export { DbError, DbInitializationError, DbExecutionError, DbMigrationError, DbCloseError, DbTabLockError } from "./errors"
