# 三库合并 monorepo 迁移方案

> 对象：`cross-tab-kit`（0.4.0）、`pending-task-kit`（0.5.0）、`cross-sqlite-client`（0.2.1）
> 位置：`/home/ueaner/projects/frontend/{cross-tab-kit,pending-task-kit,cross-sqlite-client}`
> 本文所有事实均在 2026-09-22 实测。实测环境：Node 24.21.0、pnpm 11.7.0、三仓工作区干净。
> 本文写于三个项目之外的公共父目录，因为它是跨仓方案；新仓建立后应移到 `web-kits/docs/migrations/`。

---

## 0. 结论与需要你拍板的 9 件事

**结论：合并是合理的，收益主要不是"少写 YAML"，而是三件更硬的事**：① 消掉三份已经分叉的 kernel 代码；② 让 `cross-tab-kit` 那份经过 27 个用例打磨的锁原语可以被 `cross-sqlite-client` 复用（而不是各写一份、测试差 13 倍）；③ 让同源配置不再各自腐烂——本文实测到的 **6 处现存漂移**里，有一处是"Dependabot 的 PR 永远无法通过 CSC 的 CI"。

**但"只需要关注各自的 README/src/test"低估了骨架的统一难度**：tsconfig 严格度、测试环境、发布面三处必须显式决策，本文 §1.2 给了逐项差异。

### 9 个决策项（每项都给了推荐，可直接勾选）

| # | 决策 | 推荐 | 为什么 |
| --- | --- | --- | --- |
| D1 | 新仓名 / 是否加 npm scope | 新仓名自选；**包名一律不改、不加 scope** | 三个名字都已发布，改名是破坏性变更，合仓并不要求改名 |
| D2 | 历史怎么搬 | `git filter-repo` 保完整历史（§3.2 给了命令），旧仓 archive 不删 | 仅 39 个 commit，成本低；历史能保留"为什么这么设计"的推理 |
| D3 | 版本策略 | **独立版本**（`fixed: []`、`linked: []`），保持现状 | 三者成熟度与受众不同；三份 `.changeset/config.json` 本来就是这个策略 |
| D4 | 发布触发模型 | **per-package tag**：`<pkg>@<version>`（§4.1） | 单仓单 tag 无法区分包；per-package tag 保留了现有"tag 触发 + 干净 checkout + provenance"的可追溯性 |
| D5 | CSC 的 tsconfig 严格度 | **补齐到严格基线**，同一 PR 里修掉新暴露的错误 | 否则要为新仓永久维护一个"弱一档"的例外；补齐成本一次性、且是真的更安全 |
| D6 | 测试环境是否统一 | **不统一**，每包一份 `vitest.config.ts` | CTK=jsdom+假时钟、PTK=jsdom+真 Chromium、CSC=node+jsdom，物理上无法也不该统一 |
| D7 | CI 隔离粒度 | 根级 lint/format 一个 job；`typecheck/test/build/pub:check` 按包 matrix；浏览器 e2e 单独 job | 让 CTK 的 flake 不要挡住 CSC 发版（§4.3） |
| D8 | 是否顺手把 CSC 改为依赖 CTK | **不在搬迁 PR 里做**，作为独立的第三个阶段 | 它不是 drop-in，需要 CTK 先加一个新 API（§5.1）；混在一起会让"搬坏了"和"改坏了"无法区分 |
| D9 | 旧 GitHub 仓库 / npm 包 | 仓库 **archive**（不删）；npm 包继续存在（版本不可撤销） | 旧提交哈希需要能被解析（§3.2），且已发布版本无法收回 |

**明确不在本次范围内的**：给包改名、把 `packages/` 改成别的层级、引入 Turborepo/Nx 之类的编排器（三个包、秒级测试，pnpm 自带 `-r`/`--filter` 足够）、把 `docs/` 里的文档全量重写。

---

## 1. 事实基础

方案只能建立在实测事实上，所以先把事实钉死。§1.3 的两条是本次唯一需要"实验才能确定"的事，已经做过实验。

### 1.1 三个项目现状

| | cross-tab-kit | pending-task-kit | cross-sqlite-client |
| --- | --- | --- | --- |
| 版本 | 0.4.0 | 0.5.0 | 0.2.1 |
| 已有 tag | `v0.1.0` `v0.4.0` | `v0.2.0` `v0.3.0` `v0.4.0` `v0.5.0` | `v0.2.0` `v0.2.1` |
| commit 数 | 10 | 19 | 10 |
| `src` 行数 | 1,139 | 1,541 | ~1,375（含 72 行 `.tsx`） |
| 用例数 | **117**（9 个文件） | **93** vitest + 3 Playwright | **45**（实测 `vitest run` 全绿 3.60s） |
| 运行时依赖 | 无（`dependencies`/`peerDependencies` 均空） | `cross-tab-kit@0.4.0`（**精确 pin**）+ peer `react>=18`、`zustand>=5` | 无；`optionalDependencies`：`@sqlite.org/sqlite-wasm`、`@tauri-apps/plugin-sql` |
| devDeps 特征 | 只有 jsdom | + `@playwright/test`、`vite`、`react`、`react-dom`、`zustand` | + `@testing-library/react`、`react`、`react-dom`（**无** playwright、**无** vite） |
| 发布面 | `exports`(2 入口) + `main`/`module`/`types` + **`publishConfig`** | `exports`(2 入口) + `main`/`module`/`types` | 只有 `exports`（5 子路径），**无** `main`/`module`/`types`、**无** `publishConfig` |
| 文档落点 | `docs/` **8 篇** | 根目录 **4 篇** | **0 篇** |

依赖图是一个干净的 DAG，且**已经有一条真实依赖边**：

```
cross-tab-kit  (叶子)
      └── pending-task-kit   →  "cross-tab-kit": "0.4.0"
cross-sqlite-client            (目前独立，但实际在重复解决同一类跨标签页问题)
```

两条"分仓正在制造额外工作"的直接证据：

1. `pending-task-kit/pnpm-workspace.yaml` 里有一行 `minimumReleaseAgeExclude: [cross-tab-kit@0.4.0]`——这条存在的**唯一原因**就是"消费方与依赖方不在同一个仓库"。合仓后用 `workspace:*` 直接消灭它。
2. `cross-tab-kit/docs/requirements-from-pending-task-kit.md`——CTK 的 API 有一部分是被 PTK 的需求反向推出来的。跨仓需求往返已经被文档化了；合仓后它变成同仓改代码。

### 1.2 骨架相似度实测（这是"共享骨架"这个前提到底成不成立的答案）

**逐字节相同的（可以直接提到根级）**：

| 文件 | 状态 |
| --- | --- |
| `.oxfmtrc.json` | 三份**完全相同**（`semi:false`、`printWidth:140`、`tabWidth:2`） |
| `.changeset/config.json` | 三份**完全相同**（含 `access:public`、`fixed:[]`、`linked:[]`、`updateInternalDependencies:patch`） |
| `LICENSE` | 三份 md5 相同：`55166e9b8c3779c2c556258f68e50535` |
| `.github/dependabot.yml` | PTK 与 CSC **完全相同**（CTK **缺失**，见 §1.3） |
| `tsdown.config.ts` 的 `format/dts/clean/platform` | 三份相同（`esm` / `true` / `true` / `neutral`） |
| `README.md` + `README.zh-CN.md` + `CHANGELOG.md` 三件套 | 三份都有 |
| `package.json` 的 `license`/`author`/`repository` 结构、`files:["dist"]`、`type:"module"`、`sideEffects:false`、`engines:>=24`、`packageManager:pnpm@11.5.2` | 三份一致 |

**同源但已经分叉（这是合仓最直接的价值）**：

| 文件 | 差异 |
| --- | --- |
| `tsconfig.json` | **CTK 与 PTK 逐字节相同**；CSC 偏离 **6 个选项**（见下表） |
| `vitest.config.ts` | CTK=`jsdom`；PTK=`jsdom` + `exclude: test-e2e/**`；CSC=`node` |
| `ci.yml` 步骤顺序 | **三种不同顺序**：CTK `typecheck→lint→format:check→test→build→pub:check`；CSC `lint→format:check→typecheck→test→build→pub:check`；PTK `build→pub:check→typecheck→lint→format:check→test` |
| `release.yml` tag glob | `v*`（CTK）/ `v*`（PTK）/ `v[0-9]+.[0-9]+.[0-9]+`（CSC） |
| `.gitignore` | 三种形状（CTK 有 `coverage`/`*.log`，PTK 再加 playwright 产物，CSC 只有 `dist/`、`node_modules/`） |
| `pnpm-workspace.yaml` | CTK 与 PTK 有（PTK 多一条 `minimumReleaseAgeExclude`）；**CSC 没有** |

CSC 偏离的 6 个 tsconfig 选项（D5 决策的具体内容）：

| 选项 | CTK / PTK | CSC | 影响 |
| --- | --- | --- | --- |
| `noUncheckedIndexedAccess` | `true` | **缺失** | 补齐后 `arr[i]` 变成可能 `undefined`，会暴露一批新类型错误 |
| `declaration` | `true` | **缺失** | tsdown 负责出 `.d.ts`，影响小 |
| `esModuleInterop` | `true` | **缺失** | 影响小 |
| `forceConsistentCasingInFileNames` | `true` | **缺失** | 影响小 |
| `resolveJsonModule` | 缺失 | `true` | CSC 独有，保留 |
| `noFallthroughCasesInSwitch` | 缺失 | `true` | CSC 独有，保留 |
| `target` / `lib` | `ES2020` | `ESNext` | 建议统一到 `ES2020`（三包都不依赖更新的语法；`ESNext` 会让 `target` 随 TS 版本漂移） |

**真正的按包差异（必须留在包内）**：`tsdown.config.ts` 的 `entry`（2 / 2 / 5 个入口）与 `external`（只有 PTK 设了 `external: [react, zustand, zustand/middleware]`）；`vitest.config.ts`；`playwright.config.ts`（只有 PTK 有）；`package.json` 的 `exports`/`peerDependencies`/`optionalDependencies`；`test/` 及其 harness。

### 1.3 实测结论：`workspace:*` 发布后是"精确版本"

这是整个迁移里**唯一可能悄悄改变对外契约**的地方——PTK 现在对 CTK 用的是精确 pin（`"0.4.0"`，不是 `^0.4.0`），所以必须确认合仓后这个语义不变。

**实测方法**（在一个临时 workspace 里做了三次，pnpm 11.7.0）：

```bash
# packages/a = probe-a@1.2.3；packages/b 依赖 probe-a，三组分别用不同 protocol
pnpm install --ignore-scripts --store-dir <本地 store>
cd packages/b && pnpm pack --pack-destination ..
tar -xzOf probe-b-0.0.0.tgz package/package.json   # ← 看 dependencies 被改写成了什么
```

**实测结果**：

| 源码里写的 | 发布出的 tarball 里是 |
| --- | --- |
| `"probe-a": "workspace:*"` | `"probe-a": "1.2.3"`（**精确版本，无 `^`**） |
| `"probe-a": "workspace:^"` | `"probe-a": "^1.2.3"` |
| `"probe-a": "workspace:~"` | `"probe-a": "~1.2.3"` |

**结论**：用 `workspace:*` 即可**原样保留 PTK 现有的精确 pin 语义**，不需要任何额外配置。这一条把 D4/§6 里最大的未知变成了已知。（注意：`pnpm install` 不会改写源 `package.json`；被打包到 tarball 里的 `package.json` **副本**才会被改写为精确版本——判断"发布出去到底是什么"要看 tarball，不要看源文件。）

### 1.4 现存 6 处漂移（合仓会顺手消除，但值得先知道）

这些不是"合仓的代价"，而是"分仓已经付掉的代价"：

| # | 漂移 | 证据 | 后果 |
| --- | --- | --- | --- |
| 1 | **CSC 的 changeset 门禁缺 Dependabot 豁免** | CSC `ci.yml` 的 `if: github.event_name == 'pull_request'`；CTK/PTK 是 `&& github.actor != 'dependabot[bot]'` | Dependabot 提的所有 PR（含依赖升级）都会因"缺少 changeset"**永远无法通过 CI** |
| 2 | **CTK 没有 `dependabot.yml`** | `cross-tab-kit/.github/` 下只有 `workflows/` | CTK 的依赖完全靠人工留意 |
| 3 | CI 同一条流水线三种步骤顺序 | §1.2 | 顺序差异让"哪里该 build"这类知识无法沉淀；PTK 的顺序是**有理由的**（e2e 类型检查依赖 `dist/`），另两处是复制漂移 |
| 4 | `publishConfig` / `main`+`module`+`types` 不一致 | CTK、PTK 有；CSC 没有 | CSC 的包元数据比同族少一档 |
| 5 | `.changeset/README.md` 只有 2/3 | CTK、PTK 有 | 新贡献者第一次 `pnpm changeset` 没有说明 |
| 6 | 评审文档三种落点（`docs/` 8 篇 / 根目录 4 篇 / 0 篇） | §1.1 | "某个历史问题修没修"无处可查 |

---

## 2. 目标仓库结构

```
web-kits/                             
├── package.json                       # private:true，只放 -r 转发脚本
├── pnpm-workspace.yaml                # packages/* + onlyBuiltDependencies
├── tsconfig.base.json                 # 统一严格基线（含 noUncheckedIndexedAccess）
├── .oxfmtrc.json                      # 唯一一份（三份本来就相同）
├── .editorconfig
├── .gitignore                         # 三份的并集
├── LICENSE                            # 仓库自身的 LICENSE（另见下方警告）
├── README.md                          # 仓库说明（不是任何包的 README）
├── .changeset/
│   ├── config.json                    # 唯一一份（三份本来就相同）
│   └── README.md                      # 顺手补上（漂移 #5）
├── .github/
│   ├── dependabot.yml                 # 唯一一份（顺手补上 CTK 缺的那份，漂移 #2）
│   └── workflows/
│       ├── ci.yml                     # 根级 lint/format + 按包 matrix + 浏览器 e2e
│       └── release.yml                # per-package tag 触发
├── docs/                              # 全仓文档统一落点（漂移 #6）
│   ├── migrations/                    # ← 本文最终应该在这里
│   ├── cross-tab-kit/                 # 从 CTK docs/ 搬入的 8 篇
│   ├── pending-task-kit/              # 从 PTK 根目录搬入的 4 篇
│   └── cross-sqlite-client/           # CSC 现有 0 篇 + 后续评审
└── packages/
    ├── cross-tab-kit/
    │   ├── package.json               # exports/peer/scripts；repository.directory 指向本目录
    │   ├── tsconfig.json              # extends ../../tsconfig.base.json
    │   ├── tsdown.config.ts           # entry + external（按包保留）
    │   ├── vitest.config.ts           # jsdom
    │   ├── LICENSE                    # ← 必须保留，见下方警告
    │   ├── README.md                  # 双语 README 必须留在包内（会被发布到 npm）
    │   ├── README.zh-CN.md
    │   ├── CHANGELOG.md               # changesets 写入这里
    │   ├── src/                       # 原样
    │   └── test/{harness,*.test.ts}   # 原样
    ├── pending-task-kit/
    │   ├── ...                        # 同上，另加 playwright.config.ts + test-e2e/
    └── cross-sqlite-client/
        └── ...
```

> ⚠️ **`packages/*/LICENSE` 必须每包保留一份，不能只留根级。**
> npm 的"总是包含"规则（`package.json`、`README`、`LICENSE`）是相对**包的根目录**解析的，而 pnpm 是从包目录打包的。如果 LICENSE 只放在 monorepo 根，发布出的 tarball 会**丢掉 LICENSE**——这是相对现状的静默回归。§7 的验收里有"迁移前后 tarball 文件清单对比"专门盯这一条。

**该共享 vs 该保留**：

| 共享（提到根级，唯一一份） | 保留（每包一份） |
| --- | --- |
| CI / release 编排、dependabot | `src`、`test`（含 harness / e2e） |
| `.changeset/`、`oxfmt`、`.editorconfig` | `vitest.config.ts`、`playwright.config.ts` |
| `tsconfig.base.json` | `tsconfig.json`（只写 extends + 包特有选项） |
| `.gitignore`、`LICENSE`（仓库自身） | `LICENSE`（发布用）、`README.md`、`README.zh-CN.md`、`CHANGELOG.md` |
| `docs/` 的统一落点 | `tsdown.config.ts` 的 `entry`/`external` |
| **`kernel/` 类原语**（Logger、毫秒参数校验、safe-storage、tab-lock，见 §5.2） | `package.json` 的 `exports`/`peerDependencies`/`optionalDependencies` |

---

## 3. 阶段 A：建仓与搬迁（**不改一行行为**）

### 3.0 风险控制原则（这条最重要）

**搬迁与重构必须分成不同的提交批次。** 先得到一个"结构变了但行为完全没变、所有测试全绿、没有版本号变动"的提交，再在上面做去重。否则一旦 e2e 报红，你无法判断是"vite 的 root 解析变了"还是"锁的语义改了"。

同一个原则在 PTK 的历史里有现成先例：`1c1b7e4 chore: adopt oxfmt and reformat the codebase (no behavior change)`——提交信息里明确写"无行为变更"，让 review 可以整文件跳过。

### 3.1 建仓与根骨架

```bash
mkdir web-kits && cd web-kits && git init -b main
```

**`pnpm-workspace.yaml`**（三个包从各自的单包文件合并而来，`minimumReleaseAgeExclude` 直接删除）：

```yaml
packages:
  - "packages/*"

onlyBuiltDependencies:
  - esbuild
```

> pnpm 10/11 的 `pnpm-workspace.yaml` 顶层合法字段只有 `packages`、`onlyBuiltDependencies`、`ignoredBuiltDependencies` 等，**没有 `allowBuilds` 这个键**——原版那个块会让 `pnpm install` 直接报 "Unknown option"。

**根 `package.json`**（只有转发脚本，`private: true`）：

```jsonc
{
  "name": "web-kits",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.5.2",
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "pnpm -r run build",
    "typecheck": "pnpm -r run typecheck",
    "test": "pnpm -r run test",
    "lint": "oxlint .",
    "format": "oxfmt .",
    "format:check": "oxfmt --check .",
    "pub:check": "pnpm -r run pub:check",
    "changeset": "changeset",
    "version-packages": "changeset version"
  },
  "devDependencies": {
    "@changesets/cli": "^3.0.3",
    "oxfmt": "^0.68.0",
    "oxlint": "^1.83.0",
    "publint": "^0.3.24",
    "typescript": "^7.0.2"
  }
}
```

> `pub:check` 需要 `dist/`，所以根脚本不串在一起；CI 里保证 `build` 在 `pub:check` 之前（§4.3）。
> 根级 `lint`/`format:check` 用 `oxlint .` / `oxfmt --check .`（不带参数），不再逐包传 `src test test-e2e` —— 这会让检查范围扩大到 `*.config.ts` 等，**可能暴露若干新告警**，属于阶段 A 要顺手清掉的量（见 §3.5）。

**`tsconfig.base.json`**（以 CTK∩PTK 的逐字节相同版本为基线，D5 要求 CSC 补齐）：

```jsonc
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020", "DOM"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "declaration": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true,
    "isolatedModules": true,
    "noEmit": true
  }
}
```

每包 `tsconfig.json`：CTK 直接 `{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }`；PTK 额外加 `"jsx": "react-jsx"`；CSC 额外加 `"resolveJsonModule": true`、`"noFallthroughCasesInSwitch": true`。

**`.gitignore`**（三份并集）：

```
node_modules
dist
coverage
*.log
test-results
playwright-report
blob-report
.last-run.json
```

**`.oxfmtrc.json` / `.changeset/config.json`**：直接取任意一份（三份本来就逐字节相同），并把 CTK 那份 `.changeset/README.md` 一并搬来。

### 3.2 搬迁历史（D2）

**先看一个必须处理的问题：三个仓库的 tag 会撞名。**

| tag | CTK | PTK | CSC |
| --- | --- | --- | --- |
| `v0.1.0` | ✅ | | |
| `v0.2.0` | | ✅ | ✅ ← **撞** |
| `v0.2.1` | | | ✅ |
| `v0.3.0` | | ✅ | |
| `v0.4.0` | ✅ | ✅ | ← **撞** |
| `v0.5.0` | | ✅ | |

所以**导入前必须先把 tag 重命名**成 per-package 方案（与 D4 一致），否则合并时 tag 会互相覆盖。

**推荐路径（`git filter-repo`，保留完整历史与作者信息）：**

> ⚠️ **必须按下面顺序**：`clone → dump (tag, date) → filter-repo → 按日期回查新 SHA 并打 tag`。原脚本把"重命名 tag"放在 `filter-repo` **之前**——但 `filter-repo` 会改写所有 commit 的 SHA（因为 tree 整体挪了一层），于是重命名过的 tag 全都变成悬空引用，下一步 `git fetch --tags` 不会传悬空 tag，验收清单里"tag 已重命名"会**全部失败**。

```bash
# 前置：pip install git-filter-repo
MONO=~/projects/frontend/web-kits
SRC=~/projects/frontend
TAGMAP=/tmp/mig-tags.txt
# 注：TAGMAP 在整个三包循环结束后会自然包含全部 (pkg, tag, date) 三元组，
# 阶段 2 里按 pkg 过滤后取回新 SHA 用。

mkdir -p "$MONO" && cd "$MONO" && git init -b main
git commit --allow-empty -m "chore: initialize monorepo"

# 阶段 1：clone 每个仓库，把 (pkg, old_tag, 提交日期) 三元组写到 TAGMAP。
# 日期保留，commit message / 作者保留——这是 filter-repo 之后能定位回原 tag 的唯一线索。
for p in cross-tab-kit pending-task-kit cross-sqlite-client; do
  mkdir -p /tmp/mig-stage
  git clone --no-local "$SRC/$p" /tmp/mig-stage/$p
  cd /tmp/mig-stage/$p
  git tag | while read -r t; do
    printf '%s\t%s\t%s\n' "$p" "$t" "$(git log -1 --format='%cI' "$t")" >> "$TAGMAP"
  done
done

# 阶段 2：每个仓库 filter-repo（改写所有 SHA），再按日期在新历史里回查新 SHA 并重命名 tag。
for p in cross-tab-kit pending-task-kit cross-sqlite-client; do
  cd /tmp/mig-stage/$p
  git filter-repo --to-subdirectory-filter "packages/$p" --force

  # 用 --before= 取"日期不超过原 tag 日期"的最末一个 commit，即原 tag 指向的提交。
  # 同秒多 commit 时取首个；时间分辨率是 commit date，不是 author date。
  awk -F'\t' -v pkg="$p" '$1==pkg {print $2"\t"$3}' "$TAGMAP" | while IFS=$'\t' read -r oldtag date; do
    new_sha="$(git log --before="$date" -n1 --format='%H')"
    [ -n "$new_sha" ] && git tag "${p}@${oldtag#v}" "$new_sha"
  done
done

# 阶段 3：合并进新仓（顺序：被依赖的先合）
cd "$MONO"
for p in cross-tab-kit cross-sqlite-client pending-task-kit; do
  git remote add "$p" /tmp/mig-stage/$p
  git fetch "$p" --tags
  git merge --allow-unrelated-histories --no-edit "$p/main"   # 三仓默认分支都是 main（已核对）
  git remote remove "$p"
done

> 合并顺序：建议 **`cross-tab-kit` → `cross-sqlite-client` → `pending-task-kit`**，把唯一有内部依赖的 PTK 放最后。合并本身不影响 `workspace:*`（那是 §3.3 的字段改动，属于紧随其后的提交）。

**替代路径（`git subtree`，无需额外安装）**：`git subtree add --prefix=packages/<p> <url> <branch>`（不加 `--squash` 即保留完整历史）。tag 重命名仍需照做。

**关于 CHANGELOG 里的提交哈希——必须知道的坏消息：**

三份 CHANGELOG 里有 **8 个不同的提交哈希引用**：`04d226a`、`58fc7f9`、`7d526f3`、`9515234`、`a27fa88`、`d955de3`、`e34ae40`、`ffe69a5`。

**把文件移到子目录必然改写 tree，因此所有提交哈希都会变。** 无论用 `filter-repo` 还是 `subtree`，这 8 个哈希在合并后都**指向不了新仓的任何提交**。所以：

1. **旧仓库只 archive、不删除**——哈希仍能在旧仓解析，`CHANGELOG` 的引用不至于彻底失效；
2. 在新仓 `CHANGELOG.md` 顶部（或每个包的首次发布条目）加一条说明，例如：
   > 迁移说明：本包 0.x 的历史提交位于独立仓库 `cross-tab-kit`，本文档中出现的提交哈希均指该仓库。
3. 如果连"历史可浏览"都不需要，**直接新仓起步（不带历史）也是合理选择**——只有 39 个 commit，且三份 CHANGELOG 已经是自洽的散文记录。这是个纯粹的偏好决定，两种都可以，但**要知道哈希一定会变**，别指望"搬了历史哈希就还在"。

### 3.3 每个包要改的字段

| 字段 | 改法 |
| --- | --- |
| `repository` | 指向新仓并加 `directory`：`{ "type":"git", "url":"git+https://github.com/ueaner/web-kits.git", "directory": "packages/<pkg>" }`——npm 页面与 provenance 靠它定位到子目录 |
| `homepage` / `bugs` | 一并指向新仓（建议带 `#readme` 与 `/issues`） |
| `dependencies`（仅 PTK） | `"cross-tab-kit": "0.4.0"` → `"cross-tab-kit": "workspace:*"`（§1.3 已实测：发布后仍是精确 `0.4.0`，语义不变） |
| `publishConfig`（仅 CTK 有） | 保留；也可删掉并依赖 `.changeset/config.json` 的 `access: "public"`——但**三包要一致** |
| `main`/`module`/`types`（CSC 缺） | 建议 CSC 补上，与本族对齐；或三包统一只留 `exports`。**不要留成 2/3** |
| `scripts` | 逐包保留（含 `prepublishOnly`）；根级不放 `typecheck` 之类的具体实现，只做 `-r` 转发 |
| `devDependencies` | 把 `oxfmt`/`oxlint`/`publint`/`typescript` 提到根，**版本以 §3.1 根 `package.json` 中已固定的版本为准**，三包 devDependencies 中这四个工具的版本在搬迁 PR 里统一改为与根一致；`@changesets/cli` 也提到根。包内只留真正按包不同的（`jsdom`、`@testing-library/react`、`@playwright/test`、`vite`、`react`、`react-dom`、`zustand`、`tsdown`、`vitest`） |
| `packageManager` / `engines` | 三份本来就一致，保留在包内或只放根级皆可；建议包内也留，因为发布后的 `package.json` 是消费者的依据 |

> 改 `repository`/`homepage`/`bugs` 属于**元数据变更**，按 changesets 的规矩需要一个 `patch` changeset。阶段 A 的提交里一并写上。

### 3.4 测试环境的按包保留

| 包 | `vitest.config.ts` | 额外 |
| --- | --- | --- |
| `cross-tab-kit` | `environment: "jsdom"` | `test/harness/`（假时钟 + 手工派发 storage 事件） |
| `pending-task-kit` | `environment: "jsdom"` + `exclude: [...configDefaults.exclude, "test-e2e/**"]` | `playwright.config.ts` + `test-e2e/` |
| `cross-sqlite-client` | `environment: "node"` | `test/react.test.tsx` 用 `// @vitest-environment jsdom` 逐文件覆盖 |

**不要为了"统一"把 CSC 改成 jsdom**：它的 45 个用例里有 38 个跑在 node 上（真 sqlite-wasm 主线程 + memory adapter），改成 jsdom 只会变慢且引入无关的 DOM 环境。

### 3.5 阶段 A 顺手清掉的漂移

按 §1.4 逐条处理：

1. CSC 的 changeset 门禁**加上 dependabot 豁免**（新仓的 `ci.yml` 里天然就有，见 §4.3）；
2. **补 CTK 的 `dependabot.yml`**（新仓一份，覆盖三包）；
3. 步骤顺序统一为**一个有理由的顺序**：`build → pub:check → typecheck → lint → format:check → test`（沿用 PTK 的理由：e2e/`publint` 都依赖 `dist/`），并把这个理由写进 workflow 注释；
4. `publishConfig` / `main`+`module`+`types` 三包对齐；
5. 补 `.changeset/README.md`；
6. 评审文档归位到 `docs/<pkg>/`（CTK 8 篇、PTK 4 篇；PTK 的 `cross-tab-kit-0.3.0-integration.md` 建议一并改名以表明它是历史方案记录）。

### 3.6 阶段 A 验收

- [ ] `pnpm install --frozen-lockfile` 成功（先 `pnpm install` 生成新的根 lockfile 并提交）
- [ ] `pnpm -r run typecheck` / `pnpm -r run test` / `pnpm -r run build` 全绿：**117 + 93 + 45 = 255 个用例，一个都不少**
- [ ] `pnpm --filter pending-task-kit run test:e2e` 通过（**这是最容易被仓库结构调整打坏的一环**，见 §7）
- [ ] `pnpm -r run pub:check` 全绿
- [ ] `pnpm lint` / `pnpm format:check` 干净
- [ ] **每个包的 tarball 文件清单与迁移前逐项一致**（§7 给了做法）
- [ ] `git log` 里三个包的历史都在，tag 已重命名为 `<pkg>@<version>`
- [ ] `git for-each-ref refs/tags/ | wc -l` == 8（CTK 2 + PTK 4 + CSC 2；少一个就是 §3.2 的 TAGMAP 回查遗漏）
- [ ] 没有任何 `package.json` 的 `version` 发生变化

---

## 4. 阶段 B：CI 与发布重写

### 4.1 【本方案最不显然的后果】tag 触发模型必须改

现状是**单包单仓**，"打一个 `v0.5.0` tag"就唯一确定了要发什么。合仓后 `v0.5.0` 不再能回答问题：是 PTK 的 0.5.0、CTK 的 0.5.0，还是 CSC 的 0.5.0？

三条可选路线：

| 方案 | 做法 | 取舍 |
| --- | --- | --- |
| **B-A（推荐）** | **per-package tag** `<pkg>@<version>`，workflow 从 tag 解析出包名与版本 | 完整保留现有"tag 触发 + 干净 checkout + `--provenance`"的可追溯性；代价是发布多包时要按依赖顺序推多个 tag（见下） |
| B-B | 改用 changesets 标准流：main 上自动开 "Version Packages" PR，合并后在 push 到 main 时发布所有待发包 | 自动化程度最高、拓扑顺序自动处理；但**放弃了"产物只可能来自打过的 tag"**这个现有设计，而三份 `release.yml` 的注释都明确在维护这个属性 |
| B-C | 保留单 `vX.Y.Z` tag，一次发布所有被 `changeset version` 碰过的包 | 最省事；但发布粒度变粗，且"tag 版本号对不上某个包的版本号"会让现有的 tag↔版本校验失去意义 |

**推荐 B-A。** tag 解析在 bash 里很短，且对带 scope 的名字也正确：

```bash
TAG="${GITHUB_REF#refs/tags/}"     # e.g. pending-task-kit@0.6.0
PKG="${TAG%@*}"                    # pending-task-kit
VER="${TAG##*@}"                   # 0.6.0
```

已实测这段解析（含带 scope 的名字）：`pending-task-kit@0.6.0` → `pending-task-kit` / `0.6.0`；`@ueaner/foo@1.0.0` → `@ueaner/foo` / `1.0.0`。

顺带一个好性质：**如果误推了一个旧风格的裸 `v0.5.0` tag**，解析会得到 `PKG=v0.5.0`，与任何 `packages/<dir>` 都不匹配，于是 workflow 在第一步就带着明确信息失败——而不是发出一个错的包。

**B-A 必须配一条发布顺序规则。** `changeset version` 同时给 CTK 和 PTK 升版本时，PTK 的 tarball 里 pin 的是 CTK 的新版本号——**CTK 必须先发布成功，PTK 才能发**。两个办法，建议都做：

1. **文档化规则**：先推被依赖方的 tag，等它发布完成，再推依赖方的 tag；
2. **在 workflow 里加一条 preflight**，把"顺序搞错"从"publish 失败"变成"明确报错"：

```bash
# 发布前确认所有 workspace 依赖的精确版本都已存在于 registry
node -e '
const fs=require("fs"), {execSync}=require("child_process");
const pkg=JSON.parse(fs.readFileSync(process.env.PKG_DIR+"/package.json","utf8"));
for (const [name, range] of Object.entries(pkg.dependencies||{})) {
  if (!/^\d+\.\d+\.\d+/.test(range)) continue;      // 只看精确版本（workspace 依赖）
  try { execSync(`npm view ${name}@${range} version`, {stdio:"ignore"}); }
  catch { console.error(`✗ ${name}@${range} 尚未发布——请先发布被依赖的包`); process.exit(1); }
}
console.log("✓ 所有内部依赖已就位");
'
```

### 4.2 新的 `release.yml`（B-A 的完整实现）

```yaml
name: Release

# per-package tag 触发：<pkg>@<version>（如 cross-tab-kit@0.5.0）。
# 为什么不沿用单 `vX.Y.Z`：合仓后一个 tag 无法唯一确定要发布哪个包。
# 仍然保留"tag 触发 + 干净 checkout + 重新验证 + --provenance"这套可追溯性：
# 发布出去的东西永远能追溯到一个打过 tag、经过审查的提交。
on:
  push:
    tags:
      - "*@*"

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write   # --provenance 需要
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: pnpm
          registry-url: https://registry.npmjs.org

      - name: Resolve package and version from the tag
        id: tag
        run: |
          TAG="${GITHUB_REF#refs/tags/}"
          PKG="${TAG%@*}"
          VER="${TAG##*@}"
          DIR="packages/$PKG"
          if [ ! -d "$DIR" ]; then
            echo "Tag names package '$PKG' but $DIR does not exist" >&2; exit 1
          fi
          if [ ! -f "$DIR/package.json" ]; then
            echo "$DIR/package.json not found" >&2; exit 1
          fi
          echo "pkg=$PKG"   >> "$GITHUB_OUTPUT"
          echo "ver=$VER"   >> "$GITHUB_OUTPUT"
          echo "dir=$DIR"   >> "$GITHUB_OUTPUT"

      - name: Verify the tag version matches that package's package.json
        env:
          DIR: ${{ steps.tag.outputs.dir }}
          VER: ${{ steps.tag.outputs.ver }}
        run: |
          pkg_version="$(node -p "require('./$DIR/package.json').version")"
          if [ "$pkg_version" != "$VER" ]; then
            echo "Tag version $VER != $DIR/package.json version $pkg_version" >&2
            exit 1
          fi

      - run: pnpm install --frozen-lockfile

      # build 必须在 pub:check 与 typecheck 之前：publint 检查 dist/，
      # 而 pending-task-kit 的 test-e2e 直接 import ../dist/index.js（构建产物冒烟测试）。
      - run: pnpm --filter "${{ steps.tag.outputs.pkg }}" run build
      - run: pnpm --filter "${{ steps.tag.outputs.pkg }}" run pub:check
      - run: pnpm --filter "${{ steps.tag.outputs.pkg }}" run typecheck
      - run: pnpm --filter "${{ steps.tag.outputs.pkg }}" run lint
      - run: pnpm --filter "${{ steps.tag.outputs.pkg }}" run format:check
      - run: pnpm --filter "${{ steps.tag.outputs.pkg }}" run test

      # 若该包有浏览器 e2e，也必须在这里跑（tag 触发路径要复现 CI 的全部验证）
      - name: Browser e2e (if present)
        if: ${{ steps.tag.outputs.pkg == 'pending-task-kit' }}
        run: pnpm --filter "${{ steps.tag.outputs.pkg }}" run test:e2e

      # 发布前确认所有内部 workspace 依赖的精确版本都已存在于 registry。
      # 注意：源 package.json 里写的是 "workspace:*" / "workspace:^" —— 实际发布出去是 lockfile
      # 解析后的精确版本号，所以要从 pnpm-lock.yaml 里拿，而不是看 range 字符串。
      - name: Preflight — internal workspace deps are published
        env:
          DIR: ${{ steps.tag.outputs.dir }}
        run: |
          node -e '
          const fs=require("fs"), {execSync}=require("child_process");
          const lock=fs.readFileSync("pnpm-lock.yaml","utf8");
          const pkg=JSON.parse(fs.readFileSync(process.env.DIR+"/package.json","utf8"));
          for (const [name, range] of Object.entries(pkg.dependencies||{})) {
            // 解析 lockfile 中该 workspace 依赖对应的精确版本
            const re=new RegExp("^\\s+"+name.replace(/[\\^$.*+?()[\]{}|]/g,"\\$&")+"@[^:]+:\\s*\\n(?:\\s+.*\\n)*?\\s+version:\\s*(\\S+)","m");
            const m=lock.match(re);
            const ver=m?m[1]:range;
            if(!/^\d+\.\d+\.\d+/.test(ver)) continue;
            try {
              execSync(`npm view ${name}@${ver} version --registry=https://registry.npmjs.org`,{stdio:"ignore",timeout:10000});
            } catch {
              console.error(`✗ ${name}@${ver} 尚未发布——请先发布被依赖的包`);
              process.exit(1);
            }
          }
          console.log("✓ 所有内部依赖已就位");
          ''''

      # --no-git-checks：CI 的 detached-HEAD tag checkout 下，pnpm publish 自身的
      # git 洁净/分支检查没有意义；上面那次干净 checkout 的 tag 才是真正的可追溯性保证。
      - run: pnpm --filter "${{ steps.tag.outputs.pkg }}" publish --no-git-checks --provenance
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

> `concurrency` 已在 `release.yml` 顶部加好（group: release-${{ github.ref }} / cancel-in-progress: false）。发布是终态动作，不应被 cancel。

### 4.3 新的 `ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  # 仓库级检查只跑一次，不按包重复
  hygiene:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0   # changeset status --since 需要能 diff 到 base 分支
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm format:check
      # PR 改动了需要发布的代码就必须带 changeset；纯文档/杂务 PR 用
      # `pnpm changeset --empty` 显式豁免。Dependabot 按设计不带 changeset，豁免掉。
      # 注：fork PR 上 origin 指向 fork repo，base_ref 不一定在 origin 里。
      # 先把 upstream 的 base SHA 显式 fetch 回来，再作为 --since 锚点。
      - name: Fetch upstream base ref (fork-safe)
        if: github.event_name == 'pull_request' && github.actor != 'dependabot[bot]'
        run: git fetch origin ${{ github.event.pull_request.base.sha }} --depth=1
      - name: Require a changeset for changes that should ship in a release
        if: github.event_name == 'pull_request' && github.actor != 'dependabot[bot]'
        run: pnpm exec changeset status --since=${{ github.event.pull_request.base.sha }}

  # 三包同一套流水线，用 matrix 而不是复制三份 job
  package:
    needs: hygiene
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        package: [cross-tab-kit, pending-task-kit, cross-sqlite-client]
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter "${{ matrix.package }}" run typecheck
      - run: pnpm --filter "${{ matrix.package }}" run test
      - run: pnpm --filter "${{ matrix.package }}" run build
      # publint 检查 dist/，所以必须在 build 之后
      - run: pnpm --filter "${{ matrix.package }}" run pub:check

  # 浏览器 e2e 单列：只有部分包有，且是最慢、最容易 flake 的一层，
  # 让它独立成一个 job，避免拖住（或挡住）其它包的信号。
  # 将来 CSC 的 web 适配器 e2e、CTK 的真双标签页 e2e 都加进这个 matrix。
  browser-e2e:
    needs: package
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        package: [pending-task-kit]
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter "${{ matrix.package }}" run build
      - name: Cache Playwright browsers
        uses: actions/cache@v6
        id: playwright-cache
        with:
          path: ~/.cache/ms-playwright
          # 按 lockfile 而非 Playwright 版本号键控，这样某个 @playwright/test 版本
          # 自带的浏览器修订一定会正确失效。
          key: playwright-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}
      - run: pnpm exec playwright install --with-deps chromium
        if: steps.playwright-cache.outputs.cache-hit != 'true'
      - run: pnpm exec playwright install-deps chromium
        if: steps.playwright-cache.outputs.cache-hit == 'true'
      - run: pnpm --filter "${{ matrix.package }}" run test:e2e
      - name: Upload Playwright report
        uses: actions/upload-artifact@v7
        if: failure()
        with:
          name: playwright-report-${{ matrix.package }}
          path: packages/${{ matrix.package }}/playwright-report/
          retention-days: 7
```

**这里要留意的两件事**：

- `pnpm --filter <name> run <script>` 要求该包确实有这个脚本。三个包的 `typecheck`/`test`/`build`/`pub:check` 都存在（已逐份核对）；但 `test:e2e` **只有 PTK 有**，所以 e2e 用显式 matrix 而不是 `-r`。
- 根级 `oxlint .` 会连 `*.config.ts`、`test-e2e/`、`test/harness/` 一起检查。PTK 原来传的正是这些路径，CSC/CTK 原来只传 `src test`——**范围扩大后可能出现新告警**，在阶段 A 一并处理干净（或按包加 `.oxlintrc.json` 局部豁免）。

### 4.4 阶段 B 验收

- [ ] 在一个测试 tag（如 `cross-tab-kit@0.4.1-preflight`，或用 `workflow_dispatch` 临时加）上跑通 release 全流程，但**不发真包**（把 publish 换成 `pnpm -r publish --dry-run --no-git-checks` 先验一次）
- [ ] `pnpm -r publish --dry-run --no-git-checks` 打印出的每个包内容与预期一致（尤其 PTK 的 `dependencies` 是 `{"cross-tab-kit":"0.4.0"}`）
- [ ] 故意推一个 tag 与 `package.json` 不一致 → workflow 报错退出
- [ ] 故意把 `changeset` 从某个 PR 里删掉 → `hygiene` job 报红
- [ ] 用一个 dependabot 风格的 PR（actor 为 bot）验证 changeset 门禁被豁免（这是漂移 #1 的回归测试）

---

## 5. 阶段 C：去重（**独立提交、独立 changeset**）

D8 要求这一阶段与搬迁分开。它按收益排序有两条，且**第二条要克制**。

### 5.1 CSC 复用 CTK 的锁（收益最大，但不是 drop-in）

现状对比：

| | `cross-tab-kit/src/locks/tab-lock.ts` | `cross-sqlite-client/src/adapters/web.ts` 的 `tryAcquireTabLock` |
| --- | --- | --- |
| 用例数 | **27** | **2** |
| 等待语义 | `waitTimeoutMs` **必填**（"无界等待是一个 tab 的挂起操作静默拖住所有同名等待者，所以这个取舍必须由调用方显式做出"），传 `Infinity` 才是无界 | 只有"不排队、立刻返回 null"一种 |
| 操作超时 | `timeoutMs` + `ctx.timeoutSignal`（超时后释放锁，且**注释明说**"超时后互斥会短暂破裂，操作副作用应幂等"） | 无 |
| 诊断 | 同名嵌套调用的死锁诊断、`SHORT_TTL_WARN_MS`/`SLOW_WAIT_WARN_MS` 告警 | 无 |
| 定时器 | `setChainedTimeout` 处理 `> 24.8 天` 的 `setTimeout` 溢出 | 无 |
| 降级路径 | 有，且注释说明 | 有（返回 no-op），但**没有任何运行时信号** |

**但它不是 drop-in 替换。** CTK 的 API 是**操作作用域**的：

```ts
withTabLock(name, operation, { waitTimeoutMs })   // 锁在 operation 期间持有
tryWithTabLock(name, operation, opts)             // 不排队版本
```

而 CSC 需要的是**连接生命周期**的锁（`initialize()` → `close()`），跨度远大于一个回调。所以要么：

- **(a) CTK 新增一个 handle 式 API**（推荐）：

  ```ts
  /** 取到锁返回一个 release；另一个 tab 持有时返回 null（不排队）。 */
  acquireTabLock(name: string, options?: { signal?: AbortSignal }): Promise<{ release(): void } | null>
  ```

  这正好能覆盖 CSC 现在那 20 行实现的语义，并且顺带得到 CTK 的降级诊断与用例覆盖。

- **(b) 把连接生命周期表达成回调作用域**：`withTabLock(name, async () => { ...整个应用生命周期... })`——侵入性太大，不推荐。

**(a) 恰恰说明了合仓的价值**：CTK 已经有一个先例文档 `docs/requirements-from-pending-task-kit.md`，说明"下游需求反向推上游 API"这种事确实会发生；跨两个仓库做这个 API 演进要走"提需求 → 改 CTK → 发版 → PTK 升级"的完整往返，同仓内就是一次 PR。

**同时要把 §5.1 表里最后一行一起解决**：CSC 的降级路径（无 Web Locks 时返回 no-op `() => {}`）目前**没有任何运行时信号**，而 `navigator.locks` 的存在与否恰好决定"单标签页独占"这个承诺是否成立。合并到 CTK 后应统一走 CTK 的 `Logger`（`warn`）——CTK 的 kernel 里已经有 `resolveLogger`。

### 5.2 收敛三份 kernel 代码（要克制）

实测到的重复：

| 概念 | CTK | PTK | CSC |
| --- | --- | --- | --- |
| `Logger` | `{ warn }`（`src/kernel/logger.ts`） | `{ warn }`（各自定义） | `{ warn, error, ...args }` |
| 毫秒参数校验（`assertPositiveFiniteMs`） | `assertPositiveFiniteMs` | 内联 `Number.isFinite && > 0` | `assertIdentifier` 家族 |
| 安全存储 | `src/kernel/safe-storage.ts` | 用 CTK 的 | 无 |

**收敛时的两条约束**（否则会以"统一"为名降低质量）：

1. **不要为了统一把 CSC 的 `Logger` 削成 `{ warn }`，也不要把共享接口定成 `{ warn, error }`。** 已用 `tsc --strict` 实测过赋值方向：`{ warn, error }` **可以**赋给 `{ warn }`，反之**不行**（`@ts-expect-error` 断言成立）。所以正确做法是：

   - **共享原语只依赖最小接口 `{ warn }`**（也就是 CTK 现在这个）——CSC 那个更丰富的 `{ warn, error, ...args }` 天然满足它，不需要适配器；
   - **CSC 继续对外暴露它自己的富 `Logger`**（README 里"传 logger 来检测内存降级"的建议正是依赖 `warn`，而 `error` 有实际用途）；
   - 反过来如果把共享接口定成 `{ warn, error }`，就会**收紧 CTK/PTK 的公开 API**——现有只传 `{ warn }` 的调用方会直接编译失败，这是一次没有必要的破坏性变更。

  结论：**不需要统一签名，只需要保证"共享原语只依赖最小接口"**。
2. **不要为了统一把 CSC 的 fail-fast 改成"回退默认值"。** CSC 在构造期对非法标识符/PRAGMA/版本号**抛错**是对的（配置错误就该早失败）；PTK/CTK 对"调用方传进来的运行时数值"才回退。两者判断一致，不要互相污染。

**建议的最小动作**：只把 `safe-storage` 与 `assertPositiveFiniteMs` 这两块真正无争议的原语上移到共享位置（或让 CSC 依赖 CTK 的 `/advanced` 导出），`Logger` 的签名问题单独立一个 changeset 讨论。宁可少做，不要做错。

**论证 1 的实测片段**（确认"共享原语只依赖最小接口"在编译期成立，必要时可复制此文件复跑）：

```ts
// /tmp/logger-typing.ts
type SharedLogger = { warn: (msg: string) => void };
type RichLogger = SharedLogger & { error: (msg: string) => void };

declare const rich: RichLogger;
declare const shared: SharedLogger;

// 这两行就是"反向断言"——编译过即可证
const ok: SharedLogger = rich;       // ✓
const bad: RichLogger = shared;      // ✗ TS2322：Type 'SharedLogger' is not assignable to 'RichLogger'.
```

```bash
cd /tmp && npx -y tsc@5.6 --strict logger-typing.ts --noEmit
# 实际输出：logger-typing.ts(8,1): error TS2322 ...
```

### 5.3 明确不做

- 不统一测试环境（D6）。
- 不为"一致"把 CSC 的 `tsconfig` 降级（D5 是**升级**方向）。
- 不引入 Turborepo/Nx。
- 不改包名、不加 scope（D1）。

---

## 6. 可观察行为变化（必须写进 changeset / 发布说明）

| 变化 | 使用者能观察到吗 | 处理 |
| --- | --- | --- |
| `repository` / `homepage` / `bugs` 指向新仓 | 能（npm 页面、provenance 链接） | 每个包一个 `patch` changeset，说明"仅元数据变更，无 API/行为变化" |
| PTK 的 `cross-tab-kit` 依赖写法 `"0.4.0"` → `workspace:*` | **不能**（§1.3 已实测：tarball 里仍是精确 `0.4.0`） | 在 changeset 里明确写"发布产物不变" |
| CTK 的 `publishConfig`、CSC 的 `main`/`module`/`types` 对齐 | 对 CSC 是**新增字段**（更兼容旧解析器），对 CTK 无变化 | CSC 记 `patch` |
| `engines` / `packageManager` 位置调整 | 基本不能 | 无需 changeset（除非实际数值变化） |
| 阶段 C 的锁切换（若采纳） | **能**——等待语义/超时行为可能变化 | 必须 `minor` + 明确的 migration 说明；CSC 的 README「多标签页协调」一节要同步改写 |
| 阶段 C 的 `Logger` 签名变化（若采纳） | 能（类型层面） | `minor`（或 0.x 下的 `minor`，按 `CHANGELOG` 已有的"pre-1.0 下 minor 可含破坏性变更"惯例说明） |

---

## 7. 验证清单（可逐条执行）

**最关键的一条：tarball 逐项对比。** 在搬迁**之前**，先在三个旧仓各自 `pnpm pack` 存档：

```bash
# 迁移前（三个旧仓各做一次）
cd ~/projects/frontend/<pkg> && pnpm install --frozen-lockfile && pnpm pack --pack-destination /tmp/before
# 迁移后（新仓）
cd web-kits/packages/<pkg> && pnpm pack --pack-destination /tmp/after
# 对比文件清单
for d in before after; do for t in /tmp/$d/*.tgz; do echo "== $t"; tar -tzf "$t" | sort; done; done > /tmp/filelists.txt
diff <(tar -tzf /tmp/before/*.tgz | sort) <(tar -tzf /tmp/after/*.tgz | sort)
# 对比 package.json（尤其是 dependencies 的版本范围与 files/main/types/exports）
diff <(tar -xzOf /tmp/before/*.tgz package/package.json) <(tar -xzOf /tmp/after/*.tgz package/package.json)
```

清单里要确认的项：

- [ ] **`package/LICENSE` 仍在**（§2 的警告：只放根级会丢）
- [ ] `package/package.json` 的 `dependencies` 仍是 `{"cross-tab-kit":"0.4.0"}`（精确，非 `^`）
- [ ] `package/README.md`、`package/README.zh-CN.md` 仍在
- [ ] `dist/` 的文件清单与入口与迁移前一致（尤其 CSC 的 5 个子路径）
- [ ] `repository.directory` 已指向 `packages/<pkg>`

**其余各项**：

```bash
# 1. 全新克隆能否装起来
git clone web-kits /tmp/fresh && cd /tmp/fresh && pnpm install --frozen-lockfile

# 2. 全部质量门
pnpm lint && pnpm format:check && pnpm -r run typecheck && pnpm -r run test \
  && pnpm -r run build && pnpm -r run pub:check

# 3. 用例总数必须等于 255（117 + 93 + 45）
pnpm -r run test 2>&1 | grep -E "Tests +[0-9]+ passed"

# 4. e2e（最容易被打坏的一环）
pnpm --filter pending-task-kit run test:e2e

# 5. 发布预演
pnpm -r publish --dry-run --no-git-checks

# 6. 历史与 tag
git log --oneline | wc -l          # 应 ≈ 39 + 若干搬迁提交
git tag | sort                     # 应为 <pkg>@<version> 形式，无裸 vX.Y.Z
```

**e2e 为什么最容易坏**：PTK 的 `test-e2e/fixture.ts` 故意 import `../dist/index.js`（构建产物冒烟测试），而 `dist/index.js` 内部又是裸导入 `zustand`/`zustand/middleware`。`playwright.config.ts` 用 vite dev server 是为了让这些裸说明符能解析。从单包仓搬进 monorepo 后，`zustand` 会落在 `packages/pending-task-kit/node_modules/` 下的符号链接里——**必须实测确认仍能解析**，而不是假设。同时确认 `webServer.command` 的 root 仍指向包目录（而不是 monorepo 根）。

---

## 8. 回滚与不可逆点

| 不可逆 / 高风险 | 说明 | 对策 |
| --- | --- | --- |
| **npm 发布不可撤销** | 已发布的版本号永久占用，只能发新版本 | 发布前一律 `pnpm -r publish --dry-run`；第一个正式发布先用一个 `-preflight` tag 走完整流程 |
| **旧仓库若删除，CHANGELOG 的 8 处哈希永久失效** | §3.2 | 只 archive，不删；新仓 CHANGELOG 顶部加迁移说明 |
| **tag 命名迁移** | 旧 tag 是 `vX.Y.Z`，新 tag 是 `<pkg>@<version>` | 旧仓 tag 原样保留（在旧仓里仍可 checkout）；新仓只用新命名 |
| **PTK 依赖 CTK 的发布顺序** | CTK 未发布时 PTK 无法发 | §4.2 的 preflight 把它变成明确报错 |
| 消费者 lockfile | `workspace:*` 不改写发布产物，故消费者侧无感 | §7 的 tarball 对比是这一条的证据 |

**回滚方式**：三个旧仓库保持可发布状态，直到新仓**成功发布过至少一个真正的包版本**。在此之前，任何问题都可以"放弃新仓、继续在旧仓开发"。

---

## 9. 实施顺序与时间盒

| 阶段 | 内容 | 时间盒 | 出口条件 |
| --- | --- | --- | --- |
| **A1** | 建仓、根骨架、搬历史、tag 重命名 | 0.5 天 | 三个包的历史与 tag 都在新仓，`pnpm install` 通过 |
| **A2** | 每包 `package.json` 字段调整（含 `workspace:*`）、`tsconfig` extends、顺手清掉 §3.5 的 6 处漂移、`pnpm lint` 范围扩大后的告警清理 | 1 天 | §3.6 全部验收项通过；**无任何版本号变化**；无行为改动 |
| **B** | `ci.yml` + `release.yml` + `dependabot.yml`；dry-run publish；preflight 脚本 | 0.5 天 | §4.4 全部验收项通过 |
| **B'** | 用一次真实的 `patch` 发布验证完整发布链路（建议拿 `cross-tab-kit` 试，它依赖最少） | 0.5 天 | 新仓发布出的 tarball 与旧仓逐项一致 |
| **C1** | CTK 新增 `acquireTabLock` handle API（+ 用例） | 1 天 | CTK 自己的用例覆盖新 API 的取锁/释放/降级路径 |
| **C2** | CSC 切到 CTK 的锁，删除本地 `tryAcquireTabLock` | 1 天 | CSC 用例不减；web 适配器的降级路径有运行时信号 |
| **C3** | `safe-storage` / `assertPositiveFiniteMs` 收敛；`Logger` 签名单独决策 | 0.5 天 | 三包测试全绿；`Logger` 的决策有 changeset 记录 |

**总计约 5 天**，其中 A 阶段（纯搬迁 + 骨架统一）约 1.5 天，是收益/风险比最好的部分；C 阶段才是真正的代码改动。

---

## 附录 A：迁移前必须处理的 6 处漂移（速查）

1. CSC `ci.yml` 的 changeset 门禁补 `&& github.actor != 'dependabot[bot]'`
2. 补 `cross-tab-kit/.github/dependabot.yml`
3. CI 步骤顺序统一为 `build → pub:check → typecheck → lint → format:check → test`（并写明理由）
4. `publishConfig`（CTK）与 `main`/`module`/`types`（CSC）三包对齐
5. 补 `.changeset/README.md`
6. 评审文档归位到 `docs/<pkg>/`（CTK 8 篇 + PTK 4 篇）

## 附录 B：本次实测得到的可直接复用的事实

| 事实 | 值 |
| --- | --- |
| `workspace:*` 发布后 | 精确版本 `1.2.3`（**无 `^`**）→ PTK 现有精确 pin 语义可原样保留 |
| `workspace:^` / `workspace:~` | `^1.2.3` / `~1.2.3` |
| 三份 LICENSE | md5 全同 `55166e9b8c3779c2c556258f68e50535` |
| 三份 `.oxfmtrc.json` / `.changeset/config.json` | 逐字节相同 |
| CTK 与 PTK 的 `tsconfig.json` | 逐字节相同（PTK 仅多 `jsx`） |
| PTK 与 CSC 的 `dependabot.yml` | 逐字节相同 |
| 用例总数 | 117（CTK）+ 93（PTK，另 3 Playwright）+ 45（CSC）= 255 |
| commit 总数 | 10 + 19 + 10 = 39 |
| 跨仓撞名的 tag | `v0.2.0`（PTK ∩ CSC）、`v0.4.0`（CTK ∩ PTK） |
| CHANGELOG 中会失效的哈希 | `04d226a` `58fc7f9` `7d526f3` `9515234` `a27fa88` `d955de3` `e34ae40` `ffe69a5` |
| Node / pnpm | local 24.21.0 / 11.7.0；三包 `engines: >=24`、`packageManager: pnpm@11.5.2` |

## 附录 C：一句话总结

**合仓值得做，但重心不是"骨架只写一次"（`tsconfig.base.json` / `.oxfmtrc.json` / `.changeset/config.json` / `LICENSE` / `engines` 等多份配置本来就已经逐字节相同——共享骨架这部分价值有限），而是"消掉三份已经分叉的 kernel 代码 + 让 CTK 那份 27 用例的锁原语能被 CSC 复用 + 让同源配置不再各自腐烂"。** 执行时守两条纪律就够：**搬迁与重构分两个批次**（先得到"结构变了但行为没变、测试全绿、无版本变动"的提交），以及**把 tag 触发模型换成 per-package tag 并配一条发布顺序规则**——后者是合仓最容易被忽略、又最容易在第一次发版时踩到的后果。
