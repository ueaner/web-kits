import { inject } from "vitest"
import sqlite3InitModule from "@sqlite.org/sqlite-wasm"
import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm"
import { createMemoryAdapter } from "../../src/adapters/memory"
import { createMiniProgramAdapter } from "../../src/adapters/miniprogram"
import type { DbAdapter, DbStorage } from "../../src/core/types"
import { createFakeFileSystem } from "./fake-fs"

declare module "vitest" {
  export interface ProvidedContext {
    testAdapter: "memory" | "miniprogram"
  }
}

/**
 * 与适配器无关的测试（client / migrate / observe）跑在哪个适配器上：vitest.config.ts 里的
 * "miniprogram" project 用 provide 传入 "miniprogram"，把同一批用例在小程序适配器上再跑一遍。
 */
export const TEST_ADAPTER: "memory" | "miniprogram" = inject("testAdapter") ?? "memory"

/** 打开以后 storage 应该是什么 */
export const OPEN_STORAGE: DbStorage = TEST_ADAPTER === "memory" ? { persistent: false, reason: "memory-adapter" } : { persistent: true }

let engine: Promise<Sqlite3Static> | null = null
/** 测试里的引擎：原版 sqlite-wasm（和 memory 适配器同一个），进程内只初始化一次 */
export const loadTestSqlite3 = (): Promise<Sqlite3Static> => (engine ??= sqlite3InitModule())

let seq = 0

/** 每次调用返回状态独立的新适配器：miniprogram 下各用一个新的假文件系统和目录，互不干扰 */
export function createTestAdapter(): DbAdapter {
  if (TEST_ADAPTER === "memory") return createMemoryAdapter()
  return createMiniProgramAdapter({
    sqlite3: loadTestSqlite3,
    fs: createFakeFileSystem(),
    directory: `/user-data/test-${++seq}`,
    logger: { warn() {}, error() {} },
  })
}
