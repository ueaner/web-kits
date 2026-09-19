import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    "core/index": "src/core/index.ts",
    "adapters/web": "src/adapters/web.ts",
    "adapters/tauri": "src/adapters/tauri.ts",
    "adapters/memory": "src/adapters/memory.ts",
    "react/index": "src/react/index.ts",
  },
  format: "esm",
  dts: true,
  clean: true,
  platform: "neutral",
});
