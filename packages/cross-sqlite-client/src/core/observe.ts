import type { DbClient, DbConnection, Logger } from "./types"

/**
 * 给连接装上写入通知（DbClient 的 onWrite / groupWrites，语义见 types.ts）。只由 createDbClient
 * 调用、不从包里导出：通知只有这一个来源，三个适配器都不用各自实现。装在适配器外层，所以 Tauri
 * 的 executeBatch 内部循环调用自己的 execute 时，一批只通知一次，和 web 一致。
 */
export function observe(connection: DbConnection, logger: Logger): DbClient {
  const listeners = new Set<() => void>()
  let groupDepth = 0
  // 有写入还没通知
  let pending = false
  // 已经排了一个微任务：同一个任务里的多次写入合并成一次通知
  let scheduled = false

  function flush() {
    scheduled = false
    if (!pending || groupDepth > 0) return
    pending = false
    // 拷贝一份再遍历：listener 里取消订阅（或新订阅）不影响这一轮
    for (const listener of Array.from(listeners)) {
      try {
        listener()
      } catch (error) {
        logger.error("[cross-sqlite-client] onWrite listener threw:", error)
      }
    }
  }

  function markWritten() {
    pending = true
    if (!scheduled && groupDepth === 0) {
      scheduled = true
      queueMicrotask(flush)
    }
  }

  // 同一个任务里发起的写入算一批，等这一批全部结束后才通知一次。只看"结束"的话，写入要等 IO 的
  // 适配器（web 的 worker 往返、miniprogram 的落盘）上，同一个任务里发起的几次写入会在不同时刻结束，各通知一次
  let taskBatch: Promise<unknown>[] | null = null

  function track(promise: Promise<unknown>) {
    if (!taskBatch) {
      const batch: Promise<unknown>[] = []
      taskBatch = batch
      // 这一批算作一层 groupWrites：期间的通知先攒着
      groupDepth++
      // 微任务里关窗：当前任务里同步发起的写入都已经进了这一批
      queueMicrotask(() => {
        taskBatch = null
        void Promise.allSettled(batch).then(() => {
          groupDepth--
          if (groupDepth === 0 && pending) markWritten()
        })
      })
    }
    taskBatch.push(promise)
  }

  // 成功和失败都算写入：executeBatch 没有事务，中途失败时前面的语句已经生效
  const write = <T>(promise: Promise<T>) => {
    const done = promise.finally(markWritten)
    track(done)
    return done
  }

  const client: DbClient = {
    // 转发 getter，不拷贝值：close() / 重开以后它会变
    get storage() {
      return connection.storage
    },
    select: (sql, params) => connection.select(sql, params),
    execute: (sql, params) => write(connection.execute(sql, params)),
    executeBatch: (statements) => write(connection.executeBatch(statements)),
    async close() {
      listeners.clear()
      pending = false
      await connection.close()
    },
    onWrite(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async groupWrites(fn) {
      groupDepth++
      try {
        return await fn()
      } finally {
        groupDepth--
        if (groupDepth === 0 && pending) markWritten()
      }
    },
  }
  return client
}
