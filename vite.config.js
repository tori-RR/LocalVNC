import { defineConfig } from "vite";
import fs from "node:fs";
import { patchNovncBrowser } from "./scripts/novnc-compat.mjs";

export default defineConfig({
  root: "src",
  clearScreen: false,
  plugins: [
    {
      name: "novnc-browser-fix",
      enforce: "pre",
      load(id) {
        const normalized = id.replaceAll("\\", "/");
        if (!normalized.endsWith("/@novnc/novnc/lib/util/browser.js")) return null;
        return patchNovncBrowser(fs.readFileSync(id, "utf8"));
      },
    },
  ],
  optimizeDeps: {
    esbuildOptions: {
      plugins: [{
        name: "novnc-browser-fix",
        setup(build) {
          build.onLoad({ filter: /[\\/]@novnc[\\/]novnc[\\/]lib[\\/]util[\\/]browser\.js$/ }, (args) => ({
            contents: patchNovncBrowser(fs.readFileSync(args.path, "utf8")), loader: "js",
          }));
        },
      }],
    },
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "esnext",
  },
});
