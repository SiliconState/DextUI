import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Build identity: stamped into the SW registration URL so each build gets its
// own `dextui-<id>` cache (see public/sw.js, which deletes stale ones).
const BUILD_ID = Date.now().toString(36);

export default defineConfig({
  plugins: [
    svelte(),
    // `dist/build-id.txt`: the served build's identity, read by agentlinkd's
    // self-edit adapter (scripts/ui-build.mjs distVersion) and compared with
    // the page's own __BUILD_ID__ to offer "reload" only when they differ.
    {
      name: "dextui-build-id",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "build-id.txt", source: BUILD_ID });
      },
    },
  ],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "http://127.0.0.1:8787", ws: true },
    },
  },
});
