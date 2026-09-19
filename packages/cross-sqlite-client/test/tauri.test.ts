import { beforeEach, describe, expect, it, vi } from "vitest";

// Tauri 适配器在 Node 里跑不了真实 IPC，用 mock 的 plugin-sql 做契约测试：
// 验证适配器对驱动返回值的映射、错误包装和生命周期语义，而不是驱动本身
const { loadMock } = vi.hoisted(() => ({ loadMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-sql", () => ({
  default: { load: (...args: unknown[]) => loadMock(...args) },
}));

import { createTauriAdapter } from "../src/adapters/tauri";
import { DbError, DbExecutionError, DbInitializationError } from "../src/core/errors";

function fakeDb() {
  return {
    select: vi.fn(async (_sql: string, _params?: unknown[]) => [{ n: 1 }]),
    execute: vi.fn(async (_sql: string, _params?: unknown[]) => ({ lastInsertId: 7, rowsAffected: 1 })),
    close: vi.fn(async () => true),
  };
}

beforeEach(() => {
  loadMock.mockReset();
});

describe("createTauriAdapter", () => {
  it("loads sqlite:<name>.db and maps driver results", async () => {
    const db = fakeDb();
    loadMock.mockResolvedValue(db);

    const client = await createTauriAdapter().initialize({ name: "my-app" });
    expect(loadMock).toHaveBeenCalledWith("sqlite:my-app.db");

    expect(await client.select("SELECT 1;")).toEqual([{ n: 1 }]);
    const result = await client.execute("INSERT INTO t VALUES (?);", ["x"]);
    expect(result).toEqual({ lastInsertId: 7, rowsAffected: 1 });
    expect(db.execute).toHaveBeenCalledWith("INSERT INTO t VALUES (?);", ["x"]);
  });

  it("reports singleConnection: false (pooled driver)", () => {
    expect(createTauriAdapter().singleConnection).toBe(false);
  });

  it("wraps driver failures in DbExecutionError carrying sql/params", async () => {
    // 驱动 reject 一个字符串（Tauri IPC 常见）也必须包成 DbExecutionError
    loadMock.mockResolvedValue({
      ...fakeDb(),
      select: vi.fn(async () => Promise.reject("no such table")),
    });
    const client = await createTauriAdapter().initialize({ name: "test" });
    const badSql = "SELECT * FROM nope;";
    const error = await client.select(badSql, [1]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DbExecutionError);
    expect((error as DbExecutionError).sql).toBe(badSql);
    expect((error as DbExecutionError).params).toEqual([1]);
  });

  it("wraps load failure in DbInitializationError", async () => {
    loadMock.mockRejectedValue(new Error("plugin not available"));
    await expect(createTauriAdapter().initialize({ name: "test" })).rejects.toBeInstanceOf(DbInitializationError);
  });

  it("dedupes concurrent initialize() calls into a single load", async () => {
    loadMock.mockResolvedValue(fakeDb());
    const adapter = createTauriAdapter();
    const [a, b] = await Promise.all([adapter.initialize({ name: "test" }), adapter.initialize({ name: "test" })]);
    expect(a).toBe(b);
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it("re-loads after close()", async () => {
    loadMock.mockResolvedValue(fakeDb());
    const adapter = createTauriAdapter();
    const client = await adapter.initialize({ name: "test" });
    await client.close();
    await adapter.initialize({ name: "test" });
    expect(loadMock).toHaveBeenCalledTimes(2);
  });

  it("concurrent close() calls result in a single driver close", async () => {
    const db = fakeDb();
    loadMock.mockResolvedValue(db);
    const client = await createTauriAdapter().initialize({ name: "test" });
    await Promise.all([client.close(), client.close()]);
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it("throws DbError (not DbExecutionError) when used after close()", async () => {
    loadMock.mockResolvedValue(fakeDb());
    const client = await createTauriAdapter().initialize({ name: "test" });
    await client.close();

    const error = await client.select("SELECT 1;").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DbError);
    expect(error).not.toBeInstanceOf(DbExecutionError);
  });

  it("executeBatch runs statements sequentially through execute", async () => {
    const db = fakeDb();
    loadMock.mockResolvedValue(db);
    const client = await createTauriAdapter().initialize({ name: "test" });
    await client.executeBatch(["CREATE TABLE a (x);", { sql: "INSERT INTO a VALUES (?);", params: [1] }]);
    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(db.execute).toHaveBeenNthCalledWith(2, "INSERT INTO a VALUES (?);", [1]);
  });
});
