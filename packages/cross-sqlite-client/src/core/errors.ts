export class DbError extends Error {
  constructor(
    message: string,
    public cause?: unknown,
  ) {
    super(message)
    this.name = "DbError"
  }
}

export class DbInitializationError extends DbError {
  constructor(cause?: unknown) {
    super("Failed to initialize database", cause)
    this.name = "DbInitializationError"
  }
}

export class DbExecutionError extends DbError {
  constructor(
    public sql: string,
    public params: unknown[],
    cause?: unknown,
  ) {
    super(`SQL execution failed: ${sql}`, cause)
    this.name = "DbExecutionError"
  }
}

/**
 * 某条迁移执行失败。version 指出失败的是哪个迁移版本，cause 是底层原始错误
 * （通常是 DbExecutionError）。runMigrations 会把 executor 抛出的非 DbMigrationError
 * 错误统一包装成这个类型再向上抛。
 */
export class DbMigrationError extends DbError {
  constructor(
    public version: number,
    cause?: unknown,
  ) {
    // 底层不一定是 Error（可能是字符串、DOMException、promiser 的裸对象），message 里都带上
    const detail = cause instanceof Error ? cause.message : cause === undefined ? "" : String(cause)
    super(`Migration ${version} failed${detail ? `: ${detail.slice(0, 500)}` : ""}`, cause)
    this.name = "DbMigrationError"
  }
}

export class DbCloseError extends DbError {
  constructor(cause?: unknown) {
    super("Failed to close database", cause)
    this.name = "DbCloseError"
  }
}

/**
 * 另一个浏览器标签页/窗口已经持有同一个 OPFS 数据库文件的跨标签页锁。
 * 只有 web 适配器在 singleTabLock 启用时会抛出这个类型；调用方可以据此展示
 * "请关闭其他标签页" 之类的提示，而不是把它当成普通的初始化失败处理。
 */
export class DbTabLockError extends DbError {
  constructor(cause?: unknown) {
    super("Another browser tab/window already has this database open", cause)
    this.name = "DbTabLockError"
  }
}
