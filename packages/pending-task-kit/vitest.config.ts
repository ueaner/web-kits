import { configDefaults, defineConfig } from "vitest/config"

// 与 tsconfig.json 的 `paths` 保持同一口径：单测把 `cross-tab-kit` 解析到**源码**，
// 因此不需要先构建依赖包（tsc 走 tsconfig 的 paths，vitest/vite 不读 tsconfig，
// 必须在这里显式声明，否则它会退回 node_modules → packages/cross-tab-kit/dist，
// 于是一个干净的 clone 上 `pnpm test` 会以 "Failed to resolve import" 全红）。
//
// 注意顺序：更具体的子路径必须排在前面。"cross-tab-kit/advanced" 若排在
// "cross-tab-kit" 之后，会被后者按 `/` 前缀先匹配掉，拼成 .../index.ts/advanced。
//
// 构建产物那一侧仍由 test-e2e/ 覆盖（fixture.ts 故意 import ../dist/index.js），
// 所以"源码级单测 + 产物级 e2e"这一分工不变。
const crossTabKitSrc = (file: string): string => new URL(`../cross-tab-kit/src/${file}`, import.meta.url).pathname

export default defineConfig({
  resolve: {
    alias: {
      "cross-tab-kit/advanced": crossTabKitSrc("advanced.ts"),
      "cross-tab-kit": crossTabKitSrc("index.ts"),
    },
  },
  test: {
    environment: "jsdom",
    // test-e2e/ holds Playwright specs (a different `test()` global) — Vitest's default glob
    // would otherwise pick those up too and collide with Playwright's own test runner.
    exclude: [...configDefaults.exclude, "test-e2e/**"],
  },
})
