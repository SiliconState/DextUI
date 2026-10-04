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
  for (const change of [{ name: "../bad" }, { rev: 0 }, { at: "tomorrow" }, { at: "2026-02-30T12:00:00Z" }, { at: "2026-01-01T12:00:00" }, { session: "core-id" }, { prompt: " " }, { prompt: "x".repeat(100001) }]) assert.ok(validateTimer(timer(change)).error);
  assert.equal(writeTimer(cwd, timer(), { expectedRev: 0 }).timer.rev, 1);
  assert.equal(writeTimer(cwd, timer(), { expectedRev: 0 }).error, "stale_rev");
  assert.equal(writeTimer(cwd, timer({ prompt: "new" }), { expectedRev: 1 }).timer.rev, 2);
  assert.equal(readTimer(cwd, "check-ci").timer.prompt, "new");
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
