import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Build identity: stamped into the SW registration URL so each build gets its
// own `dextui-<id>` cache (see public/sw.js, which deletes stale ones).
const BUILD_ID = Date.now().toString(36);

export default defineConfig({
  plugins: [svelte()],
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
