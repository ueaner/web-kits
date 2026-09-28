import type { PendingTaskCheckResult } from "pending-task-kit"

// 假后端的任务状态直接存 localStorage（而不是模块级 Map），这样两个标签页看到同一份
// 进度——否则每个 tab 各自推进度，跨 tab 演示就对不上了。
const BACKEND_KEY = "ptk-demo:backend"

interface BackendJob {
  type: string
  percent: number
  checkCount: number
  failures: number
  successes: number
  // 终态结果保留在后端，而不是立刻删掉 job：关闭选主时两个 tab 会并发 check 同一任务，
  // 后到的一方要读到同一个终态，否则会拿到"任务不存在"的 failure 去抢 claimResultOnce。
  // 由 TaskList 的删除 / 清空操作负责清理。
  result?: PendingTaskCheckResult
}

function readJobs(): Record<string, BackendJob> {
  try {
    const raw = localStorage.getItem(BACKEND_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, BackendJob>) : {}
  } catch {
    return {}
  }
}

function writeJobs(jobs: Record<string, BackendJob>): void {
  try {
    localStorage.setItem(BACKEND_KEY, JSON.stringify(jobs))
  } catch {
    // 演示用假后端，写不进去就丢掉
  }
}

export function startBackendJob(taskId: string, type: string): void {
  const jobs = readJobs()
  jobs[taskId] = { type, percent: 0, checkCount: 0, failures: 0, successes: 0 }
  writeJobs(jobs)
}

export function removeBackendJob(taskId: string): void {
  const jobs = readJobs()
  delete jobs[taskId]
  writeJobs(jobs)
}

export function clearBackendJobs(): void {
  try {
    localStorage.removeItem(BACKEND_KEY)
  } catch {
    // 同上
  }
}

function networkDelay(signal: AbortSignal): Promise<void> {
  const ms = 300 + Math.random() * 400
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("check aborted", "AbortError"))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException("check aborted", "AbortError"))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function settle(jobs: Record<string, BackendJob>, job: BackendJob, result: PendingTaskCheckResult): PendingTaskCheckResult {
  job.result = result
  writeJobs(jobs)
  return result
}

function missingJobResult(taskId: string): PendingTaskCheckResult {
  return { status: "failure", data: { reason: `后端不存在任务 ${taskId.slice(0, 8)}（可能已被清理）` } }
}

export async function checkAiReport(taskId: string, signal: AbortSignal): Promise<PendingTaskCheckResult> {
  await networkDelay(signal)
  const jobs = readJobs()
  const job = jobs[taskId]
  if (!job) return missingJobResult(taskId)
  if (job.result) return job.result
  job.checkCount += 1
  job.percent = Math.min(100, job.percent + 12 + Math.round(Math.random() * 13))
  if (job.percent >= 100) {
    return settle(jobs, job, { status: "success", data: { url: `https://example.com/reports/${taskId.slice(0, 8)}.pdf` } })
  }
  writeJobs(jobs)
  return { status: "pending", progress: { percent: job.percent } }
}

export async function checkFlakyImport(taskId: string, signal: AbortSignal): Promise<PendingTaskCheckResult> {
  await networkDelay(signal)
  const jobs = readJobs()
  const job = jobs[taskId]
  if (!job) return missingJobResult(taskId)
  if (job.result) return job.result
  job.checkCount += 1
  if (Math.random() < 0.5) {
    job.failures += 1
    if (job.failures >= 3) {
      return settle(jobs, job, { status: "failure", data: { reason: `第 ${job.failures} 次失败，判定导入失败` } })
    }
    writeJobs(jobs)
    throw new Error(`模拟网络抖动（第 ${job.failures} 次）`)
  }
  job.successes += 1
  job.percent = Math.min(99, job.successes * 25)
  if (job.successes >= 4) {
    return settle(jobs, job, { status: "success", data: { imported: 128 } })
  }
  writeJobs(jobs)
  return { status: "pending", progress: { percent: job.percent } }
}

export async function checkQuietBackup(taskId: string, signal: AbortSignal): Promise<PendingTaskCheckResult> {
  await networkDelay(signal)
  const jobs = readJobs()
  const job = jobs[taskId]
  if (!job) return missingJobResult(taskId)
  if (job.result) return job.result
  job.checkCount += 1
  job.percent = Math.min(100, job.checkCount * 40)
  if (job.checkCount >= 3) {
    return settle(jobs, job, { status: "success", data: { message: "备份已完成" } })
  }
  writeJobs(jobs)
  return { status: "pending", progress: { percent: job.percent } }
}
