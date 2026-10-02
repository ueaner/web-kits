import { createContext, use, type ReactNode } from "react"
import type { DbClient } from "../core/types"

const DbClientContext = createContext<Promise<DbClient> | null>(null)

export interface DatabaseProviderProps {
  /**
   * 通常是 createDbClient(...) 的返回值。已经就绪的 client 用 Promise.resolve(client) 传进来。
   *
   * 没有 retry：想重试就在自己的状态里创建一个新的 client Promise 传进来，同时换掉包住它的错误边界的
   * key（不然错误边界还停在出错状态）。
   *
   * 不拥有 client 的生命周期，卸载时也不会调用 client.close()：谁创建的 client 谁负责关闭。
   * 如果交给这里关闭，而调用方又缓存、复用同一个 client Promise（比如应用级单例），Provider 一旦被
   * 卸载再重新挂载（条件渲染、测试、会重新挂载的路由），第二次拿到的就是一个已经关闭的 client。
   */
  client: Promise<DbClient>
  children: ReactNode
}

export function DatabaseProvider({ client, children }: DatabaseProviderProps) {
  return <DbClientContext value={client}>{children}</DbClientContext>
}

/**
 * 读取 DatabaseProvider 的 client。数据库还没就绪时挂起，由最近的 <Suspense> 显示加载状态；
 * 初始化失败时把错误（包括 DbTabLockError）抛给最近的错误边界。
 */
export function useDbClient(): DbClient {
  const promise = use(DbClientContext)
  if (!promise) {
    throw new Error("useDbClient must be used within a DatabaseProvider")
  }
  return use(promise)
}
