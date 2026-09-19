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

export interface DbClient {
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

export interface DbAdapterConfig {
  /** 数据库文件名/标识，如 "my-app"（不含扩展名） */
  name: string
}

export interface DbAdapter {
  /**
   * 初始化并返回 client。并发或重复调用共享同一个进行中的初始化（去重），
   * config 以首次调用为准；close() 之后再调用会重开一个全新连接。
   */
  initialize(config: DbAdapterConfig): Promise<DbClient>
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
    db: Pick<DbClient, "execute" | "select" | "executeBatch">,
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
}
