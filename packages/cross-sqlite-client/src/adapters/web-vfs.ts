/**
 * Web 适配器用哪个 OPFS VFS、让 sqlite-wasm 跳过安装哪些（内部模块，不在包的 exports 里）。
 *
 * sqlite-wasm 的 Worker 启动时会安装它内置的 OPFS 类 VFS（"opfs"、"opfs-wl"），每个都起一个 OPFS 代理 Worker 并等它握手，
 * 超时 4 秒，全部装完才报告就绪。代理自己拿 OPFS 失败时（Safari 无痕窗口、Playwright 的 WebKit：getDirectory() 抛
 * UnknownError）只打日志、不通知 Worker（sqlite3-opfs-async-proxy.js 里 "error initializing OPFS asyncer" 的 catch），
 * Worker 就白等到超时：适配器早就决定开 :memory: 了，页面还要多等约 8 秒。
 *
 * 安装不等于使用：sqlite 只用 open 时点名的 VFS。所以只装要用的那个：内存模式一个都不装，OPFS 模式只装 OPFS_VFS。
 * 跳过的办法是 sqlite-wasm 在 Worker 里读的 URL 参数 "<vfs>-disable"（源码注释称 officially undocumented）；参数失效时
 * 行为退回原样（多等几秒），打开的文件和 VFS 不变。
 */

/** 打开数据库用的 VFS：`file:<name>.db?vfs=<OPFS_VFS>`。只在这里决定 */
export const OPFS_VFS = "opfs"

/**
 * sqlite-wasm 的 Worker 启动时会尝试安装、带 "-disable" 开关的 OPFS 类 VFS。测试从安装的 sqlite-wasm 产物里核对这张表，
 * 升级 sqlite-wasm 多了、少了或改名时失败（test/web-vfs.test.ts）
 */
export const OPFS_VFSES = ["opfs", "opfs-wl"] as const

/** Worker URL 上要带的参数：打开内存库时跳过全部 OPFS VFS，打开 OPFS 文件时跳过 OPFS_VFS 以外的 */
export function disableVfsParams(memory: boolean): string[] {
  return OPFS_VFSES.filter((vfs) => memory || vfs !== OPFS_VFS).map((vfs) => `${vfs}-disable`)
}

/**
 * 调用 create()（sqlite-wasm 自己的 Worker 工厂），并给它 new 出来的 Worker 的 URL 追加 params。
 *
 * URL 必须由 sqlite-wasm 的模块自己解析（new URL("sqlite3-worker1.mjs", import.meta.url)，在这里重写会因打包后路径不同而
 * 404），所以不改 URL 本身，而是在调用工厂的那一刻把全局 Worker 换成一个追加参数的子类，调用后立即还原。调用是同步的，
 * 不会和别的代码交错。工厂在调用时读全局 Worker（Vite 的产物里是 new Worker(e.toString())）才有效；读不到时（别的打包
 * 方式提前绑定了 Worker）参数加不上，行为退回原样。
 */
export function createWorkerWithParams(create: () => Worker, params: readonly string[]): Worker {
  const Original = globalThis.Worker
  if (params.length === 0 || typeof Original !== "function") return create()
  class WorkerWithParams extends Original {
    constructor(scriptURL: string | URL, options?: WorkerOptions) {
      const url = new URL(scriptURL, globalThis.location?.href)
      for (const param of params) url.searchParams.set(param, "")
      super(url, options)
    }
  }
  globalThis.Worker = WorkerWithParams
  try {
    return create()
  } finally {
    globalThis.Worker = Original
  }
}
