import Sqlite from "@tauri-apps/plugin-sql"
import type { BatchStatement, DbAdapter, DbAdapterConfig, DbClient } from "../core/types"
import { DbCloseError, DbError, DbExecutionError, DbInitializationError } from "../core/errors"

/**
 * Tauri (@tauri-apps/plugin-sql) 适配器。
 *
 * 注意：plugin-sql 的 Sqlite.load 在插件侧按数据库路径全局缓存连接——两个同名（同 name）
 * 的适配器实例共享底层连接，其中一个 close 另一个也会断。要多个真正独立的连接，用不同的
 * name（即不同的数据库文件）。
 *
 * singleConnection 为 false：@tauri-apps/plugin-sql 底层是 sqlx::Pool<Sqlite> 连接池，
 * 每次 execute()/select() 调用独立获取/归还一个物理连接，不保证跨调用落在同一条连接上。
 * 这也是库不提供业务侧事务 API 的原因：BEGIN 和 COMMIT 可能被拆到两条物理连接上而不报
 * 任何错。
 */
export function createTauriAdapter(): DbAdapter {
  let db: Sqlite | null = null
  // 缓存进行中的 initialize()，避免并发调用各自跑一遍完整初始化流程并互相覆盖状态
  let initPromise: Promise<DbClient> | null = null

  function requireDb(): Sqlite {
    if (!db) {
      throw new DbError("[Tauri DB] Database not initialized. Call initialize() first.")
    }
    return db
  }

  const client: DbClient = {
    async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const d = requireDb()
      try {
        return await d.select(sql, params)
      } catch (error) {
        throw new DbExecutionError(sql, params, error)
      }
    },

    async execute(sql: string, params: unknown[] = []): Promise<{ lastInsertId?: number; rowsAffected?: number }> {
      const d = requireDb()
      try {
        const result = await d.execute(sql, params)
        return {
          lastInsertId: result.lastInsertId,
          rowsAffected: result.rowsAffected,
        }
      } catch (error) {
        throw new DbExecutionError(sql, params, error)
      }
    },

    async executeBatch(statements: BatchStatement[]): Promise<void> {
      for (const statement of statements) {
        const sql = typeof statement === "string" ? statement : statement.sql
        const params = typeof statement === "string" ? [] : (statement.params ?? [])
        await client.execute(sql, params)
      }
    },

    async close(): Promise<void> {
      // 先同步摘掉初始化缓存：init 进行中时等它落定，避免 close 返回后初始化才完成、
      // 留下一个没人持有句柄的连接
      const pending = initPromise
      initPromise = null
      if (pending) {
        await pending.catch(() => {})
      }
      if (db) {
        try {
          const current = db
          db = null // 先清零再 close：并发的第二个 close() 看到空状态直接 no-op
          const success = await current.close()
          if (!success) {
            throw new DbCloseError()
          }
        } catch (error) {
          throw error instanceof DbCloseError ? error : new DbCloseError(error)
        }
      }
    },
  }

  async function doInitialize(config: DbAdapterConfig): Promise<DbClient> {
    try {
      db = await Sqlite.load(`sqlite:${config.name}.db`)
      return client
    } catch (error) {
      throw new DbInitializationError(error)
    }
  }

  return {
    singleConnection: false,

    initialize(config: DbAdapterConfig): Promise<DbClient> {
      if (!initPromise) {
        initPromise = doInitialize(config)
        // 失败后允许重试；调用方拿到的仍然是同一个会 reject 的 promise
        initPromise.catch(() => {
          initPromise = null
        })
      }
      return initPromise
    },
  }
}
