import type { MiniProgramFileSystem } from "../../src/adapters/miniprogram-files"

type Operation = "mkdir" | "readFile" | "writeFile" | "rename" | "unlink" | "stat" | "readdir"

interface Fault {
  operation: Operation
  /** 只对路径匹配的调用生效（rename 看 oldPath） */
  path?: RegExp
  errMsg: string
}

/**
 * 内存里的小程序文件系统，行为对齐 wx.getFileSystemManager()：回调风格、失败时给 { errMsg }、
 * 回调异步触发。可以注入故障（failNext），统计各方法的调用次数（calls）。
 */
export interface FakeFileSystem extends MiniProgramFileSystem {
  files: Map<string, Uint8Array>
  calls: Record<Operation, number>
  /** 失败了的调用（"<方法> <路径>"），注入的故障也算：真机上宿主会把每次失败打到日志里 */
  failures: string[]
  /** 下一次匹配的调用失败 */
  failNext(operation: Operation, options?: { path?: RegExp; errMsg?: string }): void
  /** 当前目录下的文件名（按名字排序），方便断言 */
  list(directory: string): string[]
  /** 共享同一批文件的新实例：模拟进程被杀后重新启动（新进程里没有已打开的连接） */
  fork(): FakeFileSystem
}

export interface FakeFileSystemOptions {
  /** false：模拟没有 readdir 的宿主（默认有，和 wx.getFileSystemManager() 一样） */
  readdir?: boolean
}

export function createFakeFileSystem(
  shared?: { files: Map<string, Uint8Array>; dirs: Set<string> },
  options: FakeFileSystemOptions = {},
): FakeFileSystem {
  const files = shared?.files ?? new Map<string, Uint8Array>()
  const dirs = shared?.dirs ?? new Set<string>()
  const faults: Fault[] = []
  const calls: Record<Operation, number> = { mkdir: 0, readFile: 0, writeFile: 0, rename: 0, unlink: 0, stat: 0, readdir: 0 }
  const failures: string[] = []

  const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"))

  function run<T>(
    operation: Operation,
    path: string,
    cb: { success: (r: T) => void; fail: (e: { errMsg: string }) => void },
    body: () => T,
  ) {
    calls[operation] += 1
    const index = faults.findIndex((f) => f.operation === operation && (!f.path || f.path.test(path)))
    queueMicrotask(() => {
      if (index >= 0) {
        const [fault] = faults.splice(index, 1)
        failures.push(`${operation} ${path}`)
        cb.fail({ errMsg: `${operation}:fail ${fault!.errMsg}` })
        return
      }
      let result: T
      try {
        result = body()
      } catch (error) {
        failures.push(`${operation} ${path}`)
        cb.fail({ errMsg: `${operation}:fail ${(error as Error).message}` })
        return
      }
      cb.success(result)
    })
  }

  const requireParent = (path: string) => {
    if (!dirs.has(parentOf(path))) throw new Error(`no such file or directory "${parentOf(path)}"`)
  }

  const readdir: Pick<MiniProgramFileSystem, "readdir"> =
    options.readdir === false
      ? {}
      : {
          readdir({ dirPath, success, fail }) {
            run("readdir", dirPath, { success, fail }, () => {
              if (!dirs.has(dirPath)) throw new Error(`no such file or directory "${dirPath}"`)
              const files = [...filesIn(dirPath)]
              return { files }
            })
          },
        }
  function* filesIn(directory: string) {
    for (const p of files.keys()) if (parentOf(p) === directory) yield p.slice(directory.length + 1)
  }

  return {
    files,
    calls,
    failures,
    ...readdir,
    fork() {
      return createFakeFileSystem({ files, dirs }, options)
    },
    failNext(operation, options = {}) {
      faults.push({ operation, path: options.path, errMsg: options.errMsg ?? "injected failure" })
    },
    list(directory) {
      return [...filesIn(directory)].sort()
    },
    mkdir({ dirPath, success, fail }) {
      run("mkdir", dirPath, { success, fail }, () => {
        if (dirs.has(dirPath)) throw new Error("file already exists")
        // recursive：把各级父目录都建上
        for (let p = dirPath; p; p = parentOf(p)) dirs.add(p)
      })
    },
    readFile({ filePath, success, fail }) {
      run("readFile", filePath, { success, fail }, () => {
        const data = files.get(filePath)
        if (!data) throw new Error(`no such file or directory "${filePath}"`)
        return { data: data.slice().buffer }
      })
    },
    writeFile({ filePath, data, success, fail }) {
      run("writeFile", filePath, { success, fail }, () => {
        requireParent(filePath)
        files.set(filePath, new Uint8Array(data.slice(0)))
      })
    },
    rename({ oldPath, newPath, success, fail }) {
      run("rename", oldPath, { success, fail }, () => {
        const data = files.get(oldPath)
        if (!data) throw new Error(`no such file or directory "${oldPath}"`)
        files.delete(oldPath)
        files.set(newPath, data)
      })
    },
    unlink({ filePath, success, fail }) {
      run("unlink", filePath, { success, fail }, () => {
        if (!files.delete(filePath)) throw new Error(`no such file or directory "${filePath}"`)
      })
    },
    stat({ path, success, fail }) {
      run("stat", path, { success, fail }, () => {
        const data = files.get(path)
        if (!data) throw new Error(`no such file or directory "${path}"`)
        return { stats: { size: data.byteLength } }
      })
    },
  }
}
