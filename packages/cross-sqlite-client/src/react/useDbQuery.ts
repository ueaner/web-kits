import { startTransition, use, useEffect, useState } from "react"
import type { DbClient } from "../core/types"
import { useDbClient } from "./DatabaseProvider"

/**
 * 每个 client 一份查询缓存：key → 查询的 promise。
 *
 * 为什么必须缓存在组件外面：组件第一次挂载就挂起时，React 会丢掉它的 state，等 promise 结束后从头再渲染。
 * promise 存在 useState 里的话，重渲染又会新建一个，于是一直挂起、反复查询。所以 promise 要放在一个
 * 比组件活得久的地方，再用调用方给的 key 找回来。
 *
 * 每次写入都清空整个缓存（写入通知不说明写了哪张表，见 DbClient.onWrite），所以缓存最多只留到下一次写入。
 * 两次写入之间用过的不同 key 会一直留着，量很小，不另外清理。
 *
 * 一个可以接受的窄窗口：写入清空缓存以后、重新查询的 transition 提交之前，组件如果因为别的原因被同步地
 * 重新渲染（一次不在 transition 里的 setState），会碰上缓存未命中，挂起到 fallback，而不是继续显示旧数据。
 * 这段时间只有一次本地查询那么长。
 */
interface CacheEntry {
  promise: Promise<unknown>
  failed: boolean
}

interface QueryCache {
  entries: Map<string, CacheEntry>
}

const caches = new WeakMap<DbClient, QueryCache>()

function cacheFor(client: DbClient): QueryCache {
  let cache = caches.get(client)
  if (!cache) {
    const created: QueryCache = { entries: new Map() }
    // 第一次用到这个 client 时就订阅（发生在渲染期间，早于任何组件 effect 里的订阅），
    // 所以写入以后，缓存总是在组件重新渲染之前就已经清空
    client.onWrite(() => created.entries.clear())
    caches.set(client, created)
    cache = created
  }
  return cache
}

/**
 * 失败的查询要从缓存里删掉，错误边界重试时才会重新查询；但不能一失败就删。React 在 promise 结束后会重新
 * 渲染组件来读结果，出错时还会再同步重试几次渲染来确认，这些渲染都必须读到同一个失败的 promise——那时
 * 已经删掉的话，每次都会新开一个查询（实测一次失败查了 4 次）。所以等到失败的 promise 被读到（错误已经
 * 抛给错误边界）以后，在下一个宏任务里再删：这几次同步的重试都在同一个任务里，而用户点"重试"一定在之后。
 */
function forgetLater(cache: QueryCache, id: string, entry: CacheEntry) {
  setTimeout(() => {
    if (cache.entries.get(id) === entry) cache.entries.delete(id)
  })
}

/**
 * 读一次查询的结果。没出结果时挂起，由最近的 <Suspense> 显示加载状态；出错时把错误抛给最近的错误边界。
 *
 * - key 用来在缓存里找到这次查询，要能 JSON 序列化，而且要包含 run 用到的所有变量
 *   （["notes", { limit }]）。key 一样，就认为是同一个查询、结果一样。
 * - 每次写入以后，在 startTransition 里重新查询：新结果出来之前继续显示旧数据，不会退回 fallback；
 *   连着几次写入，只会显示最后一次的结果。
 * - key 变化是调用方发起的普通更新，会挂起到 fallback。想保留旧数据（比如分页），把引起 key 变化的
 *   setState 包在 startTransition 里。
 * - 出错时错误抛给最近的错误边界；错误边界重试（重新挂载）时会重新查询。
 *
 * 不做缓存过期、重试、分页这些：需要的话用 TanStack Query，把 client.onWrite 接到 invalidateQueries。
 */
export function useDbQuery<T>(key: readonly unknown[], run: (db: DbClient) => Promise<T>): T {
  const client = useDbClient()
  const cache = cacheFor(client)
  const [, rerender] = useState(0)

  useEffect(() => client.onWrite(() => startTransition(() => rerender((n) => n + 1))), [client])

  const id = JSON.stringify(key)
  let entry = cache.entries.get(id)
  if (!entry) {
    const created: CacheEntry = { promise: run(client), failed: false }
    // 记下失败，供 forgetLater 用；同时让被下一次写入替换掉、没人再读的 promise 失败时不报 unhandled rejection。
    // use() 读的是原来的 promise，照样拿得到错误
    created.promise.catch(() => {
      created.failed = true
    })
    cache.entries.set(id, created)
    entry = created
  }
  if (entry.failed) forgetLater(cache, id, entry)
  return use(entry.promise as Promise<T>)
}
