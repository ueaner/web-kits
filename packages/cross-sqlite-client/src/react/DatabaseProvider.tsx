import React, { createContext, useEffect, useState } from "react"
import type { DbClient } from "../core/types"

export interface DatabaseContextType {
  dbClient: DbClient | null
  isDbReady: boolean
  isLoading: boolean
  dbError: Error | null
}

export const DatabaseContext = createContext<DatabaseContextType | undefined>(undefined)

export interface DatabaseProviderProps {
  /**
   * 由调用方负责创建（通常是 createDbClient(...) 的返回值）。DatabaseProvider 不再自己
   * 决定用哪个 adapter/迁移哪些 migrations——那是应用层的职责，见 README 里的 appDb 示例。
   *
   * 没有 retry：这个 Promise 只会 settle 一次，重试的语义交给调用方——想重试就在自己的状态
   * 里创建一个新的 client Promise，再把新引用传给这个 prop，effect 依赖 [client] 会自动
   * 重新走一遍下面的初始化逻辑。换 promise 的瞬间会先回到完全未就绪状态
   * （dbClient: null、isDbReady: false），新 promise resolve 之前消费方不会看到旧连接。
   *
   * DatabaseProvider 不拥有 client 的生命周期，卸载时也不会调用 client.close()：谁创建
   * 的 client 谁负责关闭。如果 close() 交给这里，而调用方（比如应用级单例的
   * getAppDbClient()）又缓存/复用同一个 client Promise，Provider 一旦被卸载再重新挂载
   * （条件渲染、测试环境、会重新 mount 的路由/key 边界……），第二次挂载就会解析到同一个
   * 已经被 close 过的 client——isDbReady 变成 true 但连接其实是死的。需要跟随组件生命周期
   * 关闭连接的调用方，应该在自己创建 client 的地方管理 close()，而不是依赖这里。
   */
  client: DbClient | Promise<DbClient>
  children: React.ReactNode
}

export const DatabaseProvider: React.FC<DatabaseProviderProps> = ({ client, children }) => {
  const [dbClient, setDbClient] = useState<DbClient | null>(null)
  const [isDbReady, setIsDbReady] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [dbError, setDbError] = useState<Error | null>(null)

  useEffect(() => {
    let cancelled = false
    // client prop 换了（比如重试）：先回到完全的未就绪状态——窗口期内不能把旧 client
    // 继续当作 isDbReady 暴露出去，否则消费方会把查询发到旧连接上
    setDbClient(null)
    setIsDbReady(false)
    setIsLoading(true)
    setDbError(null)

    Promise.resolve(client)
      .then((resolvedClient) => {
        if (cancelled) return
        setDbClient(resolvedClient)
        setIsDbReady(true)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        // error 不一定是 Error 实例（部分平台调用可能 reject 一个字符串或 DOMException）
        setDbError(error instanceof Error ? error : new Error(String(error)))
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [client])

  const value: DatabaseContextType = { dbClient, isDbReady, isLoading, dbError }

  return <DatabaseContext.Provider value={value}>{children}</DatabaseContext.Provider>
}
