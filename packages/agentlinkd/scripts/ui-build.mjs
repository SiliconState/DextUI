#!/usr/bin/env node
// DextUI self-edit: staged build of the web app with an atomic swap and a
// last-known-good copy. The one implementation both drivers use:
//
//   - the human, through the host (`x-agentlinkd.ui.build`, Finder "rebuild UI")
//   - the agent, from a workbench session:  node packages/agentlinkd/scripts/ui-build.mjs
//
// Order: protocol → client → svelte-check (skip: --no-check) → [npm test
// with --tests] → vite build into apps/web/dist.staging → verify index.html
// → swap (dist → dist.lkg, dist.staging → dist). A failed step leaves the
// served `dist` untouched; the host keeps serving what it served.
//
// Exit codes: 0 ok · 1 step failed · 2 bad invocation. `--json` prints one
// summary object on stdout (steps, durations, tail) for the host/agent.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO = path.resolve(here, "..", "..", "..");
const STEP_TIMEOUT_MS = 10 * 60_000;
const TAIL_CHARS = 4000;

/** `repoRoot` is a DextUI checkout we can build: package.json name + apps/web + node_modules. */
export function buildable(repoRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    return pkg?.name === "dextui" && fs.existsSync(path.join(repoRoot, "apps", "web", "src")) && fs.existsSync(path.join(repoRoot, "node_modules"));
  } catch {
    return false;
  }
}

export function distPaths(repoRoot) {
  const web = path.join(repoRoot, "apps", "web");
  return { web, dist: path.join(web, "dist"), staging: path.join(web, "dist.staging"), lkg: path.join(web, "dist.lkg") };
}

/** Build identity of a served dist: `build-id.txt` (vite plugin), else the
 *  `sw.js?v=<id>` stamp inside the entry bundle, else the index mtime. */
export function distVersion(dir) {
  try {
    const index = path.join(dir, "index.html");
    const st = fs.statSync(index);
    let id;
    try {
      const stamp = fs.readFileSync(path.join(dir, "build-id.txt"), "utf8").trim();
      if (/^[a-z0-9]{1,32}$/.test(stamp)) id = stamp;
    } catch {
      /* older build without the plugin */
    }
    if (!id) {
      const assets = path.join(dir, "assets");
      const js = fs.existsSync(assets) ? fs.readdirSync(assets).find((f) => /^index-.*\.js$/.test(f)) : null;
      if (js && fs.statSync(path.join(assets, js)).size <= 8 * 1024 * 1024) {
        const m = /sw\.js\?v=([a-z0-9]+)/.exec(fs.readFileSync(path.join(assets, js), "utf8"));
        id = m?.[1];
      }
    }
    return { id: id ?? Math.round(st.mtimeMs).toString(36), mtime: Math.round(st.mtimeMs) };
  } catch {
    return null;
  }
}

/** Steps as `[label, cmd, args, cwd]`. Exposed so tests can substitute fakes. */
export function planSteps(repoRoot, { check = true, tests = false } = {}) {
  const { web } = distPaths(repoRoot);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const steps = [
    ["protocol", npm, ["run", "build", "-w", "@dextui/protocol"], repoRoot],
    ["client", npm, ["run", "build", "-w", "@dextui/client"], repoRoot],
  ];
  if (check) steps.push(["svelte-check", npm, ["run", "typecheck", "-w", "@dextui/web"], repoRoot]);
  if (tests) steps.push(["tests", npm, ["test"], repoRoot]);
  steps.push(["vite", npm, ["exec", "--", "vite", "build", "--outDir", "dist.staging", "--emptyOutDir"], web]);
  return steps;
}

function runStep([label, cmd, args, cwd], onLine) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let tail = "";
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: { ...process.env, CI: "1", FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ label, ok: false, code: null, duration_ms: 0, tail: String(err) });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), STEP_TIMEOUT_MS);
    const take = (chunk) => {
      const text = chunk.toString("utf8");
      tail = (tail + text).slice(-TAIL_CHARS);
      onLine?.(label, text);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (err) => {
      tail = (tail + String(err)).slice(-TAIL_CHARS);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ label, ok: code === 0, code, duration_ms: Date.now() - t0, tail });
    });
  });
}

/** Promote a verified staging dir: dist → dist.lkg (replacing the old LKG),
 *  staging → dist. Two renames on one filesystem; the served path is never
 *  half-written. Returns the new version, or throws with `dist` untouched. */
export function swapDist(repoRoot) {
  const { dist, staging, lkg } = distPaths(repoRoot);
  if (!fs.existsSync(path.join(staging, "index.html"))) throw new Error("staging build has no index.html");
  const hadDist = fs.existsSync(dist);
  if (hadDist) {
    fs.rmSync(lkg, { recursive: true, force: true });
    fs.renameSync(dist, lkg);
  }
  try {
    fs.renameSync(staging, dist);
  } catch (err) {
    // Put the old build back so the host keeps serving something.
    if (hadDist && !fs.existsSync(dist)) fs.renameSync(lkg, dist);
    throw err;
  }
  return distVersion(dist);
}

/** Serve the previous build again (Finder "roll back UI" / --safe boot repair). */
export function rollbackDist(repoRoot) {
  const { dist, lkg } = distPaths(repoRoot);
  if (!fs.existsSync(path.join(lkg, "index.html"))) throw new Error("no last-known-good build to roll back to");
  const broken = `${dist}.broken-${Date.now().toString(36)}`;
  if (fs.existsSync(dist)) fs.renameSync(dist, broken);
  fs.renameSync(lkg, dist);
  fs.rmSync(broken, { recursive: true, force: true });
  return distVersion(dist);
}

export async function buildUi({ repoRoot = DEFAULT_REPO, check = true, tests = false, onStep, onLine, steps } = {}) {
  const t0 = Date.now();
  if (!buildable(repoRoot)) {
    return { ok: false, error: "not_buildable", message: `${repoRoot} is not a buildable DextUI checkout (package.json name, apps/web/src, node_modules)`, steps: [], duration_ms: 0 };
  }
  const plan = steps ?? planSteps(repoRoot, { check, tests });
  const done = [];
  for (const step of plan) {
    onStep?.({ phase: "step", label: step[0], index: done.length, total: plan.length });
    const r = await runStep(step, onLine);
    done.push(r);
    if (!r.ok) {
      fs.rmSync(distPaths(repoRoot).staging, { recursive: true, force: true });
      return { ok: false, error: "step_failed", failed: r.label, steps: done, tail: r.tail, duration_ms: Date.now() - t0 };
    }
  }
  try {
    const version = swapDist(repoRoot);
    return { ok: true, version, steps: done, duration_ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: "swap_failed", message: String(err?.message ?? err), steps: done, duration_ms: Date.now() - t0 };
  }
}

// ---------- CLI ----------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(`--${n}`);
  const val = (n) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  if (flag("help") || flag("h")) {
    console.log("usage: ui-build.mjs [--repo=<dir>] [--no-check] [--tests] [--rollback] [--json]");
    process.exit(2);
  }
  const repoRoot = path.resolve(val("repo") ?? DEFAULT_REPO);
  const json = flag("json");
  if (flag("rollback")) {
    try {
      const version = rollbackDist(repoRoot);
      if (json) console.log(JSON.stringify({ ok: true, rolled_back: true, version }));
      else console.log(`rolled back to ${version?.id ?? "previous build"}`);
      process.exit(0);
    } catch (err) {
      if (json) console.log(JSON.stringify({ ok: false, error: "rollback_failed", message: String(err.message) }));
      else console.error(`rollback failed: ${err.message}`);
      process.exit(1);
    }
  }
  const result = await buildUi({
    repoRoot,
    check: !flag("no-check"),
    tests: flag("tests"),
    onStep: json ? undefined : (s) => console.error(`[ui-build] ${s.index + 1}/${s.total} ${s.label}`),
    onLine: json ? undefined : (_l, text) => process.stderr.write(text),
  });
  if (json) console.log(JSON.stringify(result));
  else if (result.ok) console.log(`[ui-build] ok · ${result.version?.id ?? "?"} · ${result.duration_ms} ms · previous build kept in apps/web/dist.lkg`);
  else console.error(`[ui-build] FAILED (${result.error}${result.failed ? `: ${result.failed}` : ""}) · served build untouched`);
  process.exit(result.ok ? 0 : 1);
}
