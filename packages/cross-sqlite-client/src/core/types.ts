/**
 * 库内部诊断信息的输出通道。默认是 console；生产应用可以传入自己的实现，
 * 把告警/错误接入自己的日志系统或静默掉。
 */
export interface Logger {
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** executeBatch 的一条语句：纯 SQL 字符串，或带绑定参数的对象形式 */
export type BatchStatement = string | { sql: string; params?: unknown[] }

/**
 * 数据为什么不持久化（DbStorage.persistent 为 false 时）：
 * - "not-initialized"：还没有打开的连接（initialize() 之前、close() 之后、initialize() 失败后）；
 * - "memory-adapter"：用的就是内存适配器（测试），本来就不持久化。只有内存适配器会给出，web 适配器不会；
 * - "opfs-unsupported"：浏览器不支持 OPFS（navigator.storage.getDirectory 不存在）；
 * - "not-cross-origin-isolated"：页面没有跨源隔离（缺 COOP/COEP 响应头，常见于代理或托管方去掉了它们），
 *   sqlite-wasm 的 opfs VFS 用不了；
 * - "opfs-unavailable"：OPFS 探测失败（私有模式、配额、权限）；
 * - "open-failed"：探测通过，但 opfs VFS 打开数据库文件失败。
 */
export type MemoryFallbackReason =
  | "not-initialized"
  | "memory-adapter"
  | "opfs-unsupported"
  | "not-cross-origin-isolated"
  | "opfs-unavailable"
  | "open-failed"

/** 数据实际存在哪里。web 适配器在 OPFS 不可用、并且 fallbackToMemory 为 true 时会退回内存 */
export type DbStorage =
  | {
      /** 持久化：关掉页面、刷新、重启应用后数据还在 */
      persistent: true
    }
  | {
      /** 只在内存里：关掉页面或刷新后数据就没了 */
      persistent: false
      reason: MemoryFallbackReason
    }

/**
 * 适配器 initialize() 返回的底层连接：执行 SQL，不发写入通知。
 * 应用代码一般用 createDbClient() 返回的 DbClient；只需要读写 SQL 的地方（比如仓储层）
 * 可以把参数类型写成 DbConnection，DbClient 也能传进去。
 */
export interface DbConnection {
  /**
   * 这个连接的数据实际存在哪里。web 适配器静默退回内存时，应用可以靠它提示用户"这次的数据不会保存"，
   * 而不是等用户刷新后才发现数据没了。initialize() 之前、close() 之后、initialize() 失败后为
   * { persistent: false, reason: "not-initialized" }；同一个 client 关闭后重新 initialize()，值按新连接更新。
   */
  readonly storage: DbStorage
  select<T>(sql: string, params?: unknown[]): Promise<T[]>
  execute(sql: string, params?: unknown[]): Promise<{ lastInsertId?: number; rowsAffected?: number }>
  /**
   * 顺序执行一批语句，无跨语句事务保证（库目前不提供业务侧事务 API：连接池型适配器
   * 无法保证 BEGIN/COMMIT 落在同一物理连接上，业务多语句写入请自行保证幂等）。
   * 全部语句不带 params 时，web/memory 适配器会把它们拼成一条 SQL 一次性发给底层引擎
   * （web 侧省掉每条一次的 worker 往返）；只要批内有任何一条带参语句，整批退化为逐条执行。
   * 注意：拼接路径失败时 DbExecutionError.sql 是拼接后的整条 SQL，无法指出失败的是第几句；
   * 需要精确定位就自己逐条 execute()。
   */
  executeBatch(statements: BatchStatement[]): Promise<void>
  close(): Promise<void>
}

/**
 * createDbClient() 返回的 client：在 DbConnection 之上多了写入通知。
 *
 * 通知只说明"有写入"，不说明写了哪张表：sqlite-wasm 的 Worker1 接口和 Tauri 的 plugin-sql
 * 都拿不到 SQLite 的 update_hook；连接池上 TEMP 触发器靠不住；从 SQL 里解析表名又会漏掉
 * 触发器和外键级联写到的表。失效通知宁可多发、不能漏发，所以只给这一种信号。
 */
export interface DbClient extends DbConnection {
  /**
   * 每次 execute() / executeBatch() 结束后通知（成功和失败都通知：executeBatch 没有事务，
   * 中途失败时前面的语句已经生效）。同一个任务里的多次写入合并成一次，在写入的 Promise
   * 结束之后异步发出。select() 不通知——写语句（包括 INSERT … RETURNING）要走 execute()。
   * listener 抛出的错误交给 logger，不影响写入，也不影响其他 listener。close() 之后不再通知。
   * @returns 取消订阅的函数
   */
  onWrite(listener: () => void): () => void
  /**
   * fn 执行期间的写入先攒着，fn 结束（成功或抛错）后合并成一次通知；可以嵌套，最外层结束时才通知。
   * 手写事务（execute("BEGIN") … execute("COMMIT")）必须放进来，否则监听方可能在提交之前
   * 重新查询，读到还没提交的数据。它管的是通知，不是事务：同时进行的几个 groupWrites
   * 会一起等到最后一个结束才通知。
   */
  groupWrites<T>(fn: () => Promise<T>): Promise<T>
}

export interface DbAdapterConfig {
  /** 数据库文件名/标识，如 "my-app"（不含扩展名） */
  name: string
}

export interface DbInitializeOptions {
  /**
   * 取消初始化。目前只有 web 适配器在 singleTabLock: "wait" 下排队等锁时会用到；
   * 其他适配器只在开始时检查一次。并发调用共享第一次的初始化，后来调用传的 signal 被忽略
   */
  signal?: AbortSignal
}

export interface DbAdapter {
  /**
   * 初始化并返回 client。并发或重复调用共享同一个进行中的初始化（去重），
   * config 以首次调用为准；close() 之后再调用会重开一个全新连接。
   */
  initialize(config: DbAdapterConfig, options?: DbInitializeOptions): Promise<DbConnection>
  /**
   * 该适配器的每次 execute()/select() 调用是否保证落在同一条物理连接上。
   * web/memory 适配器是单一持久连接，为 true；Tauri 适配器底层是
   * sqlx::Pool<Sqlite> 连接池，不同调用可能拿到不同物理连接，为 false。
   * 决定了自定义 MigrationExecutor 里手写的 BEGIN/COMMIT 是否安全。
   */
  singleConnection: boolean
}

export interface Migration {
  version: number
  statements: string[]
}

/**
 * 迁移执行器。内部手写 BEGIN/COMMIT 的 executor 必须把 requiresSingleConnection 设为
 * true（如 adapters/web 的 transactionalExecutor）：createDbClient 会拒绝把它用在
 * singleConnection !== true 的适配器上。完全不碰事务的 executor（比如只加日志）不需要
 * 这个标记。
 * 约定：executor 不要自行抛 DbMigrationError——失败时抛底层错误即可，version 由
 * runMigrations 统一包装填充。
 */
export interface MigrationExecutor {
  (
    db: Pick<DbConnection, "execute" | "select" | "executeBatch">,
    migration: Migration,
    /** 记录 schema_version 的回调；executor 决定何时调用（比如放进自己的事务里） */
    recordVersion: () => Promise<void>,
  ): Promise<void>
  /** true 表示该 executor 手写 BEGIN/COMMIT，仅可用于 singleConnection === true 的适配器 */
  requiresSingleConnection?: boolean
}

export interface MigrationOptions {
  /** schema 版本表名，默认 "schema_version"；仅限字母/数字/下划线且不以数字开头 */
  tableName?: string
  /** 自定义执行策略，见 MigrationExecutor */
  executor?: MigrationExecutor
  /** 迁移过程中的诊断输出（如"数据库版本高于当前应用"告警），默认 console */
  logger?: Logger
}

export interface CreateDbClientOptions {
  name: string
  /** 必须显式传入实例，库不提供 'auto'/'web'/'tauri' 字符串快捷方式 */
  adapter: DbAdapter
  migrations?: Migration[]
  migrationOptions?: MigrationOptions
  /**
   * initialize 之后、迁移之前执行的 PRAGMA 配置，如 { foreign_keys: true, journal_mode: "WAL" }。
   * key 仅限字母/数字/下划线；string 值仅限字母/数字/下划线（覆盖 WAL、NORMAL 这类枚举值），
   * boolean 会转成 0/1。非法的 key/value 会直接抛错而不是拼进 SQL。
   */
  pragmas?: Record<string, string | number | boolean>
  /** 诊断输出通道，默认 console；被 migrationOptions.logger 覆盖（迁移阶段） */
  logger?: Logger
  /** 传给 adapter.initialize() 的取消信号，见 DbInitializeOptions */
  signal?: AbortSignal
}
