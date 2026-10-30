import { useSyncExternalStore } from "react"

type SetState<T> = (partial: Partial<T> | ((state: T) => Partial<T>)) => void

// 演示用的最小 store：只提供 selector hook，选择器直接交给 useSyncExternalStore，
// 没有相等性比较。因此选择器只能返回 state 里已有的值（如 `(s) => s.entries`），
// 不能每次新建对象/数组（如 `(s) => ({ a: s.a })`、`(s) => s.entries.filter(...)`）——
// 那样每次取快照都不相等，React 会报错并无限重渲染。需要派生值时在组件里用 useMemo。
function create<T>(init: (set: SetState<T>) => T) {
  const listeners = new Set<() => void>()
  let state: T
  const set: SetState<T> = (partial) => {
    state = { ...state, ...(typeof partial === "function" ? partial(state) : partial) }
    for (const listener of listeners) listener()
  }
  state = init(set)
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  return <U>(select: (state: T) => U): U => useSyncExternalStore(subscribe, () => select(state))
}

export type FeedKind = "info" | "success" | "failure" | "error" | "check-error" | "leader" | "relay"

export interface FeedEntry {
  id: number
  time: string
  kind: FeedKind
  message: string
}

interface FeedState {
  entries: FeedEntry[]
  push: (kind: FeedKind, message: string) => void
  clear: () => void
}

let nextId = 1

export const useFeedStore = create<FeedState>((set) => ({
  entries: [],
  push: (kind, message) =>
    set((state) => ({
      entries: [{ id: nextId++, time: new Date().toLocaleTimeString("zh-CN", { hour12: false }), kind, message }, ...state.entries].slice(
        0,
        50,
      ),
    })),
  clear: () => set({ entries: [] }),
}))

export interface TickInfo {
  durationMs: number
  taskCount: number
}

interface StatusState {
  isLeader: boolean | null
  tickCount: number
  lastTick: TickInfo | null
  setLeader: (isLeader: boolean) => void
  recordTick: (info: TickInfo) => void
}

export const useStatusStore = create<StatusState>((set) => ({
  isLeader: null,
  tickCount: 0,
  lastTick: null,
  setLeader: (isLeader) => set({ isLeader }),
  recordTick: (info) => set((state) => ({ tickCount: state.tickCount + 1, lastTick: info })),
}))
