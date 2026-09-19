import { describe, expect, it } from "vitest"
import { createDbClient } from "../src/core/index"
import { runMigrations } from "../src/core/migrate"
import { createMemoryAdapter } from "../src/adapters/memory"
import { transactionalExecutor } from "../src/adapters/web"
import { DbError, DbExecutionError, DbMigrationError } from "../src/core/errors"

describe("runMigrations", () => {
  it("applies pending migrations in order", async () => {
    const client = await createMemoryAdapter().initialize({ name: "test" })
    await runMigrations(client, [
      { version: 1, statements: ["CREATE TABLE t (id INTEGER PRIMARY KEY);"] },
      { version: 2, statements: ["ALTER TABLE t ADD COLUMN name TEXT;"] },
    ])
    const rows = await client.select<{ version: number }>("SELECT version FROM schema_version ORDER BY version;")
    expect(rows).toEqual([{ version: 1 }, { version: 2 }])
  })

  it("does not re-apply already-applied migrations", async () => {
    const client = await createMemoryAdapter().initialize({ name: "test" })
    const migrations = [{ version: 1, statements: ["CREATE TABLE t (id INTEGER PRIMARY KEY);"] }]

    await runMigrations(client, migrations)
    // second call must be a no-op (CREATE TABLE without IF NOT EXISTS would throw if re-run)
    await runMigrations(client, migrations)

    const rows = await client.select<{ version: number }>("SELECT version FROM schema_version;")
    expect(rows).toEqual([{ version: 1 }])
  })

  it("supports a custom transactional executor on a single-connection adapter", async () => {
    const client = await createMemoryAdapter().initialize({ name: "test" })
    await runMigrations(client, [{ version: 1, statements: ["CREATE TABLE t (id INTEGER PRIMARY KEY);"] }], {
      executor: transactionalExecutor,
    })
    const rows = await client.select<{ version: number }>("SELECT version FROM schema_version;")
    expect(rows).toEqual([{ version: 1 }])
  })
})

describe("createDbClient", () => {
  it("rejects a non-default executor on an adapter that is not singleConnection", async () => {
    const adapter = createMemoryAdapter()
    adapter.singleConnection = false // simulate a pooled-connection adapter

    await expect(
      createDbClient({
        name: "test",
        adapter,
        migrations: [{ version: 1, statements: ["CREATE TABLE t (id INTEGER PRIMARY KEY);"] }],
        migrationOptions: { executor: transactionalExecutor },
      }),
    ).rejects.toThrow(/singleConnection/)
  })

  it("allows a non-transactional custom executor on an adapter that is not singleConnection", async () => {
    const adapter = createMemoryAdapter()
    adapter.singleConnection = false // simulate a pooled-connection adapter
    const calls: number[] = []
    const loggingExecutor: import("../src/core/types").MigrationExecutor = async (db, migration, recordVersion) => {
      calls.push(migration.version)
      for (const statement of migration.statements) {
        await db.execute(statement)
      }
      await recordVersion()
    }

    const client = await createDbClient({
      name: "test",
      adapter,
      migrations: [{ version: 1, statements: ["CREATE TABLE t (id INTEGER PRIMARY KEY);"] }],
      migrationOptions: { executor: loggingExecutor },
    })

    expect(calls).toEqual([1])
    const rows = await client.select<{ version: number }>("SELECT version FROM schema_version;")
    expect(rows).toEqual([{ version: 1 }])
  })

  it("rejects a migration version <= 0", async () => {
    await expect(
      createDbClient({
        name: "test",
        adapter: createMemoryAdapter(),
        migrations: [{ version: 0, statements: ["CREATE TABLE t (id INTEGER PRIMARY KEY);"] }],
      }),
    ).rejects.toThrow(/positive integer/)
  })

  it("rejects a non-integer migration version", async () => {
    await expect(
      createDbClient({
        name: "test",
        adapter: createMemoryAdapter(),
        migrations: [{ version: 1.5, statements: ["CREATE TABLE t (id INTEGER PRIMARY KEY);"] }],
      }),
    ).rejects.toThrow(/positive integer/)
  })

  it("rejects duplicate migration versions", async () => {
    await expect(
      createDbClient({
        name: "test",
        adapter: createMemoryAdapter(),
        migrations: [
          { version: 1, statements: ["CREATE TABLE t (id INTEGER PRIMARY KEY);"] },
          { version: 1, statements: ["CREATE TABLE u (id INTEGER PRIMARY KEY);"] },
        ],
      }),
    ).rejects.toThrow(/Duplicate migration version 1/)
  })

  it("rejects an invalid migration tableName", async () => {
    const client = await createMemoryAdapter().initialize({ name: "test" })
    await expect(
      runMigrations(client, [{ version: 1, statements: ["CREATE TABLE t (id INTEGER PRIMARY KEY);"] }], {
        tableName: "schema_version; DROP TABLE t;--",
      }),
    ).rejects.toThrow(/tableName/)
  })

  it("wraps a failing migration in DbMigrationError carrying the version", async () => {
    const error = await createDbClient({
      name: "test",
      adapter: createMemoryAdapter(),
      migrations: [
        { version: 1, statements: ["CREATE TABLE t (id INTEGER PRIMARY KEY);"] },
        { version: 2, statements: ["SELECT * FROM no_such_table;"] },
      ],
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DbMigrationError)
    expect((error as DbMigrationError).version).toBe(2)
  })

  it("closes the client when migrations fail, so no connection/lock leaks", async () => {
    const adapter = createMemoryAdapter()
    let closeCalls = 0
    const realInitialize = adapter.initialize.bind(adapter)
    adapter.initialize = async (config) => {
      const client = await realInitialize(config)
      const realClose = client.close.bind(client)
      client.close = async () => {
        closeCalls += 1
        await realClose()
      }
      return client
    }

    await expect(
      createDbClient({
        name: "test",
        adapter,
        migrations: [{ version: 1, statements: ["SELECT * FROM no_such_table;"] }],
      }),
    ).rejects.toThrow(DbMigrationError)
    expect(closeCalls).toBe(1)
  })

  it("warns when the database is newer than the provided migrations", async () => {
    const client = await createMemoryAdapter().initialize({ name: "test" })
    await runMigrations(client, [
      { version: 1, statements: ["CREATE TABLE t (id INTEGER PRIMARY KEY);"] },
      { version: 2, statements: ["ALTER TABLE t ADD COLUMN name TEXT;"] },
      { version: 3, statements: ["ALTER TABLE t ADD COLUMN extra TEXT;"] },
    ])

    // 应用降级：只带 [1, 2]（全部已应用，无迁移洞），数据库版本 3 高于应用提供的最大版本
    const warnings: string[] = []
    const logger = { warn: (message: string) => warnings.push(message), error: () => {} }
    await runMigrations(
      client,
      [
        { version: 1, statements: ["CREATE TABLE t (id INTEGER PRIMARY KEY);"] },
        { version: 2, statements: ["ALTER TABLE t ADD COLUMN name TEXT;"] },
      ],
      { logger },
    )

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/newer than the highest migration/)
  })

  it("warns about provided-but-never-applied migrations below the current version (holes)", async () => {
    const client = await createMemoryAdapter().initialize({ name: "test" })
    // 旧包只发布了 [1, 2, 5]，新包补发了 3、4 —— 3 和 4 低于当前版本且从未应用
    await runMigrations(client, [
      { version: 1, statements: ["CREATE TABLE t (id INTEGER PRIMARY KEY);"] },
      { version: 2, statements: ["ALTER TABLE t ADD COLUMN a TEXT;"] },
      { version: 5, statements: ["ALTER TABLE t ADD COLUMN b TEXT;"] },
    ])

    const warnings: string[] = []
    const logger = { warn: (message: string) => warnings.push(message), error: () => {} }
    await runMigrations(
      client,
      [
        { version: 3, statements: ["ALTER TABLE t ADD COLUMN c TEXT;"] },
        { version: 4, statements: ["ALTER TABLE t ADD COLUMN d TEXT;"] },
        { version: 5, statements: ["ALTER TABLE t ADD COLUMN b TEXT;"] },
        { version: 6, statements: ["ALTER TABLE t ADD COLUMN e TEXT;"] },
      ],
      { logger },
    )

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/never applied/)
    expect(warnings[0]).toMatch(/3, 4/)
    // 高于当前版本的 6 仍然正常应用
    const rows = await client.select<{ version: number }>("SELECT version FROM schema_version ORDER BY version;")
    expect(rows.map((row) => row.version)).toEqual([1, 2, 5, 6])
  })

  it("initializes a client and applies migrations end to end", async () => {
    const client = await createDbClient({
      name: "test",
      adapter: createMemoryAdapter(),
      migrations: [{ version: 1, statements: ["CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL);"] }],
    })

    const { lastInsertId, rowsAffected } = await client.execute("INSERT INTO items (label) VALUES (?);", ["hello"])
    expect(rowsAffected).toBe(1)
    expect(lastInsertId).toBe(1)

    const rows = await client.select<{ id: number; label: string }>("SELECT * FROM items;")
    expect(rows).toEqual([{ id: 1, label: "hello" }])
  })
})

describe("errors", () => {
  it("throws DbExecutionError (not a plain Error) for a bad SQL statement", async () => {
    const client = await createMemoryAdapter().initialize({ name: "test" })
    const badSql = "SELECT * FROM this_table_does_not_exist;"

    const error = await client.select(badSql).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DbExecutionError)
    expect((error as DbExecutionError).sql).toBe(badSql)
  })

  it("throws DbError (not a plain Error) when using a client after close()", async () => {
    const adapter = createMemoryAdapter()
    const client = await adapter.initialize({ name: "test" })
    await client.close()

    const error = await client.select("SELECT 1;").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DbError)
  })
})
