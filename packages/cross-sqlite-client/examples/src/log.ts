import { useSyncExternalStore } from "react"

export type LogLevel = "info" | "warn" | "error"

export interface LogEntry {
  id: number
  time: string
  level: LogLevel
  message: string
}

const MAX_ENTRIES = 50

let entries: LogEntry[] = []
let nextId = 1
const listeners = new Set<() => void>()

export function appendLog(level: LogLevel, message: string): void {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false })
  entries = [{ id: nextId++, time, level, message }, ...entries].slice(0, MAX_ENTRIES)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): LogEntry[] {
  return entries
}

export function useLogEntries(): LogEntry[] {
  return useSyncExternalStore(subscribe, getSnapshot)
}
