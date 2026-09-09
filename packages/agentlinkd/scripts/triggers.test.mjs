// Triggers: validation, schedule math, scheduler behaviour (watch, reload,
// cooldown, persisted last-fire), derived webhook tokens, and the live host
// /hooks/<token> surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { validateFlow, validateTrigger, writeFlow } from "../src/flows.mjs";
import { createScheduler, nextDaily, scheduleDue, webhookToken } from "../src/triggers.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.resolve("packages/agentlinkd");

const FLOW = (triggers) => ({
  version: 1,
  name: "nightly",
  title: "Nightly",
  nodes: [{ id: "note", type: "gate", question: "ok?" }],
  edges: [],
  triggers,
});

test("validateTrigger: kinds, bounds, watch path confinement, mesh names", () => {
  assert.deepEqual(validateTrigger({ kind: "schedule", every: 60 }, 0).trigger, { kind: "schedule", enabled: true, every: 60 });
  assert.deepEqual(validateTrigger({ kind: "schedule", daily_at: "07:30", weekday: 1, enabled: false }, 0).trigger, { kind: "schedule", enabled: false, daily_at: "07:30", weekday: 1 });
  assert.match(validateTrigger({ kind: "schedule", every: 5 }, 0).error, /15\.\.10080/);
  assert.match(validateTrigger({ kind: "schedule", daily_at: "25:00" }, 0).error, /every .* or daily_at/);
  assert.match(validateTrigger({ kind: "schedule", daily_at: "07:00", weekday: 7 }, 0).error, /weekday/);
  assert.deepEqual(validateTrigger({ kind: "watch", path: "./receipts/2026" }, 0).trigger, { kind: "watch", enabled: true, path: "receipts/2026" });
  assert.equal(validateTrigger({ kind: "watch" }, 0).trigger.path, ".");
  assert.match(validateTrigger({ kind: "watch", path: "../x" }, 0).error, /relative folder/);
  assert.match(validateTrigger({ kind: "watch", path: ".dext" }, 0).error, /dot-segments/);
  assert.match(validateTrigger({ kind: "watch", path: "/etc" }, 0).error, /relative folder/);
  assert.deepEqual(validateTrigger({ kind: "mesh", node: "flows", from: "accountant" }, 0).trigger, { kind: "mesh", enabled: true, node: "flows", from: "accountant" });
  assert.match(validateTrigger({ kind: "mesh" }, 0).error, /node name/);
  assert.deepEqual(validateTrigger({ kind: "webhook" }, 0).trigger, { kind: "webhook", enabled: true });
  assert.match(validateTrigger({ kind: "cron" }, 0).error, /unknown kind/);
  const flow = validateFlow(FLOW([{ kind: "webhook" }, { kind: "schedule", every: 30 }]));
  assert.equal(flow.ok, true);
  assert.equal(flow.flow.triggers.length, 2);
  assert.match(validateFlow(FLOW(Array(9).fill({ kind: "webhook" }))).error, /at most 8 triggers/);
  assert.equal(validateFlow(FLOW([])).flow.triggers, undefined, "empty list is dropped");
});

test("schedule math: every N minutes; daily_at slots; weekday; persisted last-fire", () => {
  const t0 = Date.UTC(2026, 8, 6, 12, 0, 0); // any fixed instant
  assert.equal(scheduleDue({ every: 60 }, undefined, t0), true, "never fired → due");
  assert.equal(scheduleDue({ every: 60 }, t0 - 59 * 60_000, t0), false);
  assert.equal(scheduleDue({ every: 60 }, t0 - 60 * 60_000, t0), true);

  // daily_at: build "now" as local 09:05 today; slot 09:00 today is the last slot.
  const now = new Date();
  now.setHours(9, 5, 0, 0);
  const slot = new Date(now);
  slot.setHours(9, 0, 0, 0);
  assert.equal(nextDaily(now.getTime(), "09:00"), slot.getTime() + 86_400_000, "next is tomorrow 09:00");
  assert.equal(scheduleDue({ daily_at: "09:00" }, undefined, now.getTime()), true);
  assert.equal(scheduleDue({ daily_at: "09:00" }, slot.getTime() + 60_000, now.getTime()), false, "fired after this slot → not due");
  assert.equal(scheduleDue({ daily_at: "09:00" }, slot.getTime() - 86_400_000, now.getTime()), true, "fired yesterday → due");
  const early = new Date(now);
  early.setHours(8, 55, 0, 0);
  assert.equal(scheduleDue({ daily_at: "09:00" }, slot.getTime() - 86_400_000, early.getTime()), false, "before today's slot → not due");
  // weekday: the next Monday 09:00 is on a Monday
  const mon = new Date(nextDaily(now.getTime(), "09:00", 1));
  assert.equal(mon.getDay(), 1);
  assert.equal(mon.getHours(), 9);
});

test("webhookToken: derived, stable, distinct per flow and per secret, url-safe", () => {
  const a = webhookToken("s", "/w", "f");
  assert.equal(a, webhookToken("s", "/w", "f"));
  assert.notEqual(a, webhookToken("s", "/w", "g"));
  assert.notEqual(a, webhookToken("t", "/w", "f"));
  assert.match(a, /^[A-Za-z0-9_-]{32}$/);
});

test("scheduler: arms triggers from flow files, reloads, fires with cooldown, watch fires on file change, persists last-fire", { timeout: 20000 }, async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "trig-ws-"));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "trig-state-"));
  t.after(() => { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(cwd, "inbox"));
  const runs = [];
  const events = [];
  const mk = () => createScheduler({ stateDir: state, secret: "pair", startRun: (c, n, o) => { runs.push({ c, n, o }); return { ok: true }; }, broadcast: (e, d) => events.push({ e, d }) });
  let s = mk();
  t.after(() => s.stop());

  assert.equal(s.addWorkspace(cwd), undefined);
  assert.deepEqual(s.status(cwd), [], "no flows yet");

  writeFlow(cwd, FLOW([{ kind: "schedule", every: 15 }, { kind: "webhook" }, { kind: "watch", path: "inbox" }, { kind: "schedule", every: 30, enabled: false }]));
  assert.equal(s.reload(cwd), 4);
  const st = s.status(cwd);
  assert.deepEqual(st.map((x) => [x.kind, x.enabled, x.detail]), [["schedule", true, "every 15 min"], ["webhook", true, "webhook"], ["watch", true, "watch inbox"], ["schedule", false, "every 30 min"]]);
  assert.equal(st[1].hook, `/hooks/${webhookToken("pair", cwd, "nightly")}`);

  // Tick: the enabled schedule fires once; the disabled one never; cooldown blocks a second fire.
  s.onTick();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].n, "nightly");
  assert.equal(runs[0].o.by, "trigger:schedule");
  assert.equal(events[0].e, "x-agentlinkd.flows.trigger");
  s.onTick();
  assert.equal(runs.length, 1, "cooldown (same flow within a minute)");
  assert.ok(fs.existsSync(path.join(state, "triggers.json")), "last-fire persisted");

  // Webhook: right token fires (cooldown → fired:false but recognised), wrong token → no_hook.
  const hook = s.webhook(webhookToken("pair", cwd, "nightly"));
  assert.equal(hook.ok, true);
  assert.equal(hook.fired, false, "still inside the cooldown");
  assert.equal(s.webhook("x".repeat(32)).error, "no_hook");

  // A restart keeps the last-fire: a fresh scheduler does not refire immediately.
  // Let the first launch COMPLETE first — last-fire and the schedule slot are
  // persisted on success (a failed attempt is not a fire), in a microtask.
  await sleep(100);
  s.stop();
  s = mk();
  s.addWorkspace(cwd);
  s.onTick();
  assert.equal(runs.length, 1, "persisted last-fire survives restart");

  // Watch: a new file under inbox/ fires after the debounce (dotfiles ignored).
  // Bypass the cooldown by pretending the last fire was long ago.
  const persisted = JSON.parse(fs.readFileSync(path.join(state, "triggers.json"), "utf8"));
  for (const k of Object.keys(persisted)) persisted[k] = Date.now() - 10 * 60_000;
  fs.writeFileSync(path.join(state, "triggers.json"), JSON.stringify(persisted));
  s.stop();
  s = mk();
  s.addWorkspace(cwd);
  fs.writeFileSync(path.join(cwd, "inbox", ".hidden.txt"), "x");
  fs.writeFileSync(path.join(cwd, "inbox", "receipt.txt"), "x");
  for (let i = 0; i < 80 && runs.length < 2; i++) await sleep(100);
  assert.equal(runs.length, 2, "watch fired once for the visible file");
  assert.match(runs[1].o.reason, /files changed under inbox/);
  assert.equal(runs[1].o.by, "trigger:watch");

  // Reload after the flow loses its triggers → nothing armed.
  writeFlow(cwd, FLOW([]));
  assert.equal(s.reload(cwd), 0);
  assert.deepEqual(s.status(cwd), []);
});

// ---------- lifecycle honesty: outcomes, backoff, queued-work invalidation ----------

test("scheduler: a failed launch is a failure with backoff — never a fire or a slot", { timeout: 15000 }, async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "trig-fail-"));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "trig-state-"));
  t.after(() => { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); });
  let resolveRun;
  const runs = [];
  const events = [];
  const s = createScheduler({
    stateDir: state,
    secret: "p",
    // startRun now resolves with the LAUNCH outcome (the host wiring awaits
    // the tracked process): exit 7 must surface here as {error}.
    startRun: () => new Promise((res) => { runs.push(1); resolveRun = res; }),
    broadcast: (e, d) => events.push({ e, d }),
  });
  t.after(() => s.stop());
  writeFlow(cwd, FLOW([{ kind: "schedule", every: 15 }]));
  s.addWorkspace(cwd);
  s.onTick();
  assert.equal(runs.length, 1, "fired once");
  resolveRun({ error: "crew exited with code 7" });
  await sleep(120);
  const persisted = JSON.parse(fs.readFileSync(path.join(state, "triggers.json"), "utf8"));
  const failure = Object.values(persisted.failures ?? {})[0];
  assert.ok(failure, "failure recorded");
  assert.match(failure.error, /code 7/);
  assert.deepEqual(persisted.slots, {}, "a failed run never marks the schedule slot");
  assert.ok(!Object.keys(persisted.fired).length, "a failed run is not a fire");
  const failed = events.find((x) => x.e === "x-agentlinkd.flows.trigger" && x.d.phase === "failed");
  assert.ok(failed, "phase:failed broadcast");
  assert.ok(failed.d.retry_at > Date.now() - 1000, "failure carries a retry deadline");
  s.onTick();
  assert.equal(runs.length, 1, "backoff blocks an immediate refire");
});

test("scheduler: queued webhook work does not fire after the trigger is disabled", { timeout: 15000 }, async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "trig-dis-"));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "trig-state-"));
  t.after(() => { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); });
  let resolveRun;
  const runs = [];
  const s = createScheduler({
    stateDir: state,
    secret: "p",
    startRun: () => new Promise((res) => { runs.push(1); resolveRun = res; }),
    broadcast: () => {},
  });
  t.after(() => s.stop());
  writeFlow(cwd, FLOW([{ kind: "webhook" }]));
  s.addWorkspace(cwd);
  const token = webhookToken("p", cwd, "nightly");
  const first = s.webhook(token);
  assert.equal(first.fired, true, "first webhook fires");
  // Second webhook while the launch is in flight → coalesced pending work.
  const second = s.webhook(token);
  assert.equal(second.fired, false, "second webhook coalesces (busy)");
  // Disable the trigger while the run is in flight, then let it finish.
  writeFlow(cwd, FLOW([{ kind: "webhook", enabled: false }]));
  s.reload(cwd);
  resolveRun({ ok: true });
  await sleep(120);
  s.onTick(); // drain paths also run on ticks
  await sleep(50);
  assert.equal(runs.length, 1, "queued work was invalidated by the disable, not executed");
});

// ---------- host surface ----------

test("host: flows.list carries triggers; POST /hooks/<token> fires, wrong token 404 + rate-limits, GET 405", { timeout: 30000 }, async (t) => {
  const temp = fs.mkdtempSync(path.join(root, ".flows-test-"));
  const cwd = path.join(temp, "workspace");
  fs.mkdirSync(cwd, { recursive: true });
  const token = "trigger-test-pairing";
  const child = spawn(process.execPath, [path.join(root, "src/server.mjs"), "--port=0", `--token=${token}`, `--cwd=${cwd}`, `--state-dir=${path.join(temp, "state")}`, `--dext=${path.join(root, "scripts/fake-dext.mjs")}`, "--approval=auto-read"], {
    env: { ...process.env, DEXT_HOME: path.join(temp, "dext"), FAKE_PACKS_ROOT: path.join(temp, "shelves"), PATH: path.dirname(process.execPath) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) try { ws.close(); } catch { /* closed */ }
    if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([exited, sleep(4000)]); }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  let base = "";
  for (;;) {
    const [chunk] = await once(child.stdout, "data");
    const m = /listening on (http:\/\/[^\s]+)/.exec(chunk.toString());
    if (m) { base = m[1]; break; }
  }
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  sockets.push(ws);
  const events = [];
  ws.addEventListener("message", (m) => events.push(JSON.parse(m.data)));
  await once(ws, "open");
  const send = (cmd, extra = {}) => ws.send(JSON.stringify({ v: 1, cmd, ...extra }));
  const wait = async (pred, from = 0) => {
    for (let i = 0; i < 400; i++) {
      const hit = events.slice(from).find(pred);
      if (hit) return hit;
      await sleep(25);
    }
    throw new Error(`timeout; last: ${JSON.stringify(events.slice(-4))}`);
  };
  send("hello", { token });
  await wait((e) => e.event === "hello_ok");

  let mark = events.length;
  send("x-agentlinkd.flows.put", { flow: FLOW([{ kind: "webhook" }, { kind: "schedule", daily_at: "03:00" }]) });
  const changed = await wait((e) => e.event === "x-agentlinkd.flows.changed", mark);
  assert.equal(changed.data.flows[0].triggers, 2, "summary counts triggers");
  assert.equal(changed.data.triggers.length, 2, "armed triggers ride the broadcast");
  const hook = changed.data.triggers.find((x) => x.kind === "webhook").hook;
  assert.match(hook, /^\/hooks\/[A-Za-z0-9_-]{32}$/);
  assert.equal(hook, `/hooks/${webhookToken(token, cwd, "nightly")}`, "token derived from the pairing token");

  mark = events.length;
  send("x-agentlinkd.flows.list");
  const list = await wait((e) => e.event === "x-agentlinkd.flows.list", mark);
  assert.equal(list.data.triggers.length, 2);

  // No crew binary on the test host → the run is refused honestly, but the
  // trigger itself fires and is broadcast (that is the scheduler's job).
  mark = events.length;
  const hit = await fetch(base + hook, { method: "POST" });
  assert.equal(hit.status, 202);
  assert.deepEqual(await hit.json(), { ok: true, flow: "nightly", fired: true });
  const fired = await wait((e) => e.event === "x-agentlinkd.flows.trigger", mark);
  assert.equal(fired.data.kind, "webhook");

  const again = await fetch(base + hook, { method: "POST" });
  assert.equal(again.status, 200, "cooldown: acknowledged, not fired");
  assert.equal((await again.json()).fired, false);

  assert.equal((await fetch(base + hook)).status, 405);
  assert.equal((await fetch(base + "/hooks/" + "z".repeat(32), { method: "POST" })).status, 404);
  assert.equal((await fetch(base + "/hooks/short", { method: "POST" })).status, 404);
});
