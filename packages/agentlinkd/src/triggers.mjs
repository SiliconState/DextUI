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
// Last-fire times persist in <state>/triggers.json so a daily schedule does
// not refire after a restart within the same day. Fires are serialized per
// flow: a flow already started by a trigger in the last `cooldown` is skipped.
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

/** Pure: is a schedule trigger due, given its last fire? */
export function scheduleDue(t, lastFired, now) {
  if (t.every) return !lastFired || now - lastFired >= t.every * 60_000;
  if (t.daily_at) {
    // Due when the most recent scheduled slot ≤ now is after the last fire.
    const next = nextDaily(now, t.daily_at, t.weekday);
    const period = t.weekday === undefined ? 86_400_000 : 7 * 86_400_000;
    const lastSlot = next - period;
    return lastSlot <= now && (!lastFired || lastFired < lastSlot);
  }
  return false;
}

export function createScheduler({ stateDir, secret, startRun, meshBin = "mesh", log = () => {}, broadcast = () => {} }) {
  const stateFile = path.join(stateDir, "triggers.json");
  let fired = {}; // key -> last fire ms
  try {
    fired = JSON.parse(fs.readFileSync(stateFile, "utf8")) || {};
  } catch {
    fired = {};
  }
  function persist() {
    try {
      fs.writeFileSync(stateFile, JSON.stringify(fired));
    } catch (err) {
      log(`triggers: cannot persist ${stateFile}: ${err.message}`);
    }
  }

  const workspaces = new Map(); // cwd -> { flows: Map<name, trigger[]>, watchers: [] , dirWatcher }
  const live = new Map(); // key -> { cwd, name, trigger, timer?, watcher?, last }
  const meshQueue = new Map(); // node -> Set<key>
  let tick = null;

  function key(cwd, name, i) {
    return `${cwd}\u0000${name}\u0000${i}`;
  }

  function fire(entry, reason) {
    const k = `${entry.cwd}\u0000${entry.name}`;
    const now = Date.now();
    if (fired[k] && now - fired[k] < COOLDOWN_MS) return false;
    fired[k] = now;
    fired[entry.key] = now;
    persist();
    log(`trigger ${entry.trigger.kind} → ${entry.name} (${reason})`);
    broadcast("x-agentlinkd.flows.trigger", { cwd: entry.cwd, name: entry.name, kind: entry.trigger.kind, reason, at: now });
    Promise.resolve(startRun(entry.cwd, entry.name, { by: `trigger:${entry.trigger.kind}`, reason }))
      .then((r) => { if (r?.error) log(`trigger ${entry.name}: run failed: ${r.error}`); })
      .catch((err) => log(`trigger ${entry.name}: ${err.message}`));
    return true;
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
      if (scheduleDue(t, fired[entry.key], now)) fire(entry, t.every ? `every ${t.every} min` : `daily at ${t.daily_at}`);
    }
  }

  let meshBusy = false;
  function pollMesh() {
    if (meshBusy || meshQueue.size === 0) return;
    meshBusy = true;
    const nodes = [...meshQueue.keys()];
    let pending = nodes.length;
    for (const node of nodes) {
      execFile(meshBin, ["recv", "--node", node, "--timeout", "0", "--max", "10"], { timeout: 10_000, maxBuffer: 256 * 1024 }, (err, stdout) => {
        if (!err && stdout) {
          const msgs = String(stdout).split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          for (const msg of msgs) {
            for (const k of meshQueue.get(node) ?? []) {
              const entry = live.get(k);
              if (!entry) continue;
              if (entry.trigger.from && msg.from !== entry.trigger.from) continue;
              fire(entry, `message from ${msg.from ?? "?"}: ${String(msg.body ?? "").slice(0, 80)}`);
            }
          }
        }
        if (--pending === 0) meshBusy = false;
      });
    }
  }

  function start() {
    if (tick) return;
    tick = setInterval(() => { onTick(); pollMesh(); }, TICK_MS);
    tick.unref?.();
    setTimeout(pollMesh, 2000).unref?.();
    // mesh polls a bit faster than the schedule tick
    const mp = setInterval(pollMesh, MESH_POLL_MS);
    mp.unref?.();
  }

  function stop() {
    clearInterval(tick);
    tick = null;
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

  /** Summary for the UI: per (cwd,flow) the armed triggers and their last fire. */
  function status(cwd) {
    const out = [];
    for (const entry of live.values()) {
      if (cwd && entry.cwd !== cwd) continue;
      out.push({
        cwd: entry.cwd,
        name: entry.name,
        kind: entry.trigger.kind,
        enabled: entry.trigger.enabled,
        detail: entry.trigger.every ? `every ${entry.trigger.every} min` : entry.trigger.daily_at ? `daily at ${entry.trigger.daily_at}` : entry.trigger.path ? `watch ${entry.trigger.path}` : entry.trigger.node ? `mesh ${entry.trigger.node}` : "webhook",
        last: fired[entry.key] ?? null,
        ...(entry.trigger.kind === "webhook" ? { hook: `/hooks/${webhookToken(secret, entry.cwd, entry.name)}` } : {}),
      });
    }
    return out;
  }

  return { addWorkspace, reload, start, stop, webhook, status, onTick, fire, live };
}
