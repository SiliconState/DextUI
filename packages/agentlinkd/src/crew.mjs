// Crew run adapter for agentlinkd: project crew 0.1.0 manifests into the
// summary/detail tiers the web app renders, watch the runs directories, and
// execute the two operator verbs (stop, resume). Result *text* never leaves
// the host — summaries carry ids and counts, detail carries per-worker
// status, and logs ride the bounded `tail` reply on demand.
//
// Coupling note: this reads crew's on-disk layout directly (manifest.json,
// <worker>/.state, <worker>/live.log). Writes are atomic per crew's PACK.md,
// so reads are race-safe; the layout is versioned with crew 0.1.0.
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { checkedPath } from "./session-files.mjs";

export const RUN_ID_RE = /^run-[a-f0-9]{12}$/;
export const SUMMARY_CAP = 8;
export const TAIL_MAX_LINES = 80;
const TAIL_READ_BYTES = 64 * 1024;
const FILE_CAP = 512 * 1024;
const MANIFEST_CAP = 8 * 1024 * 1024;
const ERROR_CHARS = 80;
const TASK_CHARS = 120;
const DEBOUNCE_MS = 500;
const HEARTBEAT_MS = 15_000;

const STATUSES = new Set(["pending", "running", "completed", "failed", "paused"]);

/** crew StepStatus/RunStatus and the `.state` atom's `done` → the 5 variants. */
export function normStatus(s) {
  const v = String(s ?? "").toLowerCase();
  if (v === "done") return "completed";
  return STATUSES.has(v) ? v : "pending";
}

export function countsOf(statuses) {
  const c = { pending: 0, run: 0, done: 0, fail: 0, paused: 0, total: statuses.length };
  for (const s of statuses) {
    if (s === "running") c.run++;
    else if (s === "completed") c.done++;
    else if (s === "failed") c.fail++;
    else if (s === "paused") c.paused++;
    else c.pending++;
  }
  return c;
}

function rel(chainDir, p) {
  if (typeof p !== "string" || !p) return undefined;
  const r = path.relative(chainDir, p);
  if (!r || r.startsWith("..") || path.isAbsolute(r)) return undefined;
  return r;
}

function worker(key, node, chainDir, inherit = {}, stateOf = () => null) {
  const status = normStatus(node.status);
  const result = node.result && typeof node.result === "object" ? node.result : null;
  const w = {
    key,
    label: String(node.label ?? node.itemKey ?? inherit.label ?? key),
    agent: String(node.agent ?? inherit.agent ?? ""),
    status,
  };
  const model = node.model ?? inherit.model;
  if (typeof model === "string" && model) w.model = model;
  if (result) {
    if (Number.isFinite(result.durationMs)) w.duration_ms = Math.round(result.durationMs);
    if (typeof result.error === "string" && result.error) w.error = result.error.slice(0, ERROR_CHARS);
    const out = rel(chainDir, result.outputPath);
    if (out) w.output = out;
    const e = result.escalation;
    if (e && typeof e === "object" && typeof e.question === "string") {
      w.escalation = { question: e.question.slice(0, 2000) };
      if (typeof e.reason === "string") w.escalation.reason = e.reason.slice(0, 200);
      const f = rel(chainDir, e.file);
      if (f) w.escalation.file = f;
    }
  }
  if (status === "running" && typeof node.dir === "string") {
    const st = stateOf(node.dir);
    if (st && Number.isFinite(st.started)) w.started_at = Math.round(st.started * 1000);
  }
  return w;
}

/** Project one parsed manifest into `{ summary, detail }`. Pure given `stateOf`. */
export function projectManifest(m, { now = Date.now(), mtimeMs = now, stateOf = () => null, files = [] } = {}) {
  const id = String(m.runId ?? "");
  if (!RUN_ID_RE.test(id)) return null;
  const chainDir = typeof m.chainDir === "string" ? m.chainDir : "";
  const status = normStatus(m.status);
  const pausedReason = typeof m.pausedReason === "string" ? m.pausedReason : undefined;
  const stopped = status === "failed" && /stopped by user/i.test(pausedReason ?? "");
  const groups = [];
  const steps = Array.isArray(m.steps) ? m.steps : [];
  steps.forEach((step, i) => {
    if (!step || typeof step !== "object") return;
    const kind = step.kind === "parallel" || step.kind === "dynamic" ? step.kind : "sequential";
    let workers;
    if (kind === "parallel") {
      workers = (Array.isArray(step.tasks) ? step.tasks : []).map((t, j) => worker(`${i}.${j}`, t, chainDir, {}, stateOf));
    } else if (kind === "dynamic") {
      const inherit = { agent: step.agent, model: step.model, label: step.label };
      workers = (Array.isArray(step.materialized) ? step.materialized : []).map((t, j) => worker(`${i}.${j}`, t, chainDir, inherit, stateOf));
    } else {
      workers = [worker(`${i}`, step, chainDir, {}, stateOf)];
    }
    const label = kind === "sequential" ? workers[0].label : String(step.label ?? (kind === "parallel" ? "parallel" : "fanout"));
    groups.push({ index: i, kind, label, status: normStatus(step.status), counts: countsOf(workers.map((w) => w.status)), workers });
  });
  const all = groups.flatMap((g) => g.workers);
  let escalation;
  if (status === "paused") {
    for (const g of groups) {
      const w = g.workers.find((x) => x.escalation);
      if (w) {
        escalation = { step: g.index, worker: w.key, label: w.label, question: w.escalation.question };
        if (w.escalation.reason) escalation.reason = w.escalation.reason;
        if (w.escalation.file) escalation.file = w.escalation.file;
        break;
      }
    }
  }
  const created = Date.parse(m.createdAt ?? "") || mtimeMs;
  const summary = {
    id,
    task: String(m.rootTask ?? "").replace(/\s+/g, " ").trim().slice(0, TASK_CHARS),
    status,
    state: stopped ? "stopped" : status,
    mode: String(m.mode ?? "single"),
    cwd: String(m.cwd ?? ""),
    counts: countsOf(all.map((w) => w.status)),
    age_ms: Math.max(0, now - created),
    updated_ms: Math.max(0, now - mtimeMs),
    duration_ms: all.reduce((n, w) => n + (w.duration_ms ?? 0), 0),
    detached: typeof m.unit === "string" && m.unit.length > 0,
    ...(escalation ? { escalation } : {}),
  };
  const detail = { ...summary, created_at: created, groups, files };
  if (pausedReason) detail.paused_reason = pausedReason.slice(0, 200);
  return { summary, detail, chainDir };
}

const RANK = { paused: 0, failed: 1, running: 2, pending: 3, completed: 5, stopped: 6 };
const STALE_FAIL_MS = 24 * 60 * 60 * 1000;

function rankOf(r) {
  // A failure is attention only while fresh; an old one must never push a live
  // run off the capped list (real data: 33 runs, 25 of them stale failures).
  if (r.state === "failed" && r.updated_ms > STALE_FAIL_MS) return 4;
  return RANK[r.state] ?? 9;
}

/** Attention order: paused → fresh failed → running → pending → stale failed → done → stopped; fresher first within a rank. */
export function sortRuns(list) {
  return [...list].sort((a, b) => rankOf(a) - rankOf(b) || a.updated_ms - b.updated_ms || (a.id < b.id ? -1 : 1));
}

/** `{ runs, omitted }` capped at SUMMARY_CAP; attention order means terminal runs drop first. */
export function capRuns(list, cap = SUMMARY_CAP) {
  const runs = sortRuns(list);
  return { runs: runs.slice(0, cap), omitted: Math.max(0, runs.length - cap) };
}

/** Last `n` lines of a text file, reading at most TAIL_READ_BYTES from its end. */
export function tailLines(file, n = TAIL_MAX_LINES) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_READ_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1); // drop the partial first line
    const lines = text.replace(/\r/g, "").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const cut = Math.min(Math.max(1, n | 0), TAIL_MAX_LINES);
    return { lines: lines.slice(-cut).map((l) => l.slice(0, 400)), truncated: start > 0 || lines.length > cut, bytes: size };
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- filesystem layer ----------

function readJson(file, cap) {
  if (!checkedPath(file)) return null;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > cap) return null;
    const buf = Buffer.alloc(st.size);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return { json: JSON.parse(buf.toString("utf8", 0, n)), mtimeMs: st.mtimeMs };
  } finally {
    fs.closeSync(fd);
  }
}

function readState(dir) {
  try {
    return readJson(path.join(dir, ".state"), 64 * 1024)?.json ?? null;
  } catch {
    return null;
  }
}

function chainFiles(chainDir) {
  try {
    if (!chainDir || !checkedPath(chainDir)) return [];
    return fs.readdirSync(chainDir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort()
      .slice(0, 40);
  } catch {
    return [];
  }
}

/** Real path of `p` must sit inside real `root` (root itself excluded). */
function confined(root, p) {
  let realRoot;
  let real;
  try {
    realRoot = fs.realpathSync(root);
    real = fs.realpathSync(p);
  } catch {
    return null;
  }
  return real !== realRoot && real.startsWith(realRoot + path.sep) ? real : null;
}

/**
 * Watch every runs root, keep one projected view per run, and push changes.
 *   onChanged(payload)          — summaries (capped) whenever any summary changed
 *   onRunChanged(id, detail)    — detail for runs someone has open
 * Idle cost: one recursive fs.watch per root (or a 15 s heartbeat without it).
 */
export function createCrewAdapter({ roots = [], crewBin = "crew", dextBin, env = process.env, onChanged, onRunChanged, isOpen = () => false, log = () => {} } = {}) {
  const runs = new Map(); // id -> { dir, manifest, mtimeMs, summary, detail, chainDir }
  const watched = new Set();
  const inflight = new Set(); // run ids with a resume in progress (first answer wins)
  let timer = null;
  let heartbeat = null;
  let lastPayload = "";

  function childEnv() {
    const e = { ...env, DEXT_NO_TUI: "1" };
    if (dextBin) {
      e.DEXT_BIN = dextBin;
      // Only an absolute binary may extend PATH: a bare "dext" would put "." first.
      if (path.isAbsolute(dextBin)) e.PATH = `${path.dirname(dextBin)}${path.delimiter}${e.PATH ?? ""}`;
    }
    return e;
  }

  function scanRoot(root, seen, now) {
    let entries;
    try {
      if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink()) return;
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // Two layouts: `<cwd>/.crew/runs/run-*` (explicit --runs-dir) and crew's
      // default `~/.dext/crew/runs/project-<hash>/run-*` — one level deeper.
      if (/^project-[a-f0-9]{16}$/.test(e.name)) {
        scanRoot(path.join(root, e.name), seen, now);
        continue;
      }
      if (!RUN_ID_RE.test(e.name)) continue;
      const dir = path.join(root, e.name);
      const file = path.join(dir, "manifest.json");
      let st;
      try {
        st = fs.lstatSync(file);
        if (!st.isFile()) continue;
      } catch {
        continue;
      }
      seen.add(e.name);
      const prev = runs.get(e.name);
      const live = prev && (prev.summary.status === "running" || prev.summary.status === "pending");
      // Re-read on mtime change; live runs also re-project so `.state` timing stays fresh.
      if (prev && prev.mtimeMs === st.mtimeMs && !live) continue;
      try {
        const read = readJson(file, MANIFEST_CAP);
        if (!read) continue;
        const proj = projectManifest(read.json, { now, mtimeMs: read.mtimeMs, stateOf: readState, files: chainFiles(read.json.chainDir) });
        if (!proj || proj.summary.id !== e.name) continue;
        runs.set(e.name, { dir, manifest: read.json, mtimeMs: read.mtimeMs, detailKey: prev?.detailKey, ...proj });
      } catch (err) {
        log(`crew: skipping ${file}: ${err.message}`);
      }
    }
  }

  function scan() {
    const now = Date.now();
    const seen = new Set();
    for (const root of roots) scanRoot(root, seen, now);
    for (const id of [...runs.keys()]) if (!seen.has(id)) runs.delete(id);
    // Ages tick even without disk changes; compare on the parts that matter.
    const payload = summaries();
    const key = JSON.stringify([payload.omitted, payload.runs.map((r) => [r.id, r.state, r.counts, r.task, r.escalation?.question ?? null])]);
    if (key !== lastPayload) {
      lastPayload = key;
      onChanged?.(payload);
    }
    // Detail pushes only when the projection itself moved (timing fields excluded).
    for (const [id, r] of runs) {
      if (!isOpen(id)) continue;
      const { age_ms, updated_ms, ...rest } = r.detail;
      const dkey = JSON.stringify(rest);
      if (dkey === r.detailKey) continue;
      r.detailKey = dkey;
      onRunChanged?.(id, r.detail);
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try { scan(); } catch (err) { log(`crew: scan failed: ${err.message}`); }
    }, DEBOUNCE_MS);
  }

  function watchDir(target, opts, handler) {
    const w = fs.watch(target, { persistent: false, ...opts }, handler);
    w.on("error", () => {});
    return w;
  }

  function addRoot(root) {
    root = path.resolve(root);
    if (!roots.includes(root)) roots.push(root);
    if (watched.has(root)) return;
    try {
      if (fs.existsSync(root)) {
        watchDir(root, { recursive: true }, (_ev, name) => {
          // Worker logs stream at high rate and never change a projection by themselves.
          if (typeof name === "string" && name.endsWith("live.log")) return;
          schedule();
        });
        watched.add(root);
        schedule();
        return;
      }
      // The runs dir does not exist yet: watch the nearest existing ancestor
      // (non-recursively, so a big project tree costs nothing) and upgrade to
      // the real watch once a first `crew launch` creates it.
      let anc = path.dirname(root);
      while (!fs.existsSync(anc) && path.dirname(anc) !== anc) anc = path.dirname(anc);
      const key = `${anc}\0${root}`;
      if (watched.has(key)) return;
      const w = watchDir(anc, {}, () => {
        if (fs.existsSync(root)) {
          w.close();
          watched.delete(key);
          addRoot(root);
        }
      });
      watched.add(key);
    } catch (err) {
      log(`crew: not watching ${root}: ${err.message}; heartbeat fallback`);
      if (!heartbeat) {
        heartbeat = setInterval(schedule, HEARTBEAT_MS);
        heartbeat.unref();
      }
    }
  }

  function summaries() {
    return capRuns([...runs.values()].map((r) => r.summary));
  }

  function detail(id) {
    return runs.get(id)?.detail ?? null;
  }

  function findWorker(r, key) {
    if (!/^\d+(\.\d+)?$/.test(String(key))) return null;
    const [gi, wi] = String(key).split(".").map(Number);
    const step = r.manifest.steps?.[gi];
    if (!step) return null;
    const list = step.kind === "parallel" ? step.tasks : step.kind === "dynamic" ? step.materialized : [step];
    const node = list?.[wi ?? 0];
    return node && typeof node.dir === "string" ? node : null;
  }

  function tail(id, key, lines) {
    const r = runs.get(id);
    if (!r) return { error: "no_run" };
    const node = findWorker(r, key);
    if (!node) return { error: "no_worker" };
    const file = confined(r.dir, path.join(node.dir, "live.log"));
    if (!file) return { error: "no_log" };
    try {
      return { run: id, worker: String(key), ...tailLines(file, lines) };
    } catch {
      return { error: "no_log" };
    }
  }

  function file(id, rel) {
    const r = runs.get(id);
    if (!r) return { error: "no_run" };
    if (typeof rel !== "string" || !rel || rel.includes("\0") || path.isAbsolute(rel)) return { error: "bad_path" };
    const real = confined(r.chainDir, path.join(r.chainDir, rel));
    if (!real || !checkedPath(real)) return { error: "bad_path" };
    const fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return { error: "bad_path" };
      const n = Math.min(st.size, FILE_CAP);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, 0);
      return { run: id, path: rel, text: buf.toString("utf8"), truncated: st.size > FILE_CAP, bytes: st.size };
    } finally {
      fs.closeSync(fd);
    }
  }

  function crew(args, cwd) {
    return new Promise((resolve) => {
      execFile(crewBin, args, { cwd, env: childEnv(), timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, out: String(stdout ?? ""), err: String(stderr ?? "").trim() || err?.message || "" });
      });
    });
  }

  async function stop(id) {
    const r = runs.get(id);
    if (!r) return { ok: false, message: "unknown run" };
    if (!["running", "pending", "paused"].includes(r.summary.status)) return { ok: false, message: `run is ${r.summary.status}` };
    // Address the run by manifest path: independent of which runs root it lives in.
    const res = await crew(["stop", path.join(r.dir, "manifest.json"), "--cwd", r.summary.cwd || r.dir], r.summary.cwd || undefined);
    schedule();
    return { ok: res.ok, message: res.ok ? "stopped" : res.err.slice(0, 200) };
  }

  /** crew's two-step contract: record the answer, then execute the printed
   *  `crew run --manifest … --cwd …` (spawned detached so the host never blocks). */
  async function resume(id, answer) {
    const r = runs.get(id);
    if (!r) return { ok: false, code: "no_run", message: "unknown run" };
    if (r.summary.status !== "paused" || !r.summary.escalation) return { ok: false, code: "crew_already_answered", message: "run is not awaiting an answer" };
    if (inflight.has(id)) return { ok: false, code: "crew_already_answered", message: "another client already answered" };
    inflight.add(id);
    try {
      const manifest = path.join(r.dir, "manifest.json");
      const cwd = r.summary.cwd || r.dir;
      const res = await crew(["resume", manifest, "--answer", answer, "--cwd", cwd], cwd);
      if (!res.ok) return { ok: false, code: "crew_failed", message: res.err.slice(0, 200) };
      const args = ["run", "--manifest", manifest, "--cwd", cwd];
      if (dextBin) args.push("--dext", dextBin);
      const child = spawn(crewBin, args, { cwd, env: childEnv(), detached: true, stdio: "ignore" });
      child.on("error", (err) => log(`crew: run --manifest failed to spawn: ${err.message}`));
      child.unref();
      schedule();
      return { ok: true, message: "answer recorded; run resumed" };
    } finally {
      inflight.delete(id);
    }
  }

  function close() {
    clearTimeout(timer);
    clearInterval(heartbeat);
  }

  for (const root of [...roots]) addRoot(root);
  try { scan(); } catch (err) { log(`crew: initial scan failed: ${err.message}`); }
  return { addRoot, scan, schedule, summaries, detail, tail, file, stop, resume, close, runs };
}
