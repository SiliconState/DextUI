import { test } from "node:test";
import assert from "node:assert/strict";
import { backgroundState, acceptBackground, acceptBackgroundApplication, clearBackground } from "../src/background-compaction.mjs";
import { durableHost, sleep } from "./durable-harness.mjs";
const job = (phase = "running", overrides = {}) => ({ version: 1, session_id: "core-1", session_epoch: 1, job_id: "bg-1", origin_turn_id: "turn-1", phase, blocking: phase === "waiting", reason: "fixture", elapsed_ms: 10, wait_ms: 0, before_chars: 25000, usage_known: true, ...overrides });

test("child-owned background state validates and fences terminal, epoch and foreign jobs", () => {
  const s = backgroundState();
  for (const change of [{ version: 2 }, { session_id: "other" }, { session_epoch: -1 }, { blocking: true }, { before_chars: NaN }, { job_id: "" }, { phase: "unknown" }]) assert.equal(acceptBackground(s, job("running", change), "core-1"), false);
  assert.equal(acceptBackground(s, job(), "core-1"), true);
  assert.equal(acceptBackground(s, job("waiting"), "core-1"), true);
  assert.equal(acceptBackground(s, job("ready", { job_id: "other" }), "core-1"), false);
  clearBackground(s);
  assert.equal(acceptBackground(s, job("ready"), "core-1"), false);
  assert.equal(acceptBackground(s, job(), "core-1"), false);
  assert.equal(acceptBackground(s, job("running", { job_id: "bg-2", session_epoch: 0 }), "core-1"), false);
  assert.equal(acceptBackground(s, job("running", { job_id: "bg-2", session_epoch: 2 }), "core-1"), true);
  assert.equal(acceptBackground(s, job("applied", { job_id: "bg-2", session_epoch: 2 }), "core-1"), true);
  assert.equal(s.current, null);
});

test("committed application buffered through interrupt is accepted once without badge revival", () => {
  const s = backgroundState();
  assert.equal(acceptBackground(s, job(), "core-1"), true);
  clearBackground(s); // user interrupt raced with already persisted stdout
  assert.equal(acceptBackgroundApplication(s, "unknown"), false);
  assert.equal(acceptBackgroundApplication(s, "bg-1"), true);
  assert.equal(acceptBackgroundApplication(s, "bg-1"), false);
  assert.equal(s.current, null);
  assert.equal(acceptBackground(s, job("applied"), "core-1"), false);
  assert.equal(acceptBackgroundApplication(backgroundState(), "bg-1"), false, "replacement child has no known job");
});

test("host reconnect syncs background status without journaling it or claiming work", async (t) => {
  const h = await durableHost(t, { bridge: true }); const a = await h.client(); const id = await h.open(a);
  a.send("prompt.submit", { session: id, text: "BG_START" });
  const bg = await a.wait((e) => e.event === "background_compaction" && e.data.phase === "running");
  await a.wait((e) => e.event === "turn_end");
  assert.equal(bg.seq, undefined); assert.equal(h.index()[0].working, false);
  assert.ok(!h.journal(id).some((e) => e.event === "background_compaction"));
  const b = await h.client(); b.send("session.subscribe", { id });
  const snap = await b.wait((e) => e.event === "session.snapshot");
  assert.equal(snap.data.background_compaction.job_id, bg.data.job_id);
  assert.equal(snap.data.working, false); assert.equal(snap.data.compacting, false);
  const at = b.events.length;
  b.send("session.subscribe", { id, since_seq: snap.data.last_seq });
  const sync = await b.wait((e) => e.event === "x-agentlinkd.background_compaction", at);
  assert.equal(sync.data.current.job_id, bg.data.job_id);
  b.send("prompt.submit", { session: id, text: "BG_APPLY" });
  await b.wait((e) => e.event === "background_compaction" && e.data.phase === "applied", at);
  await b.wait((e) => e.event === "turn_end", at);
  assert.equal(h.journal(id).filter((e) => e.event === "compact_end").length, 1);
  assert.equal(h.journal(id).filter((e) => e.event === "compact_start").length, 0);
  const done = b.events.length; b.send("session.subscribe", { id });
  const applied = await b.wait((e) => e.event === "session.snapshot", done);
  assert.equal(applied.data.background_compaction, null);
  assert.equal(applied.data.session_usage.input, 14);
});

test("idle interrupt cancels background without killing warm child or reviving late job", async (t) => {
  const h = await durableHost(t, { bridge: true }); const c = await h.client(); const id = await h.open(c);
  c.send("prompt.submit", { session: id, text: "BG_START" });
  const start = await c.wait((e) => e.event === "turn_start");
  await c.wait((e) => e.event === "turn_end");
  const at = c.events.length; c.send("interrupt", { session: id });
  await c.wait((e) => e.event === "x-agentlinkd.background_compaction" && e.data.current === null, at);
  c.send("prompt.submit", { session: id, text: "BG_STALE" });
  const next = await c.wait((e) => e.event === "turn_start", at);
  await c.wait((e) => e.event === "turn_end", at);
  assert.equal(next.data.pid, start.data.pid);
  assert.ok(!c.events.slice(at).some((e) => e.event === "background_compaction" && e.data.phase === "ready"));
  const snapAt = c.events.length; c.send("session.subscribe", { id });
  assert.equal((await c.wait((e) => e.event === "session.snapshot", snapAt)).data.background_compaction, null);
});

test("background interrupt escalation never kills a later turn on the warm child", async (t) => {
  const h = await durableHost(t, { bridge: true, env: { FAKE_DEXT_TURN_DELAY_MS: "3500" } });
  const c = await h.client(); const id = await h.open(c);
  c.send("prompt.submit", { session: id, text: "BG_START" });
  const start = await c.wait((e) => e.event === "turn_start");
  await c.wait((e) => e.event === "turn_end");
  const at = c.events.length; c.send("interrupt", { session: id });
  await c.wait((e) => e.event === "x-agentlinkd.background_compaction" && e.data.current === null, at);
  const nextAt = c.events.length; c.send("prompt.submit", { session: id, text: "SLOW later turn" });
  assert.equal((await c.wait((e) => e.event === "turn_start", nextAt)).data.pid, start.data.pid);
  const end = await c.wait((e) => e.event === "turn_end", nextAt);
  assert.equal(end.data.failed, false, "old 3-second escalation must not signal a fresh turn");
});

test("background-only child death clears badge and host restart never auto-resumes it", async (t) => {
  const h = await durableHost(t, { bridge: true, args: ["--auto-resume"] }); const c = await h.client(); const id = await h.open(c);
  c.send("prompt.submit", { session: id, text: "BG_START" });
  const start = await c.wait((e) => e.event === "turn_start"); await c.wait((e) => e.event === "turn_end");
  const at = c.events.length;
  process.kill(start.data.pid, "SIGKILL");
  await c.wait((e) => e.event === "x-agentlinkd.background_compaction" && e.data.current === null, at);
  assert.equal(h.index()[0].working, false);
  const restartAt = c.events.length;
  c.send("prompt.submit", { session: id, text: "BG_START" });
  await c.wait((e) => e.event === "background_compaction" && e.data.phase === "running", restartAt);
  await c.wait((e) => e.event === "turn_end", restartAt);
  await h.stop("SIGKILL"); await h.start(); await sleep(150);
  assert.equal(h.journal(id).filter((e) => e.event === "user_message").length, 2);
  assert.ok(!h.journal(id).some((e) => e.event === "user_message" && e.data.nonce?.startsWith("resume:")));
  const next = await h.client(); next.send("session.subscribe", { id });
  const snap = await next.wait((e) => e.event === "session.snapshot");
  assert.equal(snap.data.background_compaction, null);
});
