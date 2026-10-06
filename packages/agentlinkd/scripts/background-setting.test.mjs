// All settings, roots, prompts and children are fixture-owned; no provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { durableHost, sleep } from "./durable-harness.mjs";

const feature = { FAKE_DEXT_BACKGROUND_SETTING: "1", DEXT_BACKGROUND_COMPACT: "1" };
const setting = (enabled, pending = false) => (e) => e.event === "x-agentlinkd.background_compaction_setting" && e.data.enabled === enabled && e.data.pending === pending;
const error = (nonce) => (e) => e.event === "error" && e.data.nonce === nonce;
const ack = (nonce) => (e) => e.event === "cmd_ack" && e.data.nonce === nonce;

async function change(c, id, raw, nonce) {
  const at = c.events.length;
  c.send("slash", { session: id, raw, nonce });
  return c.wait(ack(nonce), at);
}

test("background preference defaults on, is scoped, saved, reconnectable and used before the first resumed prompt", async (t) => {
  const h = await durableHost(t, { bridge: true, env: { ...feature, FAKE_DEXT_PRE_READY_BACKGROUND: "1" } });
  const c = await h.client(), id = await h.open(c), other = await h.open(c);
  assert.ok(c.hello.data.capabilities.includes("background_compaction_setting"));
  assert.equal(h.index().find((s) => s.id === id).backgroundCompact, true);
  const changed = await change(c, id, "/compact background off", "settingOff1");
  assert.equal(changed.data.ok, true);
  assert.equal(h.index().find((s) => s.id === id).backgroundCompact, false);
  assert.equal(h.index().find((s) => s.id === other).backgroundCompact, true);
  assert.equal(h.index().find((s) => s.id === id).turns, 0);
  assert.ok(!h.journal(id).some((e) => ["user_message", "turn_start", "compact_start", "usage_update", "background_compaction_setting"].includes(e.event)));
  const b = await h.client(); b.send("session.subscribe", { id });
  const snap = await b.wait((e) => e.event === "session.snapshot");
  assert.equal(snap.data.meta.background_compact, false);
  assert.equal(snap.data.background_compact_pending, false);
  const at = b.events.length; b.send("session.subscribe", { id, since_seq: snap.data.last_seq });
  await b.wait(setting(false), at);
  await change(c, id, "/compact background status", "settingStatus1");
  await h.stop(); await h.start();
  const next = await h.client();
  assert.equal(next.hello.data.sessions.find((s) => s.id === id).background_compact, false);
  next.send("session.subscribe", { id }); await next.wait((e) => e.event === "session.snapshot");
  next.send("prompt.submit", { session: id, text: "BG_START after restart", nonce: "settingPrompt1" });
  await next.wait((e) => e.event === "turn_end");
  assert.ok(!next.events.some((e) => e.event === "background_compaction"));
  assert.ok(!next.events.some((e) => e.event === "background_compaction_setting" && e.data.enabled === true), "pre-ready restored value cannot override final ready/CLI setting");
  await change(next, id, "/compact background on", "settingOn1");
  assert.equal(h.index().find((s) => s.id === id).backgroundCompact, true);
});

test("disable cancels an idle summary and leaves ordinary manual compaction available", async (t) => {
  const h = await durableHost(t, { bridge: true, env: feature }); const c = await h.client(), id = await h.open(c);
  c.send("prompt.submit", { session: id, text: "BG_START" });
  await c.wait((e) => e.event === "background_compaction" && e.data.phase === "running");
  await c.wait((e) => e.event === "turn_end");
  const at = c.events.length;
  await change(c, id, "/compact background off", "cancelSetting1");
  assert.ok(c.events.slice(at).some((e) => e.event === "background_compaction" && e.data.phase === "cancelled"));
  assert.ok(!c.events.slice(at).some((e) => ["compact_start", "compact_end", "turn_start", "turn_end"].includes(e.event)));
  c.send("slash", { session: id, raw: "/compact", nonce: "manualAfterOff1" });
  await c.wait((e) => e.event === "compact_end", at);
  assert.equal(h.index()[0].backgroundCompact, false);
});

for (const raw of ["/compact background on", "/compact background off", "/compact background status"]) test(`busy background command is refused without success ACK: ${raw}`, async (t) => {
  const h = await durableHost(t, { bridge: true, env: { ...feature, FAKE_DEXT_TURN_DELAY_MS: "600" } }); const c = await h.client(), id = await h.open(c);
  c.send("prompt.submit", { session: id, text: "SLOW foreground" }); await c.wait((e) => e.event === "turn_start");
  const at = c.events.length; c.send("slash", { session: id, raw, nonce: "busySetting1" });
  assert.equal((await c.wait(error("busySetting1"), at)).data.code, "busy");
  assert.ok(!c.events.slice(at).some(ack("busySetting1")));
  assert.equal(h.index()[0].backgroundCompact, true);
});

for (const mode of ["FAIL", "REFUSE", "EXIT"]) test(`core setting ${mode.toLowerCase()} never receives a success ACK, including same-nonce replay`, async (t) => {
  const h = await durableHost(t, { bridge: true, env: { ...feature, [`FAKE_DEXT_BACKGROUND_${mode}`]: "1" } }); const c = await h.client(), id = await h.open(c);
  const at = c.events.length; c.send("slash", { session: id, raw: "/compact background off", nonce: "failedSetting1" });
  await c.wait(error("failedSetting1"), at);
  assert.ok(!c.events.slice(at).some(ack("failedSetting1")));
  assert.equal(h.index()[0].backgroundCompact, mode === "FAIL" ? false : true, "failed save is resynced to safely-off memory; refusal/death never fabricates off");
  const replay = c.events.length; c.send("slash", { session: id, raw: "/compact background off", nonce: "failedSetting1" });
  assert.equal((await c.wait(error("failedSetting1"), replay)).data.duplicate, true);
  assert.ok(!c.events.slice(replay).some(ack("failedSetting1")));
});

for (const interrupt of [false, true]) test(`setting admission stays reserved while waiting for ready/confirmation${interrupt ? "; interrupt cancels" : "; restart defers"}`, async (t) => {
  const h = await durableHost(t, { bridge: true, env: { ...feature, FAKE_DEXT_READY_DELAY_MS: "400", FAKE_DEXT_BACKGROUND_DELAY_MS: "700" } }); const c = await h.client(), id = await h.open(c);
  c.send("slash", { session: id, raw: "/compact background off", nonce: "pendingSetting1" });
  await c.wait(setting(true, true));
  for (const [cmd, payload, nonce] of [
    ["prompt.submit", { text: "must not run under setting" }, "pendingPrompt1"],
    ["slash", { raw: "/compact background on" }, "pendingToggle1"],
    ["session.configure", { id, thinking_effort: "high" }, "pendingEffort1"],
    ["session.fork", { id }, "pendingFork1"],
  ]) {
    const at = c.events.length;
    c.send(cmd, { session: id, ...payload, nonce });
    const refused = await c.wait((e) => e.event === "error" && e.data.cmd === cmd && (cmd === "session.configure" || cmd === "session.fork" || e.data.nonce === nonce), at);
    assert.equal(refused.data.code, "busy");
  }
  const b = await h.client(); b.send("session.subscribe", { id });
  assert.equal((await b.wait((e) => e.event === "session.snapshot")).data.background_compact_pending, true);
  if (interrupt) {
    c.send("interrupt", { session: id }); await c.wait(error("pendingSetting1"));
    await sleep(900);
    assert.equal(h.index()[0].backgroundCompact, true);
    assert.ok(!c.events.some(ack("pendingSetting1")));
  } else {
    const response = await h.request("/__self/restart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "fixture setting boundary", force: false }) });
    const restart = await response.json(); assert.equal(restart.pending, true); assert.ok(restart.busy.some((b) => b.kind === "setting"));
    await c.wait(ack("pendingSetting1"));
    assert.equal(h.index()[0].backgroundCompact, false);
  }
  assert.ok(!h.journal(id).some((e) => e.event === "user_message"));
});

test("invalid CORE readiness retires bootstrap, ends a turn once and admits a clean retry", async (t) => {
  const h = await durableHost(t, { bridge: true, env: feature }); const c = await h.client(), id = await h.open(c);
  fs.mkdirSync(h.home, { recursive: true }); const invalid = path.join(h.home, "fake-invalid-ready"); fs.writeFileSync(invalid, "fixture");
  c.send("prompt.submit", { session: id, text: "Readiness must fail", nonce: "invalidReady1" });
  await c.wait((e) => e.event === "turn_end"); await sleep(100);
  assert.equal(h.journal(id).filter((e) => e.event === "turn_end").length, 1);
  assert.equal(h.index()[0].working, false);
  fs.rmSync(invalid);
  const at = c.events.length; c.send("prompt.submit", { session: id, text: "Clean retry", nonce: "validReady2" });
  assert.equal((await c.wait((e) => e.event === "turn_end", at)).data.failed, false);
  assert.equal(h.journal(id).filter((e) => e.event === "turn_end").length, 2);
});

test("legacy host metadata respects a saved core false preference over startup environment", async (t) => {
  const h = await durableHost(t, { bridge: true, env: feature, setup({ home, state, cwd }) {
    const dir = path.join(home, "projects/fixture/sessions/saved-off"); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "_latest.jsonl"), JSON.stringify({ version: 4, model: "alpha", session_id: "saved-off", sandbox: cwd, seat: { id: "dextui-1234" }, background_compact: false }) + "\n");
    fs.mkdirSync(state); fs.writeFileSync(path.join(state, "sessions.json"), JSON.stringify([{ id: "sess_123", cwd, seat: "dextui-1234", turns: 1 }]));
  } });
  const c = await h.client(); assert.equal(c.hello.data.sessions[0].background_compact, false);
  c.send("session.subscribe", { id: "sess_123" }); await c.wait((e) => e.event === "session.snapshot");
  c.send("prompt.submit", { session: "sess_123", text: "BG_START" }); await c.wait((e) => e.event === "turn_end");
  assert.ok(!c.events.some((e) => e.event === "background_compaction"));
});
