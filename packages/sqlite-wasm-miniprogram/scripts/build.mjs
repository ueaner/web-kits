// 构建 sqlite-wasm-miniprogram：
//   1. 用 esbuild 把 src/index.ts 连同官方 glue（@sqlite.org/sqlite-wasm 的 dist/index.mjs）打成 dist/index.js（只发 ESM），
//      inject src/shims.ts，替换 glue 里的自由变量 URL / URLSearchParams / WebAssembly；
//   2. 在 Node 里跑原版 glue，拦截 WebAssembly.Module(bytes)，采集 jsFuncToWasm 现场拼的回调桩模块，
//      存成 dist/assets/stubs/<hex>.wasm（采集负载 + glue 源码里能静态找到的签名字面量）；
//   3. 复制 sqlite3.wasm，生成 brotli 压缩的 sqlite3.wasm.br，写 dist/assets/manifest.json；
//   4. tsc 生成类型声明。
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { brotliCompressSync, constants as zlib } from "node:zlib"
import { build } from "esbuild"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(join(root, "package.json"))
const sqliteWasmPkg = require.resolve("@sqlite.org/sqlite-wasm/package.json")
const sqliteWasmDist = join(dirname(sqliteWasmPkg), "dist")
const sqliteWasmVersion = JSON.parse(readFileSync(sqliteWasmPkg, "utf8")).version
const dist = join(root, "dist")
const assets = join(dist, "assets")

rmSync(dist, { recursive: true, force: true })
mkdirSync(join(assets, "stubs"), { recursive: true })

// 1. 打包
const common = {
  entryPoints: [join(root, "src/index.ts")],
  bundle: true,
  platform: "neutral",
  // 取 sqlite-wasm 的 "import"（浏览器版 glue），不是 "node"
  conditions: ["import"],
  mainFields: ["module", "main"],
  target: "es2020",
  minify: true,
  legalComments: "eof",
  inject: [join(root, "src/shims.ts")],
  // import.meta.url 只在 OPFS / Worker 分支里用到，小程序里不会走到
  define: { "import.meta.url": '"file:///sqlite-wasm-miniprogram.js"' },
  logLevel: "warning",
}
await build({ ...common, format: "esm", outfile: join(dist, "index.js") })

// 2. 采集回调桩模块
const glueUrl = pathToFileURL(join(sqliteWasmDist, "index.mjs")).href
const wasmBytes = readFileSync(join(sqliteWasmDist, "sqlite3.wasm"))
const stubs = new Map()
const RealModule = WebAssembly.Module
globalThis.WebAssembly = Object.assign(Object.create(WebAssembly), {
  Module: function Module(bytes) {
    const view = new Uint8Array(bytes)
    // 桩模块只有几十字节；sqlite3.wasm 本身不走这里（instantiateWasm 钩子直接 instantiate）
    if (view.byteLength < 256) stubs.set(Buffer.from(view).toString("hex"), Buffer.from(view))
    return new RealModule(bytes)
  },
})
const { default: sqlite3InitModule } = await import(glueUrl)
// glue 初始化时尝试安装 OPFS VFS，在 Node 里装不上，会用 console.warn 打一段堆栈：采集时静音
const consoleWarn = console.warn
console.warn = () => {}
const sqlite3 = await sqlite3InitModule({
  instantiateWasm(imports, done) {
    WebAssembly.instantiate(wasmBytes, imports).then((r) => done(r.instance, r.module))
    return {}
  },
  print() {},
  printErr() {},
})
console.warn = consoleWarn
// 采集负载：cross-sqlite-client 的 miniprogram 适配器用到的能力
{
  const { capi, oo1, wasm } = sqlite3
  const db = new oo1.DB(":memory:", "c")
  db.exec(
    "CREATE TABLE t (id INTEGER PRIMARY KEY, k TEXT UNIQUE, at INTEGER NOT NULL DEFAULT (cast(strftime('%s','subsec') * 1000 as int)))",
  )
  db.exec({ sql: "INSERT INTO t (k) SELECT ? WHERE true ON CONFLICT (k) DO NOTHING", bind: ["a"] })
  db.selectObjects("SELECT * FROM t")
  db.selectValue("PRAGMA schema_version")
  db.selectValue("PRAGMA quick_check")
  db.exec("BEGIN")
  capi.sqlite3_get_autocommit(db.pointer)
  db.exec("COMMIT")
  db.changes(true, false)
  capi.sqlite3_last_insert_rowid(db.pointer)
  const snapshot = capi.sqlite3_js_db_export(db.pointer)
  const db2 = new oo1.DB(":memory:", "c")
  const pointer = wasm.allocFromTypedArray(snapshot)
  capi.sqlite3_deserialize(
    db2.pointer,
    "main",
    pointer,
    snapshot.byteLength,
    snapshot.byteLength,
    capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE,
  )
  db2.close()
  db.close()
}
const fromWorkload = stubs.size
// glue 源码里能静态找到的签名字面量（如 "i(pp)"）：一起生成，覆盖采集负载没走到的回调，代价只有几百字节
const glueSource = readFileSync(join(sqliteWasmDist, "index.mjs"), "utf8")
const signatures = [...new Set([...glueSource.matchAll(/"([vijfdpsPJ]\([vijfdpsPJ*]*\))"/g)].map((m) => m[1]))].sort()
const skipped = []
for (const signature of signatures) {
  try {
    sqlite3.wasm.jsFuncToWasm(() => 0, signature)
  } catch (error) {
    skipped.push(`${signature}: ${error.message}`)
  }
}
globalThis.WebAssembly = Object.getPrototypeOf(globalThis.WebAssembly)
for (const [hex, bytes] of stubs) writeFileSync(join(assets, "stubs", `${hex}.wasm`), bytes)

// 3. wasm 和 manifest
writeFileSync(join(assets, "sqlite3.wasm"), wasmBytes)
const br = brotliCompressSync(wasmBytes, {
  params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_SIZE_HINT]: wasmBytes.byteLength },
})
writeFileSync(join(assets, "sqlite3.wasm.br"), br)
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")
const manifest = {
  sqliteWasm: sqliteWasmVersion,
  sqlite: sqlite3.capi.sqlite3_libversion(),
  files: {
    "sqlite3.wasm": { bytes: wasmBytes.byteLength, sha256: sha256(wasmBytes) },
    "sqlite3.wasm.br": { bytes: br.byteLength, sha256: sha256(br) },
  },
  stubs: [...stubs.keys()].sort(),
  signatures,
}
writeFileSync(join(assets, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)

// 打包进 dist/ 的第三方代码的声明（上游包本身没有附 LICENSE 文件，许可证写在它的 README 和 package.json 里）
writeFileSync(
  join(dist, "THIRD_PARTY_NOTICES.md"),
  `# Third-party notices

dist/index.js and dist/assets/sqlite3.wasm(.br) contain @sqlite.org/sqlite-wasm ${sqliteWasmVersion}
(https://github.com/sqlite/sqlite-wasm), licensed under the Apache License 2.0
(https://www.apache.org/licenses/LICENSE-2.0). It wraps SQLite ${sqlite3.capi.sqlite3_libversion()}
(https://sqlite.org), which is in the public domain (https://sqlite.org/copyright.html).
`,
)

// 4. 类型声明
const tsc = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc")
execFileSync(process.execPath, [tsc, "-p", join(root, "tsconfig.build.json")], { stdio: "inherit" })

console.log(
  `sqlite-wasm-miniprogram: sqlite ${manifest.sqlite} (sqlite-wasm ${sqliteWasmVersion}); ` +
    `${stubs.size} callback stubs (${fromWorkload} from the workload, ${signatures.length} signatures scanned` +
    `${skipped.length ? `, ${skipped.length} skipped: ${skipped.join("; ")}` : ""}); ` +
    `sqlite3.wasm ${wasmBytes.byteLength} B, .br ${br.byteLength} B`,
)
