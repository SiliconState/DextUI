import { mergeConfig } from "vite";
import base from "../vite.config";

// Browser-only fixture entry, deliberately absent from production builds.
export default mergeConfig(base, {
  plugins: [{
    name: "header-review-fixture",
    transformIndexHtml: { order: "pre", handler(html: string) { return html.replace('/src/main.ts', '/scripts/header-review-entry.ts'); } },
  }],
  build: { outDir: "dist.header-review", emptyOutDir: true },
});
