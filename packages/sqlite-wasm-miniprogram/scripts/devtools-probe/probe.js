// 探针页面的逻辑：在小程序里跑 sqlite-wasm-miniprogram + cross-sqlite-client 的 miniprogram 适配器。
// scripts/devtools-probe.mjs 用 esbuild 把它打成 CJS 放进生成的小程序里，页面 require 后调用 runProbe()。
/* global wx, WXWebAssembly */
import { createDbClient, transactionalExecutor } from "cross-sqlite-client"
import { createMiniProgramAdapter } from "cross-sqlite-client/adapters/miniprogram"
import { initSqlite3 } from "../../dist/index.js"

const MIGRATIONS = [
  { version: 1, statements: ["CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL, key TEXT UNIQUE)"] },
  { version: 2, statements: ["CREATE TABLE launches (id INTEGER PRIMARY KEY, at INTEGER NOT NULL)"] },
]

function call(fs, method, options) {
  return new Promise((resolve, reject) => fs[method]({ ...options, success: resolve, fail: reject }))
}

// 页面每次加载都跑一次探针：小程序启动时一次，automator 的 reLaunch 又一次。两次在同一个进程里，
// 同一个数据库文件只能打开一次（适配器会拒绝），所以排队，等上一次关闭以后再开始
let previousRun = Promise.resolve()

export function runProbe(log) {
  const run = previousRun.then(() => probe(log))
  previousRun = run.catch(() => {})
  return run
}

async function probe(log) {
  const check = (id, ok, detail) => log({ id, ok: Boolean(ok), detail: String(detail) })
  const fs = wx.getFileSystemManager()
  const device = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync()
  check("device", true, `${device.platform} ${device.system} ${device.model} SDK ${wx.getAppBaseInfo().SDKVersion}`)
  check("env", typeof WXWebAssembly !== "undefined", `WXWebAssembly=${typeof WXWebAssembly} TextDecoder=${typeof TextDecoder}`)

  let t = Date.now()
  const sqlite3 = await initSqlite3({ webAssembly: WXWebAssembly, assetsDir: "/sqlite", wasmFile: "br" })
  check("engine", true, `SQLite ${sqlite3.capi.sqlite3_libversion()} from sqlite3.wasm.br in ${Date.now() - t} ms`)

  // 固定目录：每次启动都在同一个库里记一条，杀进程后重新打开能看到上一次的记录
  const directory = `${wx.env.USER_DATA_PATH}/sqlite-probe`
  const adapter = createMiniProgramAdapter({
    sqlite3: async () => sqlite3,
    fs,
    directory,
    logger: { warn: (...a) => check("warn", true, a.join(" ")), error: (...a) => check("error", false, a.join(" ")) },
  })
  t = Date.now()
  const client = await createDbClient({
    name: "probe",
    adapter,
    migrations: MIGRATIONS,
    migrationOptions: { executor: transactionalExecutor },
  })
  check("open", client.storage.persistent, `opened and migrated in ${Date.now() - t} ms`)

  const previous = await client.select("SELECT COUNT(*) AS n, MAX(at) AS last FROM launches")
  const { n, last } = previous[0]
  check(
    "previous-launches",
    true,
    n
      ? `${n} earlier launch(es), last at ${new Date(last).toLocaleString()} — data survived restart`
      : "first launch (kill and reopen the mini program to check persistence)",
  )
  t = Date.now()
  await client.execute("INSERT INTO launches (at) VALUES (?)", [Date.now()])
  check("write", true, `one INSERT persisted in ${Date.now() - t} ms`)

  const key = `k-${Date.now()}`
  const first = await client.execute("INSERT INTO items (label, key) SELECT ?, ? WHERE true ON CONFLICT (key) DO NOTHING", ["a", key])
  const again = await client.execute("INSERT INTO items (label, key) SELECT ?, ? WHERE true ON CONFLICT (key) DO NOTHING", ["a", key])
  check("dedupe", first.rowsAffected === 1 && again.rowsAffected === 0, `rowsAffected ${first.rowsAffected} then ${again.rowsAffected}`)

  const [subsec] = await client.select("SELECT cast(strftime('%s','subsec') * 1000 as int) AS ms")
  check("subsec", Math.abs(subsec.ms - Date.now()) < 60_000, `strftime('%s','subsec') = ${subsec.ms}`)

  t = Date.now()
  await client.execute("BEGIN")
  for (let i = 0; i < 3000; i++) await client.execute("INSERT INTO items (label) VALUES (?)", [`row-${i}`])
  await client.execute("COMMIT")
  const [{ size }] = await client.select("SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()")
  check("bulk", true, `3000 rows in one transaction, saved once: ${Date.now() - t} ms, database ${Math.round(size / 1024)} KB`)
  t = Date.now()
  await client.execute("INSERT INTO items (label) VALUES ('one more')")
  check("write-large", true, `one INSERT on the ${Math.round(size / 1024)} KB database: ${Date.now() - t} ms`)
  await client.execute("DELETE FROM items WHERE label LIKE 'row-%' OR label = 'one more'")

  const returning = await client.select("INSERT INTO items (label) VALUES ('via select') RETURNING id")
  check("select-write", returning.length === 1, "INSERT … RETURNING through select()")
  await client.close()

  const reopened = await createDbClient({
    name: "probe",
    adapter,
    migrations: MIGRATIONS,
    migrationOptions: { executor: transactionalExecutor },
  })
  const [{ c }] = await reopened.select("SELECT COUNT(*) AS c FROM items WHERE label = 'via select'")
  check("reopen", c >= 1, `close() + reopen: ${c} row(s) written through select() are on disk`)
  await reopened.close()

  // rename 能不能覆盖已有文件（适配器不依赖它，这里只记录宿主行为）
  const a = `${wx.env.USER_DATA_PATH}/sqlite-probe/rename-a`
  const b = `${wx.env.USER_DATA_PATH}/sqlite-probe/rename-b`
  await call(fs, "writeFile", { filePath: a, data: "A", encoding: "utf8" })
  await call(fs, "writeFile", { filePath: b, data: "B", encoding: "utf8" })
  try {
    await call(fs, "rename", { oldPath: a, newPath: b })
    check("rename-overwrite", true, "rename onto an existing file: allowed")
  } catch (error) {
    check("rename-overwrite", true, `rename onto an existing file: rejected (${error.errMsg})`)
  }
  for (const f of [a, b]) await call(fs, "unlink", { filePath: f }).catch(() => {})
}
