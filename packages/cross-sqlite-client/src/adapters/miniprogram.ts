import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm"
import type { BatchStatement, DbAdapter, DbAdapterConfig, DbConnection, DbInitializeOptions, DbStorage, Logger } from "../core/types"
import { DbCloseError, DbError, DbExecutionError, DbInitializationError, DbPersistenceError } from "../core/errors"
import { createSnapshotFiles, hasSqliteHeader, missingFileSystemMethods } from "./miniprogram-files"
import type { MiniProgramFileSystem, SnapshotFiles } from "./miniprogram-files"

export type { MiniProgramFileSystem, SnapshotOrigin } from "./miniprogram-files"

export interface MiniProgramAdapterOptions {
  /**
   * 返回已初始化的 sqlite3 对象。小程序里用 sqlite-wasm-miniprogram 的 initSqlite3()，
   * 测试里用原版 @sqlite.org/sqlite-wasm 的 sqlite3InitModule()。只在第一次 initialize() 时调用；
   * 失败时 initialize() 失败，并且可以重试。
   */
  sqlite3: () => Promise<Sqlite3Static>
  /** 宿主文件系统：wx.getFileSystemManager() / Taro.getFileSystemManager() */
  fs: MiniProgramFileSystem
  /** 数据库文件所在目录，通常是 `${wx.env.USER_DATA_PATH}/cross-sqlite-client`；不存在时创建 */
  directory: string
  /** 诊断输出（从备份恢复、发现损坏文件等），默认 console */
  logger?: Logger
}

/** 进程内已经打开的数据库文件（按文件系统对象分开登记）：同一个文件被两个连接同时写，快照会互相覆盖 */
const openFiles = new WeakMap<MiniProgramFileSystem, Set<string>>()

function openFilesOf(fs: MiniProgramFileSystem): Set<string> {
  let set = openFiles.get(fs)
  if (!set) openFiles.set(fs, (set = new Set()))
  return set
}

/** 每次调用后用来判断"数据库有没有变"的计数 */
interface ChangeMarks {
  totalChanges: number
  schemaVersion: number
  userVersion: number
}

const SQLITE_OK = 0

/**
 * 小程序适配器：数据库在内存里，调用结束时如果不在事务中、数据库又有变化，就把整个库导出成快照，
 * 原子地写到小程序的用户文件目录（USER_DATA_PATH）。写入类调用 resolve 时数据已经落盘。
 *
 * - 落盘失败：关闭连接，用上一次成功保存的快照重新打开，抛 DbPersistenceError——内存和磁盘始终一致，
 *   调用方可以原样重试；
 * - 打开时校验文件，损坏就用上一个完好版本（.bak），坏文件挪开、不删除（见 miniprogram-files.ts）；
 * - 宿主能力缺失时 initialize() 直接失败，不退回内存。
 *
 * singleConnection 为 true：只有一个内存连接，transactionalExecutor 可以用，也推荐用（整个迁移只落盘一次）。
 */
export function createMiniProgramAdapter(options: MiniProgramAdapterOptions): DbAdapter {
  const logger = options.logger ?? console
  let sqlite3: Sqlite3Static | null = null
  let db: Database | null = null
  let files: SnapshotFiles | null = null
  let fileKey: string | null = null
  /** 上一次成功保存（或打开时读到）的快照；落盘失败时用它恢复 */
  let lastSaved: Uint8Array | null = null
  let marks: ChangeMarks | null = null
  // 缓存进行中的 initialize()，避免并发调用各自跑一遍完整初始化流程并互相覆盖状态
  let initPromise: Promise<DbConnection> | null = null

  // 所有调用串行：落盘是异步的，另一条写入插进"执行"和"落盘"之间的话，失败恢复会把它也一起丢掉
  let queue: Promise<unknown> = Promise.resolve()
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(run)
    queue = result.catch(() => {})
    return result
  }

  function requireDb(): Database {
    if (!db) {
      throw new DbError("[MiniProgram DB] Database not initialized. Call initialize() first.")
    }
    return db
  }

  /** 新建一个内存连接；有快照时把它反序列化进去。快照打不开（不是 SQLite 文件、quick_check 不通过）时返回 undefined */
  function openConnection(s: Sqlite3Static, bytes: Uint8Array | null): Database | undefined {
    const conn = new s.oo1.DB(":memory:", "c")
    if (!bytes) return conn
    try {
      if (!hasSqliteHeader(bytes)) {
        conn.close()
        return undefined
      }
      // 内存要用 sqlite3_malloc 分配（wasm.alloc 就是它）：FREEONCLOSE 让 SQLite 在关闭时释放，失败时也由它释放
      const pointer = s.wasm.allocFromTypedArray(bytes)
      const flags = s.capi.SQLITE_DESERIALIZE_FREEONCLOSE | s.capi.SQLITE_DESERIALIZE_RESIZEABLE
      const rc = s.capi.sqlite3_deserialize(conn.pointer!, "main", pointer, bytes.byteLength, bytes.byteLength, flags)
      if (rc !== SQLITE_OK || conn.selectValue("PRAGMA quick_check") !== "ok") {
        conn.close()
        return undefined
      }
      return conn
    } catch {
      conn.close()
      return undefined
    }
  }

  function readMarks(d: Database): ChangeMarks {
    return {
      totalChanges: d.changes(true, false) as number,
      schemaVersion: d.selectValue("PRAGMA schema_version") as number,
      userVersion: d.selectValue("PRAGMA user_version") as number,
    }
  }

  function marksChanged(a: ChangeMarks, b: ChangeMarks): boolean {
    return a.totalChanges !== b.totalChanges || a.schemaVersion !== b.schemaVersion || a.userVersion !== b.userVersion
  }

  /**
   * 调用结束后决定要不要落盘：只在自动提交状态下（事务中导出的快照会带上没提交的数据）；
   * 写入类调用总是落盘，select 只在数据库确实变了的时候落盘（用 select 执行的 INSERT … RETURNING、PRAGMA user_version = …）。
   * 落盘失败时恢复到上次保存的快照并抛 DbPersistenceError。
   */
  async function persistIfNeeded(kind: "write" | "read"): Promise<void> {
    const s = sqlite3!
    const d = requireDb()
    if (s.capi.sqlite3_get_autocommit(d.pointer!) === 0) return
    const next = readMarks(d)
    if (kind === "read" && marks && !marksChanged(marks, next)) return
    const bytes = s.capi.sqlite3_js_db_export(d.pointer!)
    try {
      await files!.save(bytes)
      lastSaved = bytes
      marks = next
    } catch (error) {
      rollbackToLastSaved()
      throw new DbPersistenceError(error)
    }
  }

  /** 丢掉内存里没能落盘的改动：关闭当前连接，用上一次成功保存的快照重新打开 */
  function rollbackToLastSaved(): void {
    const s = sqlite3!
    try {
      db?.close()
    } catch {
      // 旧连接关不掉也要换成新连接
    }
    const restored = openConnection(s, lastSaved)
    if (!restored) {
      // lastSaved 是我们自己导出、成功写过的快照，打不开说明内存被破坏了；不能再继续用这个连接
      db = null
      throw new DbPersistenceError(new Error("[MiniProgram DB] Failed to restore the last saved snapshot"))
    }
    db = restored
    marks = readMarks(restored)
  }

  function runExec(d: Database, sql: string, params: unknown[]): { lastInsertId?: number; rowsAffected?: number } {
    d.exec({ sql, bind: params as never })
    const rowsAffected = d.changes(false, false) as number
    const lastInsertId = Number(sqlite3!.capi.sqlite3_last_insert_rowid(d.pointer!))
    return { lastInsertId, rowsAffected }
  }

  const client: DbConnection = {
    get storage(): DbStorage {
      return db ? { persistent: true } : { persistent: false, reason: "not-initialized" }
    },

    select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return serial(async () => {
        const d = requireDb()
        let rows: T[]
        try {
          rows = d.selectObjects(sql, params as never) as T[]
        } catch (error) {
          throw new DbExecutionError(sql, params, error)
        }
        await persistIfNeeded("read")
        return rows
      })
    },

    execute(sql: string, params: unknown[] = []): Promise<{ lastInsertId?: number; rowsAffected?: number }> {
      return serial(async () => {
        const d = requireDb()
        let result: { lastInsertId?: number; rowsAffected?: number }
        try {
          result = runExec(d, sql, params)
        } catch (error) {
          // 失败的语句也可能已经改了东西（多条语句里前面的已经生效），照样按规则落盘
          await persistIfNeeded("write").catch((persistError) => {
            throw new DbPersistenceError(new AggregateError([error, persistError], "SQL failed and persisting the partial result failed"))
          })
          throw new DbExecutionError(sql, params, error)
        }
        await persistIfNeeded("write")
        return result
      })
    },

    executeBatch(statements: BatchStatement[]): Promise<void> {
      return serial(async () => {
        const d = requireDb()
        if (statements.length === 0) return
        let failure: unknown = null
        try {
          if (statements.every((s) => typeof s === "string" || s.params === undefined || s.params.length === 0)) {
            // 和 memory 适配器一样：无绑定参数时拼成一条 SQL 一次跑完；分隔符用 "\n;\n"，见 memory.ts
            const sql = statements.map((s) => (typeof s === "string" ? s : s.sql)).join("\n;\n")
            try {
              d.exec({ sql })
            } catch (error) {
              throw new DbExecutionError(sql, [], error)
            }
          } else {
            for (const statement of statements) {
              const sql = typeof statement === "string" ? statement : statement.sql
              const params = typeof statement === "string" ? [] : (statement.params ?? [])
              try {
                runExec(d, sql, params)
              } catch (error) {
                throw new DbExecutionError(sql, params, error)
              }
            }
          }
        } catch (error) {
          failure = error
        }
        // 批量执行没有事务保证：中途失败时前面已经生效的语句照样落盘，再抛原来的错误
        try {
          await persistIfNeeded("write")
        } catch (persistError) {
          throw failure
            ? new DbPersistenceError(new AggregateError([failure, persistError], "batch failed and persisting failed"))
            : persistError
        }
        if (failure) throw failure
      })
    },

    close(): Promise<void> {
      return serial(async () => {
        // 先同步摘掉初始化缓存：init 进行中时等它落定，避免 close 返回后初始化才完成、留下一个没人持有句柄的连接
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
          files = null
          lastSaved = null
          marks = null
          if (fileKey) openFilesOf(options.fs).delete(fileKey)
          fileKey = null
        }
      })
    },
  }

  async function doInitialize(config: DbAdapterConfig): Promise<DbConnection> {
    const missing = missingFileSystemMethods(options.fs)
    if (missing.length > 0) {
      throw new DbInitializationError(new Error(`[MiniProgram DB] fs is missing ${missing.join(", ")}`))
    }
    if (!options.directory) {
      throw new DbInitializationError(new Error("[MiniProgram DB] directory is required"))
    }
    const key = `${options.directory.replace(/\/+$/, "")}/${config.name}`
    const opened = openFilesOf(options.fs)
    if (opened.has(key)) {
      throw new DbInitializationError(new Error(`[MiniProgram DB] ${key} is already open in this process`))
    }
    opened.add(key)
    try {
      sqlite3 ??= await options.sqlite3()
      const s = sqlite3
      const f = createSnapshotFiles(options.fs, options.directory, config.name, logger)
      let openedBytes: Uint8Array | null = null
      const { value } = await f.load((bytes) => {
        const conn = openConnection(s, bytes)
        if (conn) openedBytes = bytes
        return conn
      })
      const conn = value ?? openConnection(s, null)!
      files = f
      fileKey = key
      db = conn
      lastSaved = openedBytes
      marks = readMarks(conn)
      return client
    } catch (error) {
      opened.delete(key)
      db = null
      files = null
      throw error instanceof DbInitializationError ? error : new DbInitializationError(error)
    }
  }

  return {
    singleConnection: true,

    initialize(config: DbAdapterConfig, options?: DbInitializeOptions): Promise<DbConnection> {
      // 只在开始时检查一次取消信号：读文件和加载引擎都不支持中途取消
      if (options?.signal?.aborted) return Promise.reject(new DbInitializationError(options.signal.reason))
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
