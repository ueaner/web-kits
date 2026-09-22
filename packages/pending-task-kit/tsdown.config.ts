import { defineConfig } from "tsdown"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    react: "src/react.ts",
  },
  format: "esm",
  dts: true,
  clean: true,
  platform: "neutral",
  external: ["react", "zustand", "zustand/middleware"],
})
