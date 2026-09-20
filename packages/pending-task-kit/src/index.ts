export type {
  PendingTask,
  PendingTaskCheckResult,
  PendingTaskHandler,
  PendingTaskLogger,
  PendingTaskMetadata,
  PendingTaskRegistry,
  PendingTaskResultEventDetail,
  PendingTaskResultStatus,
  PendingTaskStatus,
} from "./types"

export {
  createPendingTaskStore,
  isPendingTaskShape,
  parseTasksFromStorageValue,
  DEFAULT_STORAGE_KEY,
  DEFAULT_TASK_LIST_WARN_THRESHOLD,
  DEFAULT_TTL_MS,
} from "./store"
export type { CreatePendingTaskStoreOptions, PendingTaskStore, PendingTaskStoreState } from "./store"

export { createPendingTaskRegistryBinding } from "./registry"

export {
  PendingTaskPoller,
  DEFAULT_MAX_FAILURE_COUNT,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_LEASE_TTL_MULTIPLIER,
  DEFAULT_POLL_TICK_MS,
  DEFAULT_RESULT_EVENT,
} from "./engine"
export type { PendingTaskPollerOptions } from "./engine"

// tab-lock/ttl-dedupe-cache/poll-lease/safe-storage used to live in this package (as
// src/tab-lock.ts etc.) — none of them had a real dependency on the "task" domain, so they now
// live in cross-tab-kit instead, which this package depends on for its own internal use
// (engine.ts/store.ts/result-relay.ts). Deliberately NOT re-exported here — see README's
// "Cross-tab poll-leader election"/"Cross-tab duplicate-toast dedupe" sections, updated to
// import these directly from `cross-tab-kit` instead. This is a breaking change from 0.3.0 and
// earlier, where these were re-exported from this package.
export { clearResultRelay, parseResultRelay, writeResultRelay } from "./result-relay"
