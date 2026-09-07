// Shared task workspace: the one durable record around a piece of delegated
// work that BOTH sides hold. Files live at <cwd>/.dext/tasks/<name>.task.json:
// the host reads/writes them under validation (rev bump, atomic rename,
// symlink refusal), and the agent (dext, with its own file tools in cwd)
// reads/writes the very same file — the host watches the directory and
// broadcasts every change, so an agent-side edit reaches the UI too.
//
// Contract (enforced here, not by convention):
//   * `rev` is assigned by the host on every write. Writers may send
//     `expectedRev`; a mismatch is refused with `stale_rev` instead of
//     silently clobbering a concurrent writer (re-read, re-apply).
//   * `status: "done"` requires at least one check with `ok: true`.
//     A model-written summary is never verification.
//   * setting `answer` while blocked clears the block (status -> active):
//     an answered blocker is no longer blocking.
//   * `blocked` requires `blocked_on` — the question a human must answer.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { checkedPath } from "./session-files.mjs";

export const TASK_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const TASK_STATUSES = new Set(["planned", "active", "blocked", "done", "failed", "dropped"]);
const TASK_FILE_CAP = 128 * 1024;
const LIST_CAP = 64;
const MAX_CHECKS = 32;
const MAX_ARTIFACTS = 16;
const MAX_FOLDERS = 8;
const MAX_FLOWS = 8;
const CAPS = {
  title: 80, goal: 4000, item: 500, acceptance: 24, blocked: 2000, answer: 2000,
  notes: 1000, summary: 4000, detail: 500, check_name: 120, folder: 200, artifact: 300, id: 64,
};

const str = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");

/** Validate one task object. Returns `{ ok, task }` or `{ error }`. `rev` in
 *  the input is advisory only — writeTask() assigns it. */
export function validateTask(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "task must be a JSON object" };
  if (raw.version !== 1) return { error: "task.version must be 1" };
  if (typeof raw.name !== "string" || !TASK_NAME_RE.test(raw.name)) return { error: `task name must match ${TASK_NAME_RE}` };
  const goal = str(raw.goal, CAPS.goal);
  if (!goal) return { error: "task needs a goal (what does done mean?)" };
  const status = TASK_STATUSES.has(raw.status) ? raw.status : "planned";
  const blocked_on = str(raw.blocked_on, CAPS.blocked);
  if (status === "blocked" && !blocked_on) return { error: "status 'blocked' needs blocked_on (the question for the human)" };

  const checks = [];
  for (const c of (Array.isArray(raw.checks) ? raw.checks : []).slice(0, MAX_CHECKS)) {
    if (!c || typeof c !== "object") continue;
    const name = str(c.name, CAPS.check_name);
    if (!name) continue;
    checks.push({
      name,
      ok: c.ok === true,
      detail: str(c.detail, CAPS.detail),
      at: Number.isFinite(c.at) ? Math.round(c.at) : Date.now(),
      by: c.by === "agent" || c.by === "host" ? c.by : "user",
    });
  }

  const task = {
    version: 1,
    name: raw.name,
    title: str(raw.title, CAPS.title) || raw.name,
    goal,
    acceptance: (Array.isArray(raw.acceptance) ? raw.acceptance : []).map((a) => str(a, CAPS.item)).filter(Boolean).slice(0, CAPS.acceptance),
    status,
    blocked_on,
    answer: str(raw.answer, CAPS.answer),
    constraints: {
      folders: (Array.isArray(raw.constraints?.folders) ? raw.constraints.folders : []).map((f) => str(f, CAPS.folder)).filter(Boolean).slice(0, MAX_FOLDERS),
      budget_usd: Number.isFinite(raw.constraints?.budget_usd) && raw.constraints.budget_usd >= 0
        ? Math.round(raw.constraints.budget_usd * 100) / 100
        : null,
      notes: str(raw.constraints?.notes, CAPS.notes),
    },
    links: {
      session: str(raw.links?.session, CAPS.id),
      crew_run: str(raw.links?.crew_run, CAPS.id),
      flows: (Array.isArray(raw.links?.flows) ? raw.links.flows : []).map((f) => str(f, CAPS.id)).filter(Boolean).slice(0, MAX_FLOWS),
    },
    artifacts: (Array.isArray(raw.artifacts) ? raw.artifacts : []).map((a) => str(a, CAPS.artifact)).filter(Boolean).slice(0, MAX_ARTIFACTS),
    checks,
    summary: str(raw.summary, CAPS.summary),
    created_at: Number.isFinite(raw.created_at) ? Math.round(raw.created_at) : Date.now(),
    updated_at: Number.isFinite(raw.updated_at) ? Math.round(raw.updated_at) : Date.now(),
    updated_by: raw.updated_by === "agent" || raw.updated_by === "host" ? raw.updated_by : "user",
  };
  return { ok: true, task };
}

// ---------- IO (confined to <cwd>/.dext/tasks) ----------

export function tasksDir(cwd, { create = false } = {}) {
  const dir = path.join(cwd, ".dext", "tasks");
  let ok;
  try {
    ok = checkedPath(dir);
  } catch {
    return null;
  }
  if (!ok) {
    if (!create) return null;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      return null;
    }
  }
  return dir;
}

export function listTasks(cwd) {
  const dir = tasksDir(cwd);
  if (!dir) return [];
  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".task.json") && TASK_NAME_RE.test(f.slice(0, -".task.json".length)));
  } catch {
    return [];
  }
  const out = [];
  for (const f of names.sort().slice(0, LIST_CAP)) {
    const file = path.join(dir, f);
    const name = f.slice(0, -".task.json".length);
    try {
      if (fs.lstatSync(file).isSymbolicLink()) continue;
      if (fs.statSync(file).size > TASK_FILE_CAP) continue;
      const v = JSON.parse(fs.readFileSync(file, "utf8"));
      const checks = Array.isArray(v.checks) ? v.checks : [];
      out.push({
        name,
        title: typeof v.title === "string" && v.title.trim() ? v.title.trim().slice(0, CAPS.title) : name,
        status: TASK_STATUSES.has(v.status) ? v.status : "planned",
        rev: Number.isInteger(v.rev) && v.rev > 0 ? v.rev : 1,
        updated_at: Number.isFinite(v.updated_at) ? Math.round(v.updated_at) : 0,
        updated_by: v.updated_by === "agent" || v.updated_by === "host" ? v.updated_by : "user",
        checks_ok: checks.filter((c) => c && c.ok === true).length,
        blocked_on: typeof v.blocked_on === "string" ? v.blocked_on.slice(0, 200) : "",
      });
    } catch {
      /* unreadable or invalid: list it as a marker rather than drop it */
      out.push({ name, title: f, status: "planned", rev: 0, updated_at: 0, updated_by: "user", checks_ok: 0, blocked_on: "" });
    }
  }
  return out;
}

export function readTask(cwd, name) {
  if (!TASK_NAME_RE.test(name)) return { error: "bad_name" };
  const dir = tasksDir(cwd);
  if (!dir) return { error: "no_dir" };
  const file = path.join(dir, `${name}.task.json`);
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return { error: "refused" };
    const st = fs.statSync(file);
    if (!st.isFile()) return { error: "no_task" };
    if (st.size > TASK_FILE_CAP) return { error: "too_large" };
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    const check = validateTask(v);
    if (!check.ok) return { error: `invalid: ${check.error}` };
    // The host-assigned rev round-trips through the file.
    check.task.rev = Number.isInteger(v.rev) && v.rev > 0 ? v.rev : 1;
    return { ok: true, task: check.task };
  } catch (err) {
    if (err?.code === "ENOENT") return { error: "no_task" };
    return { error: err instanceof SyntaxError ? "invalid_json" : "read_failed" };
  }
}

/** Validate + write one task. `expectedRev` (when given) must match the rev on
 *  disk; the written record always carries rev = disk + 1. */
export function writeTask(cwd, raw, { actor = "user", expectedRev } = {}) {
  const check = validateTask(raw);
  if (!check.ok) return { error: check.error };
  const name = check.task.name;
  const existing = readTask(cwd, name);
  if (existing.error && !["no_task", "no_dir"].includes(existing.error)) {
    return { error: existing.error, code: existing.error === "refused" ? "refused" : "read_failed" };
  }
  const prev = existing.ok ? existing.task : null;
  if (expectedRev !== undefined && (!Number.isInteger(expectedRev) || expectedRev < 0)) {
    return { error: "expectedRev must be a non-negative integer" };
  }
  if (expectedRev !== undefined && (prev?.rev ?? 0) !== expectedRev) {
    return { error: `stale rev — disk is at ${prev?.rev ?? 0}, you expected ${expectedRev}; re-read and re-apply`, code: "stale_rev", current: prev?.rev ?? 0 };
  }

  const task = check.task;
  task.rev = (prev?.rev ?? 0) + 1;
  task.created_at = prev?.created_at ?? Date.now();
  task.updated_at = Date.now();
  task.updated_by = actor === "agent" || actor === "host" ? actor : "user";
  // An answered blocker is no longer blocking.
  if (task.answer && task.status === "blocked") task.status = "active";
  // Verified completion only: "done" needs passing machine-checked evidence.
  if (task.status === "done" && !task.checks.some((c) => c.ok === true)) {
    return { error: "status 'done' needs at least one passing check (checks[].ok = true) — add evidence, not a claim", code: "unverified" };
  }

  const dir = tasksDir(cwd, { create: true });
  if (!dir) return { error: "no_dir" };
  const file = path.join(dir, `${name}.task.json`);
  try {
    try {
      if (fs.lstatSync(file).isSymbolicLink()) return { error: "refused" };
    } catch {
      /* new file */
    }
    const text = JSON.stringify(task, null, 2) + "\n";
    if (Buffer.byteLength(text) > TASK_FILE_CAP) return { error: "too_large" };
    const tmp = path.join(dir, `.dextui-${crypto.randomBytes(6).toString("hex")}.tmp`);
    try {
      fs.writeFileSync(tmp, text, { flag: "wx" });
      fs.renameSync(tmp, file);
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* gone */ }
      return { error: "write_failed" };
    }
    return { ok: true, task };
  } catch {
    return { error: "write_failed" };
  }
}

export function deleteTask(cwd, name) {
  if (!TASK_NAME_RE.test(name)) return { error: "bad_name" };
  const dir = tasksDir(cwd);
  if (!dir) return { error: "no_dir" };
  const file = path.join(dir, `${name}.task.json`);
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return { error: "refused" };
    fs.unlinkSync(file);
    return { ok: true };
  } catch (err) {
    return { error: err?.code === "ENOENT" ? "no_task" : "delete_failed" };
  }
}

// ---------- host adapter: watch + broadcast ----------

/** One adapter per host: confined IO plus a directory watcher per workspace
 *  so agent-side file edits (dext writing the task file directly) reach every
 *  open tab through `x-agentlinkd.tasks.changed`. */
export function createTasksAdapter({ broadcast = () => {}, log = () => {}, debounceMs = 800 } = {}) {
  const watchers = new Map(); // cwd -> { w, timer }
  function push(cwd) {
    broadcast("x-agentlinkd.tasks.changed", { cwd, tasks: listTasks(cwd), dir: tasksDir(cwd) ?? "" });
  }
  function ensureWatch(cwd) {
    if (!cwd || watchers.has(cwd) || watchers.size >= 64) return;
    const dir = tasksDir(cwd, { create: true });
    if (!dir) return;
    const entry = { w: null, timer: null };
    try {
      entry.w = fs.watch(dir, { persistent: false }, () => {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => push(cwd), debounceMs);
      });
      entry.w.on("error", () => {});
    } catch (err) {
      log(`watch ${dir}: ${err.message}`);
      return;
    }
    watchers.set(cwd, entry);
  }
  return {
    ensureWatch,
    dir: (cwd) => tasksDir(cwd) ?? "",
    list: (cwd) => ({ tasks: listTasks(cwd), dir: tasksDir(cwd) ?? "" }),
    get: readTask,
    put(cwd, raw, opts) {
      const r = writeTask(cwd, raw, opts);
      if (!r.error) {
        ensureWatch(cwd);
        push(cwd);
      }
      return r;
    },
    delete(cwd, name) {
      const r = deleteTask(cwd, name);
      if (!r.error) push(cwd);
      return r;
    },
  };
}
