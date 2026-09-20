import { defineConfig } from "tsdown"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    advanced: "src/advanced.ts",
  },
  format: "esm",
  dts: true,
  clean: true,
  platform: "neutral",
})
