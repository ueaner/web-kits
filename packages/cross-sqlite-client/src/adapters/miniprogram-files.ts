import type { Logger } from "../core/types"

/** 宿主回调失败时给的错误对象（wx 是 { errMsg }） */
interface HostError {
  errMsg?: string
}

interface Callbacks<T = void> {
  success: (result: T) => void
  fail: (error: HostError) => void
}

/**
 * 适配器用到的宿主文件系统方法（回调风格），和 wx.getFileSystemManager() / Taro.getFileSystemManager() 一致。
 * 只列出用到的部分，测试里可以直接给一个内存实现。
 */
export interface MiniProgramFileSystem {
  mkdir(options: { dirPath: string; recursive?: boolean } & Callbacks): void
  readFile(options: { filePath: string } & Callbacks<{ data: ArrayBuffer | string }>): void
  writeFile(options: { filePath: string; data: ArrayBuffer } & Callbacks): void
  rename(options: { oldPath: string; newPath: string } & Callbacks): void
  unlink(options: { filePath: string } & Callbacks): void
  stat(options: { path: string } & Callbacks<{ stats: { size: number } }>): void
  /**
   * 可选：列出目录里的文件名。有它时打开数据库先列一次目录：目录已经在就不 mkdir，没有残留的 .tmp 就不去删——
   * 宿主（微信）会把每次失败的文件调用打到日志里，即使失败在预料之中（"unlink:fail no such file or directory …"），
   * 原来每次启动都有这两条。没有时照常调用，再忽略"不存在""已存在"的失败
   */
  readdir?(options: { dirPath: string } & Callbacks<{ files: string[] }>): void
}

const REQUIRED_METHODS = ["mkdir", "readFile", "writeFile", "rename", "unlink", "stat"] as const

/** fs 缺方法时返回缺的方法名，齐全时返回空数组 */
export function missingFileSystemMethods(fs: unknown): string[] {
  if (!fs || typeof fs !== "object") return [...REQUIRED_METHODS]
  return REQUIRED_METHODS.filter((m) => typeof (fs as Record<string, unknown>)[m] !== "function")
}

/** 文件名只允许字母、数字、点、下划线、连字符：name 会直接拼进路径 */
const NAME_RE = /^[A-Za-z0-9_.-]+$/

/** SQLite 数据库文件的前 16 字节 */
const SQLITE_HEADER = "SQLite format 3\0"

export function hasSqliteHeader(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 100) return false // 文件头本身就有 100 字节
  for (let i = 0; i < SQLITE_HEADER.length; i++) {
    if (bytes[i] !== SQLITE_HEADER.charCodeAt(i)) return false
  }
  return true
}

function isMissing(error: unknown): boolean {
  const message = (error as HostError | undefined)?.errMsg ?? String(error)
  return /no such file|not exist|not found|ENOENT/i.test(message)
}

function isAlreadyExists(error: unknown): boolean {
  const message = (error as HostError | undefined)?.errMsg ?? String(error)
  return /already exist|EEXIST/i.test(message)
}

/** 宿主的 fail 回调给的是 { errMsg } 这类裸对象，包成 Error 以便带上调用栈和统一的 message */
function hostError(operation: string, error: HostError): Error {
  return new Error(`[MiniProgram DB] ${operation} failed: ${error?.errMsg ?? String(error)}`, { cause: error })
}

/** 一次打开时用了哪个文件 */
export type SnapshotOrigin =
  /** 没有任何文件：新库 */
  | "new"
  /** 当前文件完好 */
  | "current"
  /** 当前文件损坏或缺失，用了上一个完好版本（.bak） */
  | "backup"
  /** 有文件但都损坏：坏文件已挪开，打开的是新库 */
  | "reset"

export interface SnapshotFiles {
  /**
   * 读出数据库：依次尝试当前文件和 .bak，第一个能被 tryOpen 打开的就用它（tryOpen 返回 undefined 表示这个快照不可用）。
   * tryOpen 抛错（内存不足这类和文件无关的失败）时 load 原样抛出，文件一个都不动。
   * 损坏的文件挪成 .corrupt-<时间>，从不删除；用 .bak 时会把它的内容写回当前文件。
   * 打开之后的这些文件操作失败时，用 dispose 释放已经打开的 value 再抛错。
   */
  load<T>(
    tryOpen: (bytes: Uint8Array) => T | undefined,
    dispose: (value: T) => void,
  ): Promise<{ value: T | undefined; origin: SnapshotOrigin }>
  /** 原子地保存一份快照：写 .tmp → 当前文件改名为 .bak → .tmp 改名为当前文件。.bak 留着，是上一个完好版本 */
  save(bytes: Uint8Array): Promise<void>
}

/**
 * 数据库文件的布局：
 *   <directory>/<name>.sqlite                当前数据库
 *   <directory>/<name>.sqlite.bak            上一个完好版本（一直保留）
 *   <directory>/<name>.sqlite.tmp            正在写的新快照
 *   <directory>/<name>.sqlite.corrupt-<时间>  打开时发现损坏、被挪开的文件（永不删除）
 *
 * 为什么一直保留 .bak、打开时还要校验：小程序文件系统没有 fsync，掉电或系统崩溃时可能出现
 * "改名生效了、新文件内容没写完"，只靠"临时文件 + 改名"保证不了原子性。
 */
export function createSnapshotFiles(fs: MiniProgramFileSystem, directory: string, name: string, logger: Logger): SnapshotFiles {
  if (!NAME_RE.test(name)) {
    throw new Error(`[MiniProgram DB] Database name may only contain letters, digits, ".", "_" and "-", got ${JSON.stringify(name)}.`)
  }
  const dir = directory.replace(/\/+$/, "")
  const current = `${dir}/${name}.sqlite`
  const backup = `${current}.bak`
  const temporary = `${current}.tmp`

  const call = <T = void>(operation: string, run: (callbacks: Callbacks<T>) => void): Promise<T> =>
    new Promise<T>((resolve, reject) => run({ success: resolve, fail: (error) => reject(hostError(operation, error)) }))

  const readIfPresent = async (filePath: string): Promise<Uint8Array | undefined> => {
    try {
      const { data } = await call<{ data: ArrayBuffer | string }>(`readFile ${filePath}`, (cb) => fs.readFile({ filePath, ...cb }))
      if (typeof data === "string") throw new Error(`[MiniProgram DB] readFile ${filePath} returned text, expected binary`)
      return new Uint8Array(data)
    } catch (error) {
      if (isMissing((error as Error).cause)) return undefined
      throw error
    }
  }

  const removeIfPresent = async (filePath: string): Promise<void> => {
    try {
      await call(`unlink ${filePath}`, (cb) => fs.unlink({ filePath, ...cb }))
    } catch (error) {
      if (!isMissing((error as Error).cause)) throw error
    }
  }

  const rename = (oldPath: string, newPath: string) => call(`rename ${oldPath}`, (cb) => fs.rename({ oldPath, newPath, ...cb }))

  // 拷贝成独立的 ArrayBuffer：bytes 可能是更大 buffer 上的一个视图
  const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer

  const write = (filePath: string, bytes: Uint8Array) =>
    call(`writeFile ${filePath}`, (cb) => fs.writeFile({ filePath, data: toArrayBuffer(bytes), ...cb }))

  const makeDirectory = () =>
    call(`mkdir ${dir}`, (cb) => fs.mkdir({ dirPath: dir, recursive: true, ...cb })).catch((error) => {
      if (!isAlreadyExists((error as Error).cause)) throw error
    })

  /**
   * 打开时目录里有没有 .tmp：true / false 是 readdir 列出来的，null 是不知道（宿主没有 readdir，或者列目录失败）。
   * 列目录只用来跳过"判断错了也无害"的调用：目录在就不 mkdir；没有 .tmp 就不去删它（真有的话，下次保存照样覆盖它）。
   * 读当前文件和 .bak、保存时的轮换照常调用，不看列表——列表万一不准（某个宿主的 readdir 有怪癖），后果只是宿主日志里
   * 多一行失败，不会把已有的库当成新库、跳过备份。这两类调用注定失败的情况只在第一次安装、第一次保存时各出现一次
   */
  let temporaryListed: boolean | null = null

  /** 列目录：readdir 成功说明目录在，不再 mkdir；没有 readdir 或失败（第一次打开时目录还不存在）就照老办法 mkdir */
  const listDirectory = async (): Promise<void> => {
    const readdir = fs.readdir
    if (typeof readdir === "function") {
      try {
        const { files } = await call<{ files: unknown }>(`readdir ${dir}`, (cb) => readdir.call(fs, { dirPath: dir, ...cb }))
        temporaryListed = Array.isArray(files) ? files.includes(temporary.slice(dir.length + 1)) : null
        return
      } catch (error) {
        // 照老办法建目录。目录不存在（第一次打开）的话刚建的目录里不会有 .tmp；判断错了也只是留着一个下次保存会覆盖的 .tmp
        if (isMissing((error as Error).cause)) temporaryListed = false
      }
    }
    await makeDirectory()
  }

  let directoryReady: Promise<void> | null = null
  const ensureDirectory = (): Promise<void> => {
    directoryReady ??= listDirectory().catch((error: unknown) => {
      directoryReady = null
      throw error
    })
    return directoryReady
  }

  /** 挪开一个损坏的文件；同一毫秒里挪两个文件（当前文件和 .bak）时用 suffix 区分 */
  const moveAside = async (filePath: string, suffix = ""): Promise<string> => {
    const target = `${filePath.replace(/\.bak$/, "")}.corrupt-${Date.now()}${suffix}`
    await rename(filePath, target)
    return target
  }

  return {
    async load<T>(tryOpen: (bytes: Uint8Array) => T | undefined, dispose: (value: T) => void) {
      await ensureDirectory()
      // .tmp 没有完成替换（保存时在改名之前被打断），里面的写入当时也没有返回成功，直接丢掉
      if (temporaryListed !== false) await removeIfPresent(temporary)

      const currentBytes = await readIfPresent(current)
      if (currentBytes) {
        const value = tryOpen(currentBytes)
        if (value !== undefined) return { value, origin: "current" as const }
      }

      const backupBytes = await readIfPresent(backup)
      if (backupBytes) {
        const value = tryOpen(backupBytes)
        if (value !== undefined) {
          try {
            if (currentBytes) {
              const movedTo = await moveAside(current)
              logger.error(
                `[MiniProgram DB] ${current} is corrupt; restored the previous version from ${backup} (corrupt file kept at ${movedTo}).`,
              )
            } else {
              // 保存时在"当前文件改名为 .bak"和".tmp 改名为当前文件"之间被打断：不是损坏，但同样要从 .bak 恢复
              logger.warn(`[MiniProgram DB] ${current} is missing; restored the previous version from ${backup}.`)
            }
            await write(current, backupBytes)
          } catch (error) {
            dispose(value)
            throw error
          }
          return { value, origin: "backup" as const }
        }
      }

      if (!currentBytes && !backupBytes) return { value: undefined, origin: "new" as const }

      // 有文件但都打不开：挪开（不删除，数据还能手动找回），打开一个新库，不让应用永远打不开
      const moved: string[] = []
      if (currentBytes) moved.push(await moveAside(current))
      if (backupBytes) moved.push(await moveAside(backup, "-bak"))
      logger.error(
        `[MiniProgram DB] ${current} and its backup are corrupt; starting a new database (corrupt files kept at ${moved.join(", ")}).`,
      )
      return { value: undefined, origin: "reset" as const }
    },

    async save(bytes: Uint8Array) {
      await ensureDirectory()
      await write(temporary, bytes)
      try {
        const { stats } = await call<{ stats: { size: number } }>(`stat ${temporary}`, (cb) => fs.stat({ path: temporary, ...cb }))
        if (stats.size !== bytes.byteLength) {
          throw new Error(`[MiniProgram DB] ${temporary} has ${stats.size} bytes after writing ${bytes.byteLength}`)
        }
        // 不依赖 rename 能覆盖已有文件（各平台没有文档保证），先把旧 .bak 删掉
        await removeIfPresent(backup)
        try {
          await rename(current, backup)
        } catch (error) {
          // 第一次保存时还没有当前文件
          if (!isMissing((error as Error).cause)) throw error
        }
        await rename(temporary, current)
      } catch (error) {
        await removeIfPresent(temporary).catch(() => {})
        throw error
      }
    },
  }
}
