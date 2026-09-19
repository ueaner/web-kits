import { DbMigrationError } from "./errors";
import type { DbClient, Logger, Migration, MigrationExecutor, MigrationOptions } from "./types";

/** 表名/PRAGMA 名等要拼进 SQL 的标识符，只允许这个白名单，杜绝注入 */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertIdentifier(value: string, what: string): void {
  if (!IDENTIFIER_RE.test(value)) {
    throw new Error(`${what} must match ${IDENTIFIER_RE} (letters, digits, underscore; not starting with a digit), got ${JSON.stringify(value)}.`);
  }
}

export const defaultExecutor: MigrationExecutor = async (db, migration, recordVersion) => {
  // 迁移语句不带绑定参数，web 适配器会把它们拼成一条 SQL 一次发给 worker，省掉逐条往返
  await db.executeBatch(migration.statements);
  await recordVersion();
};

/**
 * 按 version 顺序执行尚未应用的迁移。默认每条语句独立执行，没有事务包裹；若某条迁移执行到
 * 一半失败，下次启动会从同一个 version 重新开始，重新跑一遍这个 version 里的全部语句。
 *
 * 不能简单地在多次 execute() 调用之间手动包一层 BEGIN/COMMIT/ROLLBACK 来补救：部分适配器
 * （例如 Tauri 端的 @tauri-apps/plugin-sql）底层是连接池，每次 execute() 调用都独立获取/
 * 归还一个物理连接，不保证 BEGIN 和 COMMIT 落在同一条连接上，事务可能被悄悄拆散而不报错。
 * 只有 adapter.singleConnection === true 的适配器才能安全地使用自定义的事务型 executor
 * （见 adapters/web.ts 的 transactionalExecutor，以及 createDbClient 里的运行时检查）。
 *
 * 因此，MIGRATIONS 里的每条语句都必须自身是可安全重试的：
 * - 建表/建索引一律用 CREATE TABLE/INDEX IF NOT EXISTS；
 * - 以后如果要写重命名列、迁移数据这类不可重复执行的语句，先查询当前 schema 状态判断
 *   这一步是否已经做过（例如 `SELECT 1 FROM pragma_table_info('t') WHERE name = '...'`），
 *   已完成就跳过，而不是依赖事务回滚。
 *
 * executor 抛出的错误会被包装成 DbMigrationError（携带失败的 version）再向上抛。
 *
 * 不可重入：同一个数据库同一时间只允许一个 runMigrations 在执行。并发调用会各自读取
 * 相同起点并重复执行——语句幂等所以无害，但两边都会写版本记录，后到一方撞主键约束，
 * 报出"迁移失败"的误导性错误。
 */
export async function runMigrations(
  db: Pick<DbClient, "execute" | "select" | "executeBatch">,
  migrations: Migration[],
  options?: MigrationOptions,
): Promise<void> {
  const tableName = options?.tableName ?? "schema_version";
  const executor = options?.executor ?? defaultExecutor;
  const logger: Logger = options?.logger ?? console;

  assertIdentifier(tableName, "Migration tableName");

  // version 必须从 1 开始且为正整数：currentVersion 未应用任何迁移时的初始值是 0，
  // 一个 version: 0 的迁移永远满足不了下面的 `migration.version > currentVersion`，会被静默忽略
  const seen = new Set<number>();
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      throw new Error(`Migration version must be a positive integer, got ${migration.version}.`);
    }
    if (seen.has(migration.version)) {
      throw new Error(`Duplicate migration version ${migration.version}.`);
    }
    seen.add(migration.version);
  }

  await db.execute(
    `CREATE TABLE IF NOT EXISTS ${tableName} (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT 0
    );`,
  );

  const rows = await db.select<{ version: number }>(`SELECT version FROM ${tableName};`);
  const applied = new Set(rows.map((row) => row.version));
  const currentVersion = Math.max(0, ...applied);

  const maxProvided = migrations.reduce((max, migration) => Math.max(max, migration.version), 0);
  if (currentVersion > maxProvided) {
    logger.warn(
      `[Migrations] Database schema version (${currentVersion}) is newer than the highest migration provided by this app (${maxProvided}). ` +
        "The database was likely created by a newer app version; no migrations were run.",
    );
  }

  // 低于 currentVersion 但从未应用过的"迟到迁移"（比如旧库从 [1,2,5] 升级到补发了 3,4 的新包）。
  // 不自动补跑——乱序应用可能破坏 schema 演进假设；但必须告警而不是静默跳过
  const holes = migrations.filter((migration) => migration.version < currentVersion && !applied.has(migration.version));
  if (holes.length > 0) {
    logger.warn(
      `[Migrations] ${holes.length} migration(s) with version below the current schema version (${currentVersion}) were never applied ` +
        `and are being skipped: ${holes.map((migration) => migration.version).join(", ")}. ` +
        "If these are hotfix migrations for an older release line, apply them deliberately (e.g. with a dedicated executor) instead of relying on the default runner.",
    );
  }

  const pending = migrations.filter((migration) => migration.version > currentVersion).sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    try {
      await executor(db, migration, async () => {
        // applied_at 从 JS 侧传入，避免依赖 SQLite 3.42+ 的 strftime('%s','subsec')
        await db.execute(`INSERT INTO ${tableName} (version, applied_at) VALUES (?, ?);`, [migration.version, Date.now()]);
      });
    } catch (error) {
      throw error instanceof DbMigrationError ? error : new DbMigrationError(migration.version, error);
    }
  }
}
