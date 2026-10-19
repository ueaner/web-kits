import { defineConfig } from "vitest/config"

// 与适配器无关的用例（见 test/helpers/test-adapter.ts）在 memory 和 miniprogram 两个适配器上各跑一遍
const SHARED = ["test/client.test.ts", "test/migrate.test.ts", "test/observe.test.ts"]

export default defineConfig({
  test: {
    environment: "node",
    projects: [
      { extends: true, test: { name: "memory", provide: { testAdapter: "memory" } } },
      { extends: true, test: { name: "miniprogram", include: SHARED, provide: { testAdapter: "miniprogram" } } },
    ],
  },
})
