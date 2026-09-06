// Self-edit adapter for agentlinkd: lets DextUI rebuild and restart itself
// safely, whether the change came from a human (Finder / slash) or from the
// agent in a workbench session (bash → scripts/ui-build.mjs, request file).
//
// Contract with the host:
//   - build(): runs scripts/ui-build.mjs (staged build, atomic swap, LKG),
//     one at a time, and streams progress through `broadcast`.
//   - watchDist(): notices *any* swap of apps/web/dist — including one the
//     agent performed itself — and broadcasts `ui.rebuilt` so tabs reload.
//   - restart: refuses while turns/crews/builds are live unless forced;
//     a pending request (command, slash, or `<state>/restart.request` written
//     by the agent) is honored at the next idle boundary via `tick()`.
//   - resolveStaticDir(): `--safe` or a missing dist/index.html serves the
//     last-known-good build instead of nothing.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildable, distPaths, distVersion, rollbackDist } from "../scripts/ui-build.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const BUILD_SCRIPT = path.join(here, "..", "scripts", "ui-build.mjs");
/** Exit status meaning "restart me": non-zero so systemd `Restart=on-failure` honors it. */
export const RESTART_EXIT_CODE = 75;
export const RESTART_REQUEST_FILE = "restart.request";
const BUILD_TIMEOUT_MS = 20 * 60_000;
const TAIL_CHARS = 4000;
const DIST_DEBOUNCE_MS = 400;

/** Where the app is served from at boot. Returns `{ dir, mode }` with mode
 *  `dist` | `lkg` | `missing`. `--safe` prefers the LKG when it exists. */
export function resolveStaticDir({ staticDir, repoRoot, safe = false }) {
  const { dist, lkg } = distPaths(repoRoot);
  const isRepoDist = path.resolve(staticDir) === dist;
  const has = (d) => fs.existsSync(path.join(d, "index.html"));
  if (isRepoDist) {
    if (safe && has(lkg)) return { dir: lkg, mode: "lkg" };
    if (has(dist)) return { dir: dist, mode: "dist" };
    if (has(lkg)) return { dir: lkg, mode: "lkg" };
    return { dir: dist, mode: "missing" };
  }
  return { dir: path.resolve(staticDir), mode: has(staticDir) ? "dist" : "missing" };
}

/** Parse a restart request file: `{ reason?, by? }` JSON or free text. */
export function parseRestartRequest(text) {
  const t = String(text ?? "").trim().slice(0, 2000);
  if (!t) return { reason: "", by: "file" };
  try {
    const v = JSON.parse(t);
    if (v && typeof v === "object") {
      return { reason: typeof v.reason === "string" ? v.reason.slice(0, 200) : "", by: typeof v.by === "string" ? v.by.slice(0, 40) : "file" };
    }
  } catch {
    /* free text */
  }
  return { reason: t.slice(0, 200), by: "file" };
}

export function createSelfEdit({ repoRoot, stateDir, staticDir, broadcast, isIdle, busyDetail, onRestart, log = () => {} }) {
  const enabled = buildable(repoRoot);
  const { dist, lkg } = distPaths(repoRoot);
  const servingRepoDist = path.resolve(staticDir) === dist || path.resolve(staticDir) === lkg;
  let building = null; // { id, started_at, step, steps_total, tail }
  let last = null; // last build summary
  let restartPending = null; // { reason, by, at }
  let buildSeq = 0;
  let distTimer = null;
  let lastVersion = distVersion(dist)?.id ?? null;
  let watcher = null;

  /** Compact summary for hello_ok / GET /__self: tails trimmed, steps reduced to labels. */
  function status() {
    const brief = last
      ? { ok: last.ok, id: last.id, at: last.at, by: last.by, error: last.error, failed: last.failed, rolled_back: last.rolled_back, duration_ms: last.duration_ms, version: last.version,
          steps: Array.isArray(last.steps) ? last.steps.map((s) => ({ label: s.label, ok: s.ok, duration_ms: s.duration_ms })) : undefined,
          tail: typeof (last.tail ?? last.message) === "string" ? String(last.tail ?? last.message).slice(-1200) : undefined }
      : null;
    return {
      enabled,
      repo: repoRoot,
      static: path.resolve(staticDir),
      serving: path.resolve(staticDir) === lkg ? "lkg" : "dist",
      version: distVersion(path.resolve(staticDir)),
      lkg: fs.existsSync(path.join(lkg, "index.html")) ? distVersion(lkg) : null,
      building: building ? { id: building.id, started_at: building.started_at, step: building.step, by: building.by } : null,
      last: brief,
      restart_pending: restartPending,
      restart_exit_code: RESTART_EXIT_CODE,
      build_script: path.relative(repoRoot, BUILD_SCRIPT),
      request_file: path.join(stateDir, RESTART_REQUEST_FILE),
    };
  }

  /** Start a build. Resolves with the summary; rejects nothing (errors are data). */
  function build({ check = true, tests = false, by = "host" } = {}) {
    if (!enabled) return Promise.resolve({ ok: false, error: "not_buildable" });
    if (building) return Promise.resolve({ ok: false, error: "busy", message: `build ${building.id} already running (${building.step})` });
    const id = `b${++buildSeq}-${Date.now().toString(36)}`;
    building = { id, started_at: Date.now(), step: "start", steps_total: 0, tail: "", by };
    broadcast("x-agentlinkd.ui.build", { id, phase: "start", by, check, tests });
    const args = [BUILD_SCRIPT, `--repo=${repoRoot}`, "--json", ...(check ? [] : ["--no-check"]), ...(tests ? ["--tests"] : [])];
    return new Promise((resolve) => {
      let stdout = "";
      let child;
      const finish = (summary) => {
        building = null;
        last = { ...summary, id, at: Date.now(), by };
        if (summary.ok) {
          lastVersion = summary.version?.id ?? lastVersion;
          broadcast("x-agentlinkd.ui.build", { id, phase: "ok", duration_ms: summary.duration_ms, version: summary.version });
          broadcast("x-agentlinkd.ui.rebuilt", { version: summary.version, by, build: id });
        } else {
          broadcast("x-agentlinkd.ui.build", { id, phase: "fail", error: summary.error, failed: summary.failed, tail: (summary.tail ?? summary.message ?? "").slice(-TAIL_CHARS) });
        }
        resolve(last);
      };
      try {
        child = spawn(process.execPath, args, { cwd: repoRoot, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        finish({ ok: false, error: "spawn_failed", message: String(err) });
        return;
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), BUILD_TIMEOUT_MS);
      child.stdout.on("data", (d) => {
        stdout = (stdout + d.toString("utf8")).slice(-200_000);
      });
      child.stderr.on("data", (d) => {
        const text = d.toString("utf8");
        building.tail = (building.tail + text).slice(-TAIL_CHARS);
        // The script prints `[ui-build] n/total label` per step only in text
        // mode; with --json we infer progress from tool banners instead.
        const m = /> @dextui\/(\w+)@|svelte-check|vite v/.exec(text);
        if (m) {
          const step = m[1] ?? (text.includes("svelte-check") ? "svelte-check" : "vite");
          if (step !== building.step) {
            building.step = step;
            broadcast("x-agentlinkd.ui.build", { id, phase: "step", step });
          }
        }
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        finish({ ok: false, error: "spawn_failed", message: String(err) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        let summary = null;
        const line = stdout.trim().split("\n").reverse().find((l) => l.startsWith("{"));
        if (line) {
          try {
            summary = JSON.parse(line);
          } catch {
            /* fallthrough */
          }
        }
        if (!summary) summary = { ok: code === 0, error: code === 0 ? undefined : "no_summary", tail: building?.tail ?? "", message: `ui-build exited ${code}` };
        finish(summary);
      });
    });
  }

  function rollback({ by = "host" } = {}) {
    if (!enabled) return { ok: false, error: "not_buildable" };
    if (building) return { ok: false, error: "busy", message: "a build is running" };
    try {
      const version = rollbackDist(repoRoot);
      lastVersion = version?.id ?? lastVersion;
      last = { ok: true, rolled_back: true, version, at: Date.now(), by };
      broadcast("x-agentlinkd.ui.rebuilt", { version, by, rolled_back: true });
      return last;
    } catch (err) {
      return { ok: false, error: "rollback_failed", message: String(err?.message ?? err) };
    }
  }

  /** Detect swaps performed outside `build()` (the agent ran the script). */
  function noticeDist() {
    clearTimeout(distTimer);
    distTimer = setTimeout(() => {
      if (building) return; // build() announces its own result
      const v = distVersion(dist);
      if (v && v.id !== lastVersion) {
        lastVersion = v.id;
        log(`ui rebuilt outside the host (build ${v.id})`);
        broadcast("x-agentlinkd.ui.rebuilt", { version: v, by: "external" });
      }
    }, DIST_DEBOUNCE_MS);
  }

  function watchDist() {
    if (!enabled || !servingRepoDist) return;
    const web = path.dirname(dist);
    try {
      watcher = fs.watch(web, { persistent: false }, (_ev, name) => {
        if (name === "dist" || name === "dist.staging" || name === "dist.lkg") noticeDist();
      });
      watcher.on("error", () => {});
    } catch (err) {
      log(`not watching ${web}: ${err.message}`);
    }
  }

  // ---------- restart ----------

  function requestFile() {
    return path.join(stateDir, RESTART_REQUEST_FILE);
  }

  /** Queue a restart. Immediate when idle; otherwise honored by tick(). */
  function requestRestart({ reason = "", by = "host", force = false } = {}) {
    if (restartPending) return { ok: true, pending: true, already: true, ...restartPending };
    restartPending = { reason: String(reason).slice(0, 200), by, at: Date.now() };
    broadcast("x-agentlinkd.host.restart", { phase: "pending", ...restartPending, busy: !isIdle() ? busyDetail() : null, force });
    if (force || isIdle()) {
      doRestart();
      return { ok: true, pending: false, ...restartPending };
    }
    return { ok: true, pending: true, ...restartPending, busy: busyDetail() };
  }

  function cancelRestart() {
    if (!restartPending) return false;
    restartPending = null;
    try { fs.rmSync(requestFile(), { force: true }); } catch { /* best effort */ }
    broadcast("x-agentlinkd.host.restart", { phase: "cancelled" });
    return true;
  }

  function doRestart() {
    const req = restartPending ?? { reason: "", by: "host", at: Date.now() };
    try { fs.rmSync(requestFile(), { force: true }); } catch { /* best effort */ }
    broadcast("x-agentlinkd.host.restart", { phase: "restarting", ...req, exit_code: RESTART_EXIT_CODE });
    log(`restarting (exit ${RESTART_EXIT_CODE}) — ${req.by}${req.reason ? `: ${req.reason}` : ""}`);
    // Let the broadcast flush before the sockets die.
    setTimeout(() => onRestart(RESTART_EXIT_CODE), 250);
  }

  /** Call at every idle boundary (turn end, crew change, build end). */
  function tick() {
    if (restartPending && !building && isIdle()) doRestart();
  }

  /** The agent's path: write `<state>/restart.request` from a workbench turn. */
  function watchRequestFile() {
    const file = requestFile();
    const check = () => {
      let text;
      try {
        if (!fs.existsSync(file)) return;
        if (fs.lstatSync(file).isSymbolicLink()) { fs.rmSync(file, { force: true }); return; }
        text = fs.readFileSync(file, "utf8");
      } catch {
        return;
      }
      const req = parseRestartRequest(text);
      if (!restartPending) requestRestart({ ...req, by: req.by || "file" });
    };
    try {
      const w = fs.watch(stateDir, { persistent: false }, (_ev, name) => {
        if (name === RESTART_REQUEST_FILE) setTimeout(check, 100);
      });
      w.on("error", () => {});
    } catch (err) {
      log(`not watching ${stateDir}: ${err.message}`);
    }
    check(); // a request left behind by a previous crashed host
  }

  function start() {
    watchDist();
    watchRequestFile();
  }

  return { enabled, status, build, rollback, requestRestart, cancelRestart, tick, start, isBuilding: () => !!building, restartPending: () => restartPending };
}
