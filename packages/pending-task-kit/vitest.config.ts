import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "jsdom",
    // test-e2e/ holds Playwright specs (a different `test()` global) — Vitest's default glob
    // would otherwise pick those up too and collide with Playwright's own test runner.
    exclude: [...configDefaults.exclude, "test-e2e/**"],
  },
})
