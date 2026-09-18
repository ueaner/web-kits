import { defineConfig } from "@playwright/test"

/** This project has no `@types/node` (same reasoning as `test/engine.test.ts`'s narrow
 *  `declare const process` — it never otherwise touches Node APIs) — declared narrowly here too
 *  rather than pulling in the whole package just for this one env var read. */
declare const process: { env: { CI?: string } }

export default defineConfig({
  testDir: "./test-e2e",
  // These tests race two/three real tabs against each other over a shared localStorage key —
  // running them in parallel with each other (or retrying flakily) would make failures
  // ambiguous, so keep this suite small, sequential, and deterministic instead.
  fullyParallel: false,
  workers: 1,
  webServer: {
    // Serves the whole project root (not just test-e2e/) so fixture.ts's `../dist/index.js`
    // import, and dist/index.js's own `zustand`/`zustand/middleware` bare imports, all resolve
    // against this project's real node_modules — a bundler-free Vite dev server transparently
    // resolves bare specifiers for any file in its module graph, regardless of whether that
    // file lives in test-e2e/, dist/, or elsewhere under the project root.
    command: "pnpm exec vite --port 4173 --strictPort",
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: "http://localhost:4173",
  },
})
