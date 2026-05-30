// electron-vite config:
//   - main:    Trove's Electron main process (electron/main.ts)
//   - preload: IPC bridge (electron/preload.ts)
//   - renderer: NOT managed here. The renderer is loaded by Electron via
//     loadURL() pointing at the admin server (Express, serves ui/dist).
//     This matches the packaged architecture exactly: admin owns the
//     web layer, Electron owns native + lifecycle.

import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "electron/.dist/main",
      rollupOptions: {
        input: { index: resolve(__dirname, "electron/main.ts") },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "electron/.dist/preload",
      rollupOptions: {
        input: { index: resolve(__dirname, "electron/preload.ts") },
        // The repo's package.json has "type": "module"; force a .cjs file
        // extension so Node treats the preload as CommonJS unconditionally.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
});
