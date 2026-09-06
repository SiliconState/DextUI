#!/usr/bin/env node
// Build a pack's `ui/panel.ts` into `ui/panel.html`: a self-contained page
// (palette shell + bundled script + `window.__PACK_DATA__` placeholder) the
// Rust runtime copies into the session folder with live data injected.
// Zero dependencies beyond the repo toolchain's esbuild.
// Usage: node packs/scripts/build-panel.mjs <pack-dir> [--check]
import { buildSync } from "esbuild";
import fs from "node:fs";
import path from "node:path";

export const DATA_MARKER = "@@PACK_DATA@@";

/** The shell every panel shares: DextUI palette (dark-first, honors the
 *  frame's color scheme), no external requests, opaque origin in DextUI's
 *  sandbox. `DATA_MARKER` is replaced by the Rust runtime with JSON escaped
 *  for an inline script context. */
export function shell({ title, js }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root{color-scheme:dark light}
*{box-sizing:border-box}
body{margin:0;padding:16px 18px;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#0d1117;color:#e6edf3}
h2{font-size:15px;margin:0;color:#e6edf3}
h3{font-size:12px;margin:14px 0 6px;color:#79c0ff;text-transform:uppercase;letter-spacing:.04em}
.muted{color:#8b949e;margin:2px 0 0}
.err{color:#ff7b72}
.head{display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap;border-bottom:1px solid #30363d;padding-bottom:8px;margin-bottom:8px}
.total{font-size:20px;font-weight:700;color:#3fb950;font-variant-numeric:tabular-nums}
.bars{width:100%;max-width:640px;height:auto;display:block}
.bar-label{fill:#c9d1d9;font-size:11px}
.bar-value{fill:#8b949e;font-size:11px;font-variant-numeric:tabular-nums}
.bar-track{fill:#21262d}
.bar-fill{fill:#1f6feb}
table{border-collapse:collapse;width:100%;font-size:12px}
th,td{padding:3px 8px;border-bottom:1px solid #30363d;text-align:left;white-space:nowrap}
th{color:#79c0ff;cursor:pointer;user-select:none;position:sticky;top:0;background:#0d1117}
.num{text-align:right;font-variant-numeric:tabular-nums}
tbody tr:hover{background:#161b22}
section{margin-bottom:6px}
@media (prefers-color-scheme: light){
  body{background:#ffffff;color:#1f2328}
  h2{color:#1f2328}
  .muted{color:#59636e}
  .head{border-color:#d1d9e0}
  .bar-track{fill:#eaeef2}
  .bar-label{fill:#1f2328}
  .bar-value{fill:#59636e}
  th,td{border-color:#d1d9e0}
  th{background:#ffffff;color:#0969da}
  tbody tr:hover{background:#f6f8fa}
}
</style></head>
<body><div id="app"></div>
<script>window.__PACK_DATA__ = ${DATA_MARKER};</script>
<script>${js}</script>
</body></html>`;
}

export function buildPanel(packDir, { minify = true } = {}) {
  const entry = path.join(packDir, "ui", "panel.ts");
  if (!fs.existsSync(entry)) return { built: false, reason: "no ui/panel.ts" };
  const title = path.basename(packDir);
  const result = buildSync({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    target: "es2020",
    platform: "browser",
    write: false,
    minify,
    logLevel: "silent",
  });
  const js = result.outputFiles[0].text;
  if (js.includes("document.currentScript") || /src\s*=\s*["']https?:/.test(js)) throw new Error("panel bundle references external resources");
  const html = shell({ title: `${title} — panel`, js });
  fs.mkdirSync(path.join(packDir, "ui"), { recursive: true });
  const out = path.join(packDir, "ui", "panel.html");
  fs.writeFileSync(out, html);
  return { built: true, out, bytes: html.length, marker: html.includes(DATA_MARKER) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: build-panel.mjs <pack-dir>");
    process.exit(2);
  }
  const r = buildPanel(path.resolve(dir));
  if (!r.built) process.exit(0);
  console.log(`panel -> ${r.out} (${r.bytes} bytes)${r.marker ? "" : " [warning: data marker missing]"}`);
}
