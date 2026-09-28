import { create } from "zustand"

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
