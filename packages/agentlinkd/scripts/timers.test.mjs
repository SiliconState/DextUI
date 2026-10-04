import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateTimer, writeTimer, readTimer, listTimers } from "../src/timers.mjs";
import { createScheduler } from "../src/triggers.mjs";
import { durableHost, sleep, until } from "./durable-harness.mjs";
const timer = (overrides = {}) => ({ name: "check-ci", at: "2026-01-01T12:00:00Z", session: "sess_123", prompt: "Check CI", ...overrides });
function dirs(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dextui-timers-"));
  const cwd = path.join(root, "workspace"), stateDir = path.join(root, "state");
  fs.mkdirSync(cwd); fs.mkdirSync(stateDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, cwd, stateDir };
}

test("timer validation, rev CAS, atomic IO, caps and symlink refusal", (t) => {
  const { root, cwd } = dirs(t);
  assert.equal(validateTimer(timer()).ok, true);
  for (const change of [{ name: "../bad" }, { rev: 0 }, { rev: null }, { at: "tomorrow" }, { at: "2026-02-30T12:00:00Z" }, { at: "0000-01-01T00:00:00+01:00" }, { at: "2026-01-01T12:00:00" }, { session: "core-id" }, { prompt: " " }, { prompt: "x".repeat(100001) }]) assert.ok(validateTimer(timer(change)).error);
  assert.equal(writeTimer(cwd, timer(), { expectedRev: 0 }).timer.rev, 1);
  assert.equal(writeTimer(cwd, timer(), { expectedRev: 0 }).error, "stale_rev");
  assert.equal(writeTimer(cwd, timer({ prompt: "new" }), { expectedRev: 1 }).timer.rev, 2);
  assert.equal(readTimer(cwd, "check-ci").timer.prompt, "new");
  assert.equal(writeTimer(cwd, timer({ prompt: "🌍".repeat(40000) })).error, "too_large");
  assert.equal(readTimer(cwd, "check-ci").timer.prompt, "new", "oversized writes leave the previous file intact");
  assert.equal(readTimer(cwd, null).error, "bad_name");
  const max = path.join(cwd, ".dext/timers/max-rev.timer.json");
  fs.writeFileSync(max, JSON.stringify(timer({ name: "max-rev", rev: Number.MAX_SAFE_INTEGER })));
  assert.equal(writeTimer(cwd, timer({ name: "max-rev" })).error, "bad_rev");
  fs.unlinkSync(max);
  const dir = path.join(cwd, ".dext/timers");
  assert.deepEqual(fs.readdirSync(dir), ["check-ci.timer.json"]);
  fs.writeFileSync(path.join(root, "outside.json"), JSON.stringify(timer()));
  fs.symlinkSync(path.join(root, "outside.json"), path.join(dir, "linked.timer.json"));
  fs.writeFileSync(path.join(dir, "big.timer.json"), "x".repeat(128 * 1024 + 1));
  fs.writeFileSync(path.join(dir, "torn.timer.json"), "{");
  assert.equal(listTimers(cwd).length, 1);
  assert.ok(writeTimer(cwd, timer({ name: "linked" })).error);
  fs.renameSync(dir, dir + "-real"); fs.symlinkSync(dir + "-real", dir);
  assert.deepEqual(listTimers(cwd), []);
});

test("at triggers catch up once, persist slots, refuse stale edits and allow later rev", async (t) => {
  const { cwd, stateDir } = dirs(t); const sent = [], events = [];
  writeTimer(cwd, timer());
  writeTimer(cwd, timer({ name: "future", at: "2099-01-01T00:00:00Z" }));
  const make = () => createScheduler({ stateDir, secret: "test", startRun: () => {}, submitTimer: (_cwd, value, nonce) => { sent.push(nonce); return { ok: true }; }, broadcast: (_event, data) => events.push(data) });
  let s = make(); t.after(() => s.stop()); s.addWorkspace(cwd); s.start();
  await until(() => sent.length === 1); await until(() => events.some((e) => e.phase === "fired"));
  assert.equal(sent[0], "timer:check-ci:2026-01-01T12:00:00.000Z");
  s.onTick(); await sleep(30); assert.equal(sent.length, 1);
  s.stop(); s = make(); s.addWorkspace(cwd); s.start(); await sleep(30);
  assert.equal(sent.length, 1, "restart cannot refire delivered slot");
  const file = path.join(cwd, ".dext/timers/check-ci.timer.json");
  fs.writeFileSync(file, JSON.stringify(timer({ prompt: "same-rev edit" })));
  s.pollTimers(); await sleep(30);
  assert.ok(events.some((e) => e.error === "stale_rev")); assert.equal(sent.length, 1);
  fs.writeFileSync(file, JSON.stringify(timer({ rev: 2, at: "2026-01-02T12:00:00Z" })));
  s.pollTimers(); await until(() => sent.length === 2);
});

test("timer failures retry without overlapping submits; scheduler persistence must succeed", async (t) => {
  const { cwd, stateDir } = dirs(t); writeTimer(cwd, timer());
  let calls = 0, finish;
  const s = createScheduler({ stateDir, secret: "test", startRun: () => {}, submitTimer: () => { calls++; return new Promise((r) => finish = r); } });
  t.after(() => s.stop()); s.addWorkspace(cwd); s.pollTimers(); s.pollTimers();
  await until(() => calls === 1); finish({ error: "busy" }); await sleep(30);
  s.pollTimers(); await until(() => calls === 2); finish({ ok: true }); await sleep(30);
  s.pollTimers(); await sleep(30); assert.equal(calls, 2);
  writeTimer(cwd, timer({ name: "no-state" }));
  const file = path.join(stateDir, "triggers.json"); fs.unlinkSync(file); fs.symlinkSync(path.join(stateDir, "elsewhere"), file);
  s.pollTimers(); await sleep(30); assert.equal(calls, 2, "no dispatch without durable revision acceptance");
});

for (const action of ["delete", "stop", "reschedule"]) test(`queued timer dispatch is cancelled by ${action}`, async (t) => {
  const { cwd, stateDir } = dirs(t); writeTimer(cwd, timer());
  let sent = 0;
  const s = createScheduler({ stateDir, startRun: () => {}, submitTimer: () => { sent++; return { ok: true }; } });
  t.after(() => s.stop()); s.addWorkspace(cwd); s.pollTimers();
  if (action === "delete") fs.unlinkSync(path.join(cwd, ".dext/timers/check-ci.timer.json"));
  if (action === "stop") s.stop();
  if (action === "reschedule") writeTimer(cwd, timer({ at: "2099-01-01T00:00:00Z" }));
  await sleep(30);
  assert.equal(sent, 0);
});

for (const raw of ["{", "null", "[]", JSON.stringify({ fired: 123 }), JSON.stringify({ fired: {}, timerRecords: null }), JSON.stringify({ fired: {}, timerRecords: { invalid: { rev: 1, fingerprint: "x", delivered: null } } })]) test(`broken timer state fails closed: ${raw.slice(0, 30)}`, async (t) => {
  const { cwd, stateDir } = dirs(t); writeTimer(cwd, timer());
  fs.writeFileSync(path.join(stateDir, "triggers.json"), raw);
  let sent = 0; const logs = [];
  const s = createScheduler({ stateDir, startRun: () => {}, submitTimer: () => { sent++; return { ok: true }; }, log: (m) => logs.push(m) });
  t.after(() => s.stop()); s.addWorkspace(cwd); s.pollTimers(); await sleep(30);
  assert.equal(sent, 0); assert.ok(logs.some((m) => m.includes("timer delivery disabled")));
});

test("timer completion requires explicit durable acceptance", async (t) => {
  const { cwd, stateDir } = dirs(t); writeTimer(cwd, timer());
  const events = []; let calls = 0;
  const s = createScheduler({ stateDir, startRun: () => {}, submitTimer: () => { calls++; }, broadcast: (_e, data) => events.push(data) });
  t.after(() => s.stop()); s.addWorkspace(cwd); s.pollTimers(); await sleep(30); s.pollTimers(); await sleep(30);
  assert.equal(calls, 2); assert.ok(events.some((e) => e.phase === "failed"));
  assert.ok(!events.some((e) => e.phase === "fired"));
});

test("startup recovery takes priority over a due timer in the same session", async (t) => {
  const h = await durableHost(t, { bridge: true, args: ["--timers", "--auto-resume"], env: { FAKE_DEXT_TURN_DELAY_MS: "3000" } });
  const c = await h.client(); const id = await h.open(c);
  c.send("prompt.submit", { session: id, text: "unfinished", nonce: "timerrecover1" });
  await c.wait((e) => e.event === "turn_start");
  await h.stop("SIGKILL");
  writeTimer(h.cwd, timer({ session: id }));
  await h.start();
  await until(() => h.journal(id).filter((e) => e.event === "turn_start").length === 2);
  const messages = h.journal(id).filter((e) => e.event === "user_message");
  assert.equal(messages.length, 2);
  assert.equal(messages[1].data.nonce, "resume:timerrecover1");
  assert.ok(!messages.some((e) => e.data.nonce?.startsWith("timer:")));
});

for (const enabled of [false, true]) test(`host timer startup delivery is ${enabled ? "enabled once" : "off by default"}`, async (t) => {
  const h = await durableHost(t, { args: enabled ? ["--timers"] : [] });
  const c = await h.client(); const id = await h.open(c);
  await h.stop();
  writeTimer(h.cwd, timer({ session: id }));
  await h.start();
  if (!enabled) { await sleep(200); assert.equal(h.journal(id).filter((e) => e.event === "user_message").length, 0); return; }
  const nonce = "timer:check-ci:2026-01-01T12:00:00.000Z";
  await until(() => h.journal(id).some((e) => e.event === "user_message" && e.data.nonce === nonce));
  await until(() => h.journal(id).some((e) => e.event === "turn_end"));
  await h.stop();
  // Simulate loss of scheduler completion after durable prompt acceptance,
  // and an old prompt outside client nonce TTL. The journal still dedups it.
  fs.unlinkSync(path.join(h.state, "triggers.json"));
  const file = path.join(h.state, "journals", `${id}.jsonl`);
  fs.writeFileSync(file, h.journal(id).map((e) => JSON.stringify({ ...e, ts: Date.now() - 86400000 })).join("\n") + "\n");
  await h.start(); await sleep(200);
  assert.equal(h.journal(id).filter((e) => e.event === "user_message" && e.data.nonce === nonce).length, 1);
});
