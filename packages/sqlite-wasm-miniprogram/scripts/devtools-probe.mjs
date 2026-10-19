// 在微信开发者工具（或真机）里跑探针：生成一个最小的原生小程序，内含 dist/ 里的引擎和 cross-sqlite-client 的
// miniprogram 适配器，页面依次检查加载、读写、事务、落盘、重新打开，结果显示在页面上。
//
//   pnpm build && pnpm test:devtools            # 开发者工具模拟器里跑，用 miniprogram-automator 读结果
//   pnpm test:devtools --preview qr.png         # 生成真机预览二维码（需要真实 AppID），扫码后看页面上的结果
//
// 环境变量：
//   WECHAT_DEVTOOLS_CLI  开发者工具命令行，默认 "cli"（官方 macOS / Windows 版的 cli）。
//                        Linux 社区版（msojocs）会吞掉第一个参数，写成 "wechat-devtools-cli cli"
//   WECHAT_APPID         小程序 AppID，默认测试号 touristappid（不能真机预览）
//   WECHAT_AUTO_PORT     自动化端口，默认 9420
//
// 前提：开发者工具已登录，并在「设置 → 安全设置」里打开了服务端口。
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const project = join(root, ".devtools-probe")
const appid = process.env.WECHAT_APPID || "touristappid"
const autoPort = Number(process.env.WECHAT_AUTO_PORT || 9420)
const cli = (process.env.WECHAT_DEVTOOLS_CLI || "cli").split(" ").filter(Boolean)
const previewIndex = process.argv.indexOf("--preview")
const previewOutput = previewIndex >= 0 ? resolve(process.argv[previewIndex + 1] || "probe-qr.png") : null

// 1. 生成小程序
rmSync(project, { recursive: true, force: true })
mkdirSync(join(project, "pages/index"), { recursive: true })
cpSync(join(root, "dist/assets"), join(project, "sqlite"), { recursive: true })
await build({
  entryPoints: [join(root, "scripts/devtools-probe/probe.js")],
  bundle: true,
  format: "cjs",
  platform: "neutral",
  conditions: ["import"],
  mainFields: ["module", "main"],
  // 和 dist/ 一致：glue 里有 BigInt 字面量，es2020 以下降级不了（小程序基础库支持 BigInt）
  target: "es2020",
  outfile: join(project, "pages/index/probe.js"),
  logLevel: "warning",
})
const files = {
  "app.json": { pages: ["pages/index/index"], window: { navigationBarTitleText: "sqlite-wasm probe" }, sitemapLocation: "sitemap.json" },
  "sitemap.json": { rules: [{ action: "allow", page: "*" }] },
  "project.config.json": {
    appid,
    projectname: "sqlite-wasm-miniprogram-probe",
    compileType: "miniprogram",
    setting: { es6: true, enhance: true, minified: true, urlCheck: false },
  },
  "pages/index/index.json": {},
}
for (const [file, json] of Object.entries(files)) writeFileSync(join(project, file), `${JSON.stringify(json, null, 2)}\n`)
writeFileSync(join(project, "app.js"), "App({})\n")
writeFileSync(
  join(project, "pages/index/index.wxml"),
  `<view style="padding:24rpx;font-size:24rpx;white-space:pre-wrap;word-break:break-all">{{report}}</view>\n`,
)
writeFileSync(
  join(project, "pages/index/index.js"),
  `const { runProbe } = require("./probe.js")
Page({
  data: { report: "running…", results: [], done: false, failed: 0 },
  onLoad() {
    const results = []
    const render = () => this.setData({ results, report: results.map((r) => (r.ok ? "✓ " : "✗ ") + r.id + ": " + r.detail).join("\\n") })
    const log = (r) => { results.push(r); console.log("[probe]", r.id, r.ok, r.detail); render() }
    runProbe(log)
      .catch((e) => {
        // 连同 cause 链一起打印：适配器的错误把宿主的原始错误放在 cause 里
        const lines = []
        for (let x = e; x; x = x.cause) lines.push((x.stack || x.message || x.errMsg || String(x)).split("\\n")[0])
        log({ id: "fatal", ok: false, detail: lines.join(" <- ") })
      })
      .then(() => this.setData({ done: true, failed: results.filter((r) => !r.ok).length }))
  },
})
`,
)

function runCli(args) {
  const [command, ...prefix] = cli
  const result = spawnSync(command, [...prefix, ...args], { encoding: "utf8" })
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
  if (result.error || result.status !== 0) {
    throw new Error(`${cli.join(" ")} ${args.join(" ")} failed:\n${result.error?.message ?? output}`)
  }
  return output
}

// 2a. 真机预览：生成二维码
if (previewOutput) {
  if (appid === "touristappid") throw new Error("Real-device preview needs a real AppID: set WECHAT_APPID")
  runCli(["preview", "--project", project, "--qr-format", "image", "--qr-output", previewOutput])
  console.log(`Preview QR code written to ${previewOutput}. Scan it with WeChat; results show on the page.`)
  console.log("Kill the mini program and reopen it: 'previous-launches' should then report the earlier launch.")
  process.exit(0)
}

// 2b. 模拟器：自动化读结果
runCli(["auto", "--project", project, "--auto-port", String(autoPort)])
const { default: automator } = await import("miniprogram-automator")
// cli auto 返回以后，模拟器还要一会儿才开放自动化端口
let mp
for (let i = 0; !mp; i++) {
  try {
    mp = await automator.connect({ wsEndpoint: `ws://127.0.0.1:${autoPort}` })
  } catch (error) {
    if (i >= 60) throw error
    await new Promise((r) => setTimeout(r, 1000))
  }
}
let data
try {
  // 模拟器第一次编译项目时，reLaunch 会超时一两次
  let page
  for (let i = 0; !page; i++) {
    try {
      page = await mp.reLaunch("/pages/index/index")
    } catch (error) {
      if (i >= 12) throw error
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  for (let i = 0; i < 120; i++) {
    data = await page.data()
    if (data.done) break
    await new Promise((r) => setTimeout(r, 1000))
  }
} finally {
  mp.disconnect()
}
console.log(data?.report ?? "no result")
if (!data?.done) {
  console.error("Timed out waiting for the probe")
  process.exit(1)
}
process.exit(data.failed ? 1 : 0)
