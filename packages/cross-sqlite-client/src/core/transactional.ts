import type { MigrationExecutor } from "./types"

/**
 * 自定义事务型 executor，仅用于单连接适配器（web / memory / miniprogram）。
 *
 * 为什么不能给 Tauri 用：@tauri-apps/plugin-sql 底层是 sqlx::Pool<Sqlite> 连接池，每次
 * execute() 调用独立获取/归还连接，不保证 BEGIN 和 COMMIT 落在同一条物理连接上，事务可能被
 * 悄悄拆散且不报错。createDbClient 靠 executor 上的 requiresSingleConnection 标记拒绝这种
 * 组合，但直接调用 runMigrations() 时不会有这层保护，调用方需自行确保只在单连接适配器上使用。
 *
 * 放在 core 而不是 adapters/web：web 适配器静态引入了 sqlite-wasm 的 worker promiser，
 * 小程序端从那里引入会把它一起打进包。
 */
const runTransactionalMigration: MigrationExecutor = async (db, migration, recordVersion) => {
  await db.execute("BEGIN;")
  try {
    await db.executeBatch(migration.statements)
    await recordVersion()
    await db.execute("COMMIT;")
  } catch (e) {
    await db.execute("ROLLBACK;").catch(() => {})
    throw e
  }
}

// createDbClient 靠这个标记判断"这个 executor 需要单连接"，而不是靠函数引用是否等于
// defaultExecutor——后者只能拦住"自定义了非默认 executor"，拦不住"自定义了一个完全不涉及
// 事务的 executor（比如只加日志）"这种本来就安全、不该被拒绝的情况。
export const transactionalExecutor: MigrationExecutor = Object.assign(runTransactionalMigration, {
  requiresSingleConnection: true as const,
})
