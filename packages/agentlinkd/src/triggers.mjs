// Trigger scheduler: what starts a flow besides a click. Triggers live on the
// flow file (`flow.triggers[]`, validated in flows.mjs); this module watches
// every known workspace's `.dext/flows`, keeps one live trigger per
// (cwd, flow, index), and calls `startRun(cwd, name, reason)`.
//
//   schedule  every N minutes, or daily_at HH:MM (+ weekday) — local time
//   watch     files change under <cwd>/<path> (debounced, dot-dirs ignored)
//   mesh      a message arrives for node <node> (polled `mesh recv`)
//   webhook   POST /hooks/<token> — token derived (HMAC) from the pairing
//             token + cwd + flow, so nothing secret is stored anywhere
//
// Execution semantics (at-most-once per period, never silent):
//   * Fires are SERIALIZED per flow: one launch in flight at a time; events
//     that arrive while busy or cooling down are COALESCED into one pending
//     fire that runs when the flow frees up.
//   * A failed launch is NOT a fire. The failure is recorded with exponential
//     backoff (30s → 30min by default), broadcast with `phase:"failed"` and a
//     `retry_at`, and retried on later ticks. Retrying a flow can repeat its
//     external actions, so schedules are additionally IDEMPOTENT PER SLOT:
//     a successful fire marks the schedule slot (`every` bucket or the
//     daily_at calendar date) and a restart never refires the same slot.
//   * Last-fire, attempt, failure and slot state persist in
//     <state>/triggers.json so restarts respect all of the above.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { listFlows, readFlow } from "./flows.mjs";

const TICK_MS = 30_000;
const WATCH_DEBOUNCE_MS = 5_000;
const MESH_POLL_MS = 15_000;
const COOLDOWN_MS = 60_000;
const MAX_WORKSPACES = 64;
const DEFAULT_BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;

export function webhookToken(secret, cwd, name) {
  return crypto.createHmac("sha256", String(secret)).update(`${cwd}\n${name}`).digest("base64url").slice(0, 32);
}

/** Next fire for a daily_at trigger after `now` (ms), local time. */
export function nextDaily(now, hhmm, weekday) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setHours(h, m, 0, 0);
  for (let i = 0; i < 8; i++) {
    if (d.getTime() > now && (weekday === undefined || d.getDay() === weekday)) return d.getTime();
    d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}

/** The most recent daily_at slot at or before `now`, by CALENDAR arithmetic
 *  (step back a day / a week, then pin HH:MM). Fixed-millisecond subtraction
 *  drifts across DST transitions — a 23h or 25h day must not move the slot. */
export function prevDaily(now, hhmm, weekday) {
  const d = new Date(nextDaily(now, hhmm, weekday));
  d.setDate(d.getDate() - (weekday === undefined ? 1 : 7));
  const [h, m] = hhmm.split(":").map(Number);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/** Pure: is a schedule trigger due, given its last successful fire? */
export function scheduleDue(t, lastFired, now) {
  if (t.every) return !lastFired || now - lastFired >= t.every * 60_000;
  if (t.daily_at) {
    // Due when the most recent scheduled slot ≤ now is after the last fire.
    const lastSlot = prevDaily(now, t.daily_at, t.weekday);
    return lastSlot <= now && (!lastFired || lastFired < lastSlot);
  }
  return false;
}

/** Stable id for the schedule period containing `now` (slot idempotency key). */
function slotKeyOf(t, now) {
  if (t.every) return `b${Math.floor(now / (t.every * 60_000))}`;
  if (t.daily_at) {
    const slot = new Date(prevDaily(now, t.daily_at, t.weekday));
    return `d${slot.getFullYear()}-${slot.getMonth()}-${slot.getDate()}T${t.daily_at}${t.weekday ?? ""}`;
  }
  return null;
}

export function createScheduler({
  stateDir,
  secret,
  startRun,
  meshBin = "mesh",
  log = () => {},
  broadcast = () => {},
  backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
}) {
  const stateFile = path.join(stateDir, "triggers.json");
  // fired:    flow/trigger key -> last SUCCESSFUL fire ms
  // attempted:flow key -> last launch attempt ms (a failure is not a fire)
  // failures: flow key -> { at, n, error } — drives exponential backoff
  // slots:    trigger key -> last fired schedule slot id (idempotency)
  let fired = {};
  let attempted = {};
  let failures = {};
  let slots = {};
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, "utf8")) || {};
    if (raw && typeof raw.fired === "object") {
      fired = raw.fired ?? {};
      attempted = raw.attempted ?? {};
      failures = raw.failures ?? {};
      slots = raw.slots ?? {};
    } else {
      fired = raw; // pre-serialization format: a flat last-fire map
    }
  } catch {
    fired = {};
  }
  function persist() {
    try {
      fs.writeFileSync(stateFile, JSON.stringify({ fired, attempted, failures, slots }));
    } catch (err) {
      log(`triggers: cannot persist ${stateFile}: ${err.message}`);
    }
  }

  const workspaces = new Map(); // cwd -> { watchers, dirWatcher }
  const live = new Map(); // key -> { cwd, name, trigger, timer?, watcher?, last }
  const meshQueue = new Map(); // node -> Set<key>
  const inFlight = new Set(); // flow key -> launch running
  const pending = new Map(); // flow key -> { key, reason } (coalesced)
  let tick = null;
  let meshTimer = null;

  function key(cwd, name, i) {
    return `${cwd}\u0000${name}\u0000${i}`;
  }
  const flowKey = (cwd, name) => `${cwd}\u0000${name}`;

  function backoffMs(n) {
    return Math.min(BACKOFF_MAX_MS, backoffBaseMs * 2 ** Math.max(0, n - 1));
  }
  function retryAt(fk) {
    const f = failures[fk];
    return f ? f.at + backoffMs(f.n) : 0;
  }
  function inBackoff(fk, now) {
    return retryAt(fk) > now;
  }

  /** Queue one coalesced fire (first reason wins; later events are absorbed). */
  function queuePending(entry, reason) {
    const fk = flowKey(entry.cwd, entry.name);
    if (pending.has(fk)) return;
    pending.set(fk, { key: entry.key, reason });
    broadcast("x-agentlinkd.flows.trigger", {
      cwd: entry.cwd, name: entry.name, kind: entry.trigger.kind, reason, at: Date.now(), phase: "pending",
    });
  }

  /** Try to fire. Returns true when a launch was started; a skip is queued or
   *  backed off, never silently dropped. Disabled triggers never fire — a
   *  queued event from before the disable is dropped at drain time. */
  function fire(entry, reason) {
    if (!entry?.trigger?.enabled) return false;
    const fk = flowKey(entry.cwd, entry.name);
    const now = Date.now();
    if (inFlight.has(fk)) {
      queuePending(entry, reason);
      return false;
    }
    if (inBackoff(fk, now)) {
      queuePending(entry, reason);
      return false;
    }
    if (fired[fk] && now - fired[fk] < COOLDOWN_MS) {
      queuePending(entry, reason);
      return false;
    }
    // Slot idempotency: this schedule period already ran to completion.
    const slot = slotKeyOf(entry.trigger, now);
    if (slot && slots[entry.key] === slot) return false;

    inFlight.add(fk);
    attempted[fk] = now;
    persist();
    log(`trigger ${entry.trigger.kind} → ${entry.name} (${reason})`);
    broadcast("x-agentlinkd.flows.trigger", { cwd: entry.cwd, name: entry.name, kind: entry.trigger.kind, reason, at: now, phase: "start" });
    Promise.resolve(startRun(entry.cwd, entry.name, { by: `trigger:${entry.trigger.kind}`, reason }))
      .then((r) => {
        inFlight.delete(fk);
        if (r && r.error) {
          const n = (failures[fk]?.n ?? 0) + 1;
          failures[fk] = { at: Date.now(), n, error: String(r.error).slice(0, 200) };
          // fired[] holds SUCCESSFUL fires only — a failed attempt never
          // touches it, so an earlier success keeps its cooldown marker.
          persist();
          const retry = retryAt(fk);
          log(`trigger ${entry.name}: run failed (${r.error}); retry at ${new Date(retry).toISOString()}`);
          broadcast("x-agentlinkd.flows.trigger", {
            cwd: entry.cwd, name: entry.name, kind: entry.trigger.kind, reason, at: Date.now(), phase: "failed", error: String(r.error).slice(0, 200), retry_at: retry,
          });
          return;
        }
        fired[fk] = Date.now();
        fired[entry.key] = Date.now();
        delete failures[fk];
        pending.delete(fk); // this run satisfied any coalesced event
        if (slot) slots[entry.key] = slot;
        persist();
        drainPending();
      })
      .catch((err) => {
        inFlight.delete(fk);
        const n = (failures[fk]?.n ?? 0) + 1;
        failures[fk] = { at: Date.now(), n, error: String(err?.message ?? err).slice(0, 200) };
        persist();
        log(`trigger ${entry.name}: ${err?.message ?? err}`);
        broadcast("x-agentlinkd.flows.trigger", {
          cwd: entry.cwd, name: entry.name, kind: entry.trigger.kind, reason, at: Date.now(), phase: "failed", error: String(err?.message ?? err).slice(0, 200), retry_at: retryAt(fk),
        });
      });
    return true;
  }

  /** Fire coalesced events whose flow has freed up (cooldown + backoff honored).
   *  Pending work for triggers that were disabled or removed meanwhile is
   *  invalidated, not executed. */
  function drainPending() {
    const now = Date.now();
    for (const [fk, p] of [...pending.entries()]) {
      const entry = live.get(p.key);
      if (!entry || !entry.trigger.enabled) {
        pending.delete(fk);
        continue;
      }
      if (inFlight.has(fk) || inBackoff(fk, now)) continue;
      if (fired[fk] && now - fired[fk] < COOLDOWN_MS) continue;
      pending.delete(fk);
      fire(entry, p.reason);
    }
  }

  function teardown(entry) {
    if (entry.watcher) { try { entry.watcher.close(); } catch { /* closed */ } }
    if (entry.debounce) clearTimeout(entry.debounce);
    if (entry.trigger.kind === "mesh") meshQueue.get(entry.trigger.node)?.delete(entry.key);
    live.delete(entry.key);
  }

  function arm(cwd, name, i, trigger) {
    const k = key(cwd, name, i);
    const entry = { key: k, cwd, name, trigger };
    live.set(k, entry);
    if (!trigger.enabled) return;
    if (trigger.kind === "watch") {
      const dir = trigger.path === "." ? cwd : path.join(cwd, trigger.path);
      try {
        if (!fs.existsSync(dir) || fs.lstatSync(dir).isSymbolicLink()) return;
        entry.watcher = fs.watch(dir, { recursive: trigger.path !== ".", persistent: false }, (_ev, file) => {
          const f = String(file ?? "");
          if (f.startsWith(".") || f.includes("/.")) return; // .dext, .crew, .receipts …
          clearTimeout(entry.debounce);
          entry.debounce = setTimeout(() => fire(entry, `files changed under ${trigger.path}: ${f.slice(0, 80)}`), WATCH_DEBOUNCE_MS);
        });
        entry.watcher.on("error", () => {});
      } catch (err) {
        log(`trigger watch ${dir}: ${err.message}`);
      }
    } else if (trigger.kind === "mesh") {
      if (!meshQueue.has(trigger.node)) meshQueue.set(trigger.node, new Set());
      meshQueue.get(trigger.node).add(k);
    }
  }

  /** (Re)load a workspace's flows and re-arm its triggers. */
  function reload(cwd) {
    for (const entry of [...live.values()]) if (entry.cwd === cwd) teardown(entry);
    let count = 0;
    for (const s of listFlows(cwd)) {
      if (!s.triggers) continue;
      const r = readFlow(cwd, s.name);
      if (!r.ok || !r.flow.triggers) continue;
      r.flow.triggers.forEach((t, i) => { arm(cwd, r.flow.name, i, t); count++; });
    }
    return count;
  }

  function addWorkspace(cwd) {
    if (!cwd || workspaces.has(cwd)) return;
    if (workspaces.size >= MAX_WORKSPACES) return;
    const ws = { dirWatcher: null };
    workspaces.set(cwd, ws);
    const flowsDir = path.join(cwd, ".dext", "flows");
    try {
      if (fs.existsSync(flowsDir) && !fs.lstatSync(flowsDir).isSymbolicLink()) {
        ws.dirWatcher = fs.watch(flowsDir, { persistent: false }, () => {
          clearTimeout(ws.debounce);
          ws.debounce = setTimeout(() => reload(cwd), 1000);
        });
        ws.dirWatcher.on("error", () => {});
      }
    } catch { /* no flows dir yet: reload() on flows.changed still works */ }
    reload(cwd);
  }

  // ---------- schedule + mesh polling ----------

  function onTick() {
    const now = Date.now();
    for (const entry of live.values()) {
      const t = entry.trigger;
      if (!t.enabled || t.kind !== "schedule") continue;
      const fk = flowKey(entry.cwd, entry.name);
      if (inFlight.has(fk) || inBackoff(fk, now)) continue;
      const slot = slotKeyOf(t, now);
      if (slot && slots[entry.key] === slot) continue;
      if (scheduleDue(t, fired[entry.key], now)) {
        fire(entry, t.every ? `every ${t.every} min` : `daily at ${t.daily_at}`);
      }
    }
    drainPending();
  }

  let meshBusy = false;
  function pollMesh() {
    if (meshBusy || meshQueue.size === 0) return;
    meshBusy = true;
    const nodes = [...meshQueue.keys()];
    let pendingNodes = nodes.length;
    for (const node of nodes) {
      execFile(meshBin, ["recv", "--node", node, "--timeout", "0", "--max", "10"], { timeout: 10_000, maxBuffer: 256 * 1024 }, (err, stdout) => {
        if (!err && stdout) {
          const msgs = String(stdout).split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          for (const msg of msgs) {
            for (const k of meshQueue.get(node) ?? []) {
              const entry = live.get(k);
              if (!entry || !entry.trigger.enabled) continue;
              if (entry.trigger.from && msg.from !== entry.trigger.from) continue;
              fire(entry, `message from ${msg.from ?? "?"}: ${String(msg.body ?? "").slice(0, 80)}`);
            }
          }
        }
        if (--pendingNodes === 0) meshBusy = false;
      });
    }
  }

  function start() {
    if (tick) return;
    tick = setInterval(() => { onTick(); pollMesh(); }, TICK_MS);
    tick.unref?.();
    setTimeout(pollMesh, 2000).unref?.();
    // mesh polls a bit faster than the schedule tick
    meshTimer = setInterval(pollMesh, MESH_POLL_MS);
    meshTimer.unref?.();
  }

  function stop() {
    clearInterval(tick);
    tick = null;
    // Both intervals are ours; leaving the mesh poll running leaked a timer
    // across stop()/start() cycles.
    if (meshTimer) {
      clearInterval(meshTimer);
      meshTimer = null;
    }
    for (const entry of [...live.values()]) teardown(entry);
    for (const ws of workspaces.values()) { try { ws.dirWatcher?.close(); } catch { /* closed */ } }
    workspaces.clear();
  }

  /** Webhook hit: find the flow whose derived token matches; fire it. */
  function webhook(token) {
    for (const entry of live.values()) {
      if (entry.trigger.kind !== "webhook" || !entry.trigger.enabled) continue;
      if (webhookToken(secret, entry.cwd, entry.name) === token) {
        const ok = fire(entry, "webhook");
        return { ok: true, cwd: entry.cwd, name: entry.name, fired: ok };
      }
    }
    return { error: "no_hook" };
  }

  /** Summary for the UI: per (cwd,flow) the armed triggers, their last fire,
   *  and — when the last launch failed — the error and the scheduled retry. */
  function status(cwd) {
    const out = [];
    for (const entry of live.values()) {
      if (cwd && entry.cwd !== cwd) continue;
      const fk = flowKey(entry.cwd, entry.name);
      const row = {
        cwd: entry.cwd,
        name: entry.name,
        kind: entry.trigger.kind,
        enabled: entry.trigger.enabled,
        detail: describe(entry.trigger),
        last: fired[entry.key] ?? null,
      };
      if (failures[fk]) {
        row.error = failures[fk].error;
        row.retry_at = retryAt(fk);
      }
      if (entry.trigger.kind === "webhook") row.hook = `/hooks/${webhookToken(secret, entry.cwd, entry.name)}`;
      out.push(row);
    }
    return out;
  }

  return { addWorkspace, reload, onTick, pollMesh, start, stop, webhook, status };
}

function describe(t) {
  if (t.kind === "schedule") return t.every ? `every ${t.every} min` : `daily at ${t.daily_at}${t.weekday !== undefined ? ` (weekday ${t.weekday})` : ""}`;
  if (t.kind === "watch") return `watch ${t.path ?? "."}`;
  if (t.kind === "mesh") return `mesh ${t.node}${t.from ? ` from ${t.from}` : ""}`;
  return t.kind;
}
