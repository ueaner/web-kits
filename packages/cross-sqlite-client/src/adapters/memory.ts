import sqlite3InitModule from "@sqlite.org/sqlite-wasm"
import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm"
import type { BatchStatement, DbAdapter, DbClient } from "../core/types"
import { DbCloseError, DbError, DbExecutionError, DbInitializationError } from "../core/errors"

/**
 * 内存适配器（测试用）。基于 @sqlite.org/sqlite-wasm 官方支持的 Node 单线程用法
 * （sqlite3InitModule() + oo1.DB(':memory:')），跟 web 适配器共享同一个 sqlite3 引擎，
 * 保证同一组 SQL 在两个适配器上的行为一致，而不是用另一套假实现模拟。
 *
 * 每次调用 createMemoryAdapter() 返回状态独立的新实例，可在同一进程里创建多个互不干扰的
 * 实例（例如并行测试）。
 */
export function createMemoryAdapter(): DbAdapter {
  let sqlite3: Sqlite3Static | null = null
  let db: Database | null = null
  // 缓存进行中的 initialize()，避免并发调用各自跑一遍完整初始化流程并互相覆盖状态
  let initPromise: Promise<DbClient> | null = null

  function requireDb(): Database {
    if (!db) {
      throw new DbError("[Memory DB] Database not initialized. Call initialize() first.")
    }
    return db
  }

  const client: DbClient = {
    async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const d = requireDb()
      try {
        return d.selectObjects(sql, params) as T[]
      } catch (error) {
        throw new DbExecutionError(sql, params, error)
      }
    },

    async execute(sql: string, params: unknown[] = []): Promise<{ lastInsertId?: number; rowsAffected?: number }> {
      const d = requireDb()
      try {
        d.exec({ sql, bind: params })
        const rowsAffected = d.changes(false, false)
        const lastInsertId = d.pointer !== undefined ? Number(sqlite3!.capi.sqlite3_last_insert_rowid(d.pointer)) : undefined
        return { lastInsertId, rowsAffected }
      } catch (error) {
        throw new DbExecutionError(sql, params, error)
      }
    },

    async executeBatch(statements: BatchStatement[]): Promise<void> {
      const d = requireDb()
      if (statements.length === 0) {
        return
      }
      if (statements.every((s) => typeof s === "string" || s.params === undefined || s.params.length === 0)) {
        // 无绑定参数：拼成一条 SQL 一次 exec 跑完。分隔符用 "\n;\n" 而不是 "\n"：
        // 用户语句可能不带结尾分号（逐条 execute 时无所谓，拼起来就 syntax error），
        // 也可能以 -- 行注释结尾（";" 直接跟在注释后会被注释掉）；多出的空语句 sqlite 会忽略
        d.exec({ sql: statements.map((s) => (typeof s === "string" ? s : s.sql)).join("\n;\n") })
        return
      }
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
      try {
        db?.close()
      } catch (error) {
        throw new DbCloseError(error)
      } finally {
        db = null
      }
    },
  }

  async function doInitialize(): Promise<DbClient> {
    try {
      sqlite3 = await sqlite3InitModule()
      db = new sqlite3.oo1.DB(":memory:", "c")
      return client
    } catch (error) {
      sqlite3 = null
      db = null
      throw new DbInitializationError(error)
    }
  }

  return {
    singleConnection: true,

    initialize(): Promise<DbClient> {
      if (!initPromise) {
        initPromise = doInitialize()
        // 失败后允许重试；挂在缓存 promise 上而不是改写在它的 reject 路径里，
        // 调用方拿到的仍然是同一个会 reject 的 promise
        initPromise.catch(() => {
          initPromise = null
        })
      }
      return initPromise
    },
  }
}
