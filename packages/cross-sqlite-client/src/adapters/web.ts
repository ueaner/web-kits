import type { BatchStatement, DbAdapter, DbAdapterConfig, DbClient, Logger, MigrationExecutor } from "../core/types";
import { DbCloseError, DbError, DbExecutionError, DbInitializationError, DbTabLockError } from "../core/errors";

import { sqlite3Worker1Promiser } from "@sqlite.org/sqlite-wasm";
import type { Promiser, DbId, PromiserResponseError, PromiserResponseSuccess } from "@sqlite.org/sqlite-wasm";

export interface WebAdapterOptions {
  /** 等待 Worker 就绪的超时时间（毫秒），超时后 initialize() 会 reject 而不是永远 pending */
  timeoutMs?: number;
  /** OPFS 不可用（不支持/未跨域隔离/探测或打开失败）时是否静默退化为内存模式，默认 true */
  fallbackToMemory?: boolean;
  /**
   * 用 Web Locks API（navigator.locks）在同一 origin 的多个标签页/窗口之间协调对同一个
   * OPFS 文件的访问，默认 true。
   *
   * 背景：sqlite-wasm 的 opfs VFS 本身有锁协议（xLock/xUnlock 走 SharedArrayBuffer +
   * Atomics.wait()），两个标签页同时写同一个 OPFS 文件不会挂死或数据损坏，冲突时会重试一段
   * 时间后返回 SQLITE_BUSY，作为一次普通的、可 catch 的 SQL 错误出现——但这个错误只会在业务
   * 代码真正执行到某条 SQL 语句时才暴露，且没有任何提示"这是因为别的标签页正在用这个库"。
   * 启用 singleTabLock 后，initialize() 会在真正打开 OPFS 文件之前先尝试抢一个跨标签页命名
   * 锁；抢不到（说明另一个标签页已经持有）会立即抛出 DbTabLockError，而不是让业务代码在某次
   * 随机的查询里才踩到一个语义不明的 SQL 错误。
   *
   * 只在真的走 OPFS 持久化时才会用到这把锁——:memory: 每个标签页互相独立，没有需要协调的资源，
   * 不受这个选项影响。
   */
  singleTabLock?: boolean;
  /** 诊断输出（OPFS 降级告警、worker 错误等），默认 console */
  logger?: Logger;
}

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * promiser 的错误以 reject 形式出现，且 rejection 值是 {type:"error", result:{message,...}}
 * 形状的普通对象而不是 Error 实例（见 src/types/sqlite-wasm.d.ts 里 Promiser 的说明）。
 */
function isPromiserError(error: unknown): error is PromiserResponseError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { type?: unknown }).type === "error" &&
    typeof (error as { result?: { message?: unknown } }).result?.message === "string"
  );
}

/** 从 promiser 的 rejection 值里提取可读消息；不是 promiser 错误就原样返回 */
function promiserErrorCause(error: unknown): unknown {
  return isPromiserError(error) ? new Error(error.result.message) : error;
}

/**
 * 用 Web Locks API 尝试（不等待）拿到一个跨标签页命名锁。拿不到（另一个标签页已持有）时
 * 返回 null；拿到时返回一个 release() 函数，调用方后续必须调用它来释放锁。
 *
 * 实现上依赖一个常见技巧：navigator.locks.request() 的回调函数返回什么 Promise，锁就持有到
 * 那个 Promise settle 为止；这里让回调返回一个我们自己创建、直到 release() 被调用才会 resolve
 * 的 Promise，从而把锁"长期持有"而不是只在回调执行期间持有。
 */
export async function tryAcquireTabLock(lockName: string): Promise<(() => void) | null> {
  if (typeof navigator === "undefined" || !navigator.locks) {
    // 不支持 Web Locks API 的环境（老浏览器、非浏览器测试环境）：跳过协调，行为等同于未启用
    return () => {};
  }

  let release: (() => void) | undefined;
  const acquired = new Promise<boolean>((resolveAcquired) => {
    void navigator.locks.request(lockName, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolveAcquired(false);
        return;
      }
      resolveAcquired(true);
      return new Promise<void>((resolveRelease) => {
        release = resolveRelease;
      });
    });
  });

  const gotLock = await acquired;
  if (!gotLock) {
    return null;
  }
  return () => release?.();
}

/**
 * Web (sqlite-wasm) 适配器。每次调用 createWebAdapter() 返回一个状态独立的新实例——
 * promiser/dbId 保存在这个函数的闭包里，不是模块级单例，允许同一进程里存在多个互不干扰的
 * 实例（例如测试）。
 */
export function createWebAdapter(options: WebAdapterOptions = {}): DbAdapter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fallbackToMemory = options.fallbackToMemory ?? true;
  const singleTabLock = options.singleTabLock ?? true;
  const logger: Logger = options.logger ?? console;

  let promiser: Promiser | null = null;
  let currentDbId: DbId | undefined;
  let releaseTabLock: (() => void) | null = null;
  // 自己持有 Worker 实例（经 promiser 的 defaultConfig 工厂创建，URL 解析仍在 sqlite-wasm
  // 自己的模块里发生），这样超时和 close 时才能 terminate，避免孤儿 Worker 累积
  let worker: Worker | null = null;
  // 缓存进行中的 initialize()，避免并发调用各自跑一遍完整初始化流程并互相覆盖状态。
  // config 以首次调用为准（后续调用直接返回同一个 client）。
  let initPromise: Promise<DbClient> | null = null;

  function requirePromiser(): { p: Promiser; dbId: DbId } {
    if (!promiser || currentDbId === undefined) {
      throw new DbError("[Web DB] Database not initialized. Call initialize() first.");
    }
    return { p: promiser, dbId: currentDbId };
  }

  async function exec(sql: string, params: unknown[]): Promise<PromiserResponseSuccess<"exec">> {
    const { p, dbId } = requirePromiser();
    try {
      // countChanges/lastInsertRowId 让 Worker 直接把 sqlite3_total_changes() 和
      // sqlite3_last_insert_rowid() 的结果带回来，避免额外发一次查询（那样在共享连接上有竞态）。
      // 注意：错误响应是 reject 出来的普通对象，不是 resolve 出来的 error 型 response。
      return await p("exec", {
        dbId,
        sql,
        bind: params,
        resultRows: [],
        rowMode: "object",
        countChanges: true,
        lastInsertRowId: true,
      });
    } catch (error) {
      throw new DbExecutionError(sql, params, promiserErrorCause(error));
    }
  }

  const client: DbClient = {
    async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const response = await exec(sql, params);
      return (response.result.resultRows as T[]) || [];
    },

    async execute(sql: string, params: unknown[] = []): Promise<{ lastInsertId?: number; rowsAffected?: number }> {
      const response = await exec(sql, params);
      return {
        // lastInsertRowId 是 BigInt；调用方对非 INSERT 语句请求该值本身没有意义，但转换总是安全的
        lastInsertId: response.result.lastInsertRowId !== undefined ? Number(response.result.lastInsertRowId) : undefined,
        rowsAffected: response.result.changeCount ?? 0,
      };
    },

    async executeBatch(statements: BatchStatement[]): Promise<void> {
      if (statements.length === 0) {
        return;
      }
      if (statements.every((s) => typeof s === "string" || s.params === undefined || s.params.length === 0)) {
        // 无绑定参数：拼成一条 SQL 单次 worker 往返跑完（迁移场景的主要收益）。
        // 分隔符用 "\n;\n" 而不是 "\n"：用户语句可能不带结尾分号（逐条 execute 时无所谓，
        // 拼起来就 syntax error），也可能以 -- 行注释结尾（";" 直接跟在注释后会被注释掉）；
        // 多出的空语句 sqlite 会忽略。代价：此路径出错时 DbExecutionError.sql 是拼接后的整条
        // SQL，无法指出失败的是第几句；需要精确定位就自己逐条 execute。
        const { p, dbId } = requirePromiser();
        const sql = statements.map((s) => (typeof s === "string" ? s : s.sql)).join("\n;\n");
        try {
          await p("exec", { dbId, sql });
        } catch (error) {
          throw new DbExecutionError(sql, [], promiserErrorCause(error));
        }
        return;
      }
      for (const statement of statements) {
        const sql = typeof statement === "string" ? statement : statement.sql;
        const params = typeof statement === "string" ? [] : (statement.params ?? []);
        await client.execute(sql, params);
      }
    },

    async close(): Promise<void> {
      // 先同步摘掉初始化缓存再处理：init 进行中时等它落定（成功或失败都行——失败路径
      // doInitialize 自己已经清理过了），确保随后关闭的是真正打开的连接，而不是让
      // 初始化在 close 之后悄悄完成、留下一个没人持有句柄的连接和标签页锁
      const pending = initPromise;
      initPromise = null;
      if (pending) {
        await pending.catch(() => {});
      }

      // 先把状态清零再发 close 消息：并发的第二个 close() 看到空状态直接 no-op，
      // 不会对同一个 dbId 重复 close
      const p = promiser;
      const dbId = currentDbId;
      const w = worker;
      promiser = null;
      currentDbId = undefined;
      worker = null;
      releaseTabLock?.();
      releaseTabLock = null;

      try {
        if (p && dbId !== undefined) {
          await p("close", { dbId });
        }
      } catch (error) {
        throw new DbCloseError(promiserErrorCause(error));
      } finally {
        // db 关完后 Worker 里已经没有这个连接了，terminate 释放线程；重开会新建 Worker
        w?.terminate();
      }
    },
  };

  function createWorker(): Worker | undefined {
    // 用 sqlite-wasm 自己的默认工厂创建 Worker——new URL("sqlite3-worker1.mjs", import.meta.url)
    // 的解析必须发生在 sqlite-wasm 模块内部，在我们自己的代码里重写会因打包后路径不同而 404。
    // 创建失败（比如非浏览器环境的奇怪组合）时不传 worker，让 promiser 走自己的默认路径兜底。
    try {
      const factory = sqlite3Worker1Promiser.defaultConfig?.worker;
      if (typeof factory === "function") {
        return factory();
      }
      return factory;
    } catch {
      return undefined;
    }
  }

  async function openDatabase(p: Promiser, filename: string): Promise<DbId> {
    const openResponse = await p("open", { filename });
    if (openResponse.dbId === undefined) {
      throw new DbInitializationError(
        new Error("Database opened successfully but dbId is undefined. This indicates an unexpected library behavior."),
      );
    }
    return openResponse.dbId;
  }

  async function doInitialize(config: DbAdapterConfig): Promise<DbClient> {
    const isOpfsSupported =
      typeof navigator !== "undefined" && typeof navigator.storage !== "undefined" && !!navigator.storage.getDirectory;
    const isCrossOriginIsolated = typeof window !== "undefined" && window.crossOriginIsolated;

    let filename: string = ":memory:";

    if (!isOpfsSupported || !isCrossOriginIsolated) {
      if (!fallbackToMemory) {
        throw new DbInitializationError(
          new Error("[Web DB] OPFS is not available (unsupported or not cross-origin isolated) and fallbackToMemory is false."),
        );
      }
      logger.warn("[Web DB] OPFS is not fully supported or cross-origin isolated. Falling back to in-memory mode.");
    } else {
      try {
        const root = await navigator.storage.getDirectory();
        await root.getFileHandle("test_opfs_support", { create: true });
        // 探测文件只是为了确认 OPFS 真的可用，用完即删，避免每次初始化都留下一个垃圾文件
        await root.removeEntry("test_opfs_support").catch(() => {});
        filename = `file:${config.name}.db?vfs=opfs`;
      } catch (opfsError) {
        if (!fallbackToMemory) {
          throw new DbInitializationError(
            new Error("[Web DB] OPFS initialization failed and fallbackToMemory is false.", { cause: opfsError }),
          );
        }
        logger.warn("[Web DB] OPFS initialization failed or file access denied. Falling back to in-memory mode.", opfsError);
        filename = ":memory:";
      }
    }

    // :memory: 每个标签页各自独立，没有需要协调的共享资源，只在真正落到 OPFS 文件时才需要抢锁。
    // 注意 DbTabLockError 必须原样抛出（不能包成 DbInitializationError），调用方靠它区分
    // "别的标签页在用"和"初始化失败"；但获取锁这个动作本身的异常（如 SecurityError）要统一
    // 包成 DbInitializationError。
    if (filename !== ":memory:" && singleTabLock) {
      let release: (() => void) | null;
      try {
        release = await tryAcquireTabLock(`cross-sqlite-client:${config.name}`);
      } catch (error) {
        throw new DbInitializationError(error);
      }
      if (!release) {
        throw new DbTabLockError();
      }
      releaseTabLock = release;
    }

    try {
      // 注意：库自身的 onerror 只是诊断日志钩子（用于"未处理的 worker 消息"等情况），并不会
      // reject 这个 Promise —— 如果 Worker 脚本本身加载失败（404、网络错误等），既不会触发
      // onerror 也不会触发 onready，Promise 会永远 pending。因此这里用超时兜底。
      worker = createWorker() ?? null;
      const readyPromise = sqlite3Worker1Promiser({
        worker: worker ?? undefined,
        onerror: (...args) => logger.error("[Web DB] sqlite3Worker1Promiser error:", ...args),
      });
      let rejectTimeout!: (error: Error) => void;
      const timeoutPromise = new Promise<never>((_, reject) => {
        rejectTimeout = reject;
      });
      const timeoutId = setTimeout(
        () =>
          rejectTimeout(
            new Error(
              `[Web DB] Timed out after ${timeoutMs}ms waiting for the SQLite worker to become ready (it may have failed to load).`,
            ),
          ),
        timeoutMs,
      );
      try {
        promiser = await Promise.race([readyPromise, timeoutPromise]);
      } finally {
        clearTimeout(timeoutId);
      }

      try {
        currentDbId = await openDatabase(promiser, filename);
      } catch (openError) {
        // 探测通过不代表 opfs VFS 真能打开（SAH pool、配额、私有模式的怪异行为）——
        // fallbackToMemory 也覆盖这一阶段
        if (filename !== ":memory:" && fallbackToMemory) {
          logger.warn("[Web DB] Failed to open the OPFS database. Falling back to in-memory mode.", promiserErrorCause(openError));
          currentDbId = await openDatabase(promiser, ":memory:");
        } else {
          throw openError;
        }
      }

      return client;
    } catch (error) {
      promiser = null;
      currentDbId = undefined;
      worker?.terminate();
      worker = null;
      releaseTabLock?.();
      releaseTabLock = null;
      if (error instanceof DbInitializationError) {
        throw error;
      }
      throw new DbInitializationError(promiserErrorCause(error));
    }
  }

  return {
    singleConnection: true,

    initialize(config: DbAdapterConfig): Promise<DbClient> {
      if (!initPromise) {
        initPromise = doInitialize(config);
        // 失败后允许重试；挂在缓存 promise 上而不是改写在它的 reject 路径里，
        // 调用方拿到的仍然是同一个会 reject 的 promise
        initPromise.catch(() => {
          initPromise = null;
        });
      }
      return initPromise;
    },
  };
}

/**
 * 自定义事务型 executor，仅用于单连接适配器（web / memory）。
 *
 * 为什么不能给 Tauri 用：@tauri-apps/plugin-sql 底层是 sqlx::Pool<Sqlite> 连接池，每次
 * execute() 调用独立获取/归还连接，不保证 BEGIN 和 COMMIT 落在同一条物理连接上，事务可能被
 * 悄悄拆散且不报错。createDbClient 靠 executor 上的 requiresSingleConnection 标记拒绝这种
 * 组合，但直接调用 runMigrations() 时不会有这层保护，调用方需自行确保只在单连接适配器上使用。
 */
const runTransactionalMigration: MigrationExecutor = async (db, migration, recordVersion) => {
  await db.execute("BEGIN;");
  try {
    await db.executeBatch(migration.statements);
    await recordVersion();
    await db.execute("COMMIT;");
  } catch (e) {
    await db.execute("ROLLBACK;").catch(() => {});
    throw e;
  }
};

// createDbClient 靠这个标记判断"这个 executor 需要单连接"，而不是靠函数引用是否等于
// defaultExecutor——后者只能拦住"自定义了非默认 executor"，拦不住"自定义了一个完全不涉及
// 事务的 executor（比如只加日志）"这种本来就安全、不该被拒绝的情况。
export const transactionalExecutor: MigrationExecutor = Object.assign(runTransactionalMigration, {
  requiresSingleConnection: true as const,
});
