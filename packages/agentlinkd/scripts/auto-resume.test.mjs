import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { durableHost, sleep, until } from "./durable-harness.mjs";

for (const bridge of [false, true]) {
  test(`opt-in auto-resume is fenced once per turn (${bridge ? "bridge" : "one-shot"})`, async (t) => {
    const h = await durableHost(t, { bridge, args: ["--auto-resume"], env: { FAKE_DEXT_TURN_DELAY_MS: "3000" } });
    const c = await h.client(); const id = await h.open(c);
    c.send("prompt.submit", { session: id, text: "interrupted work", nonce: "turnnonce1" });
    await c.wait((e) => e.event === "turn_start");
    assert.equal(h.index()[0].working, true);
    assert.equal(h.index()[0].turnNonce, "turnnonce1");
    await h.stop("SIGKILL"); await h.start();
    await until(() => h.journal(id).filter((e) => e.event === "turn_start").length === 2);
    const resumes = () => h.journal(id).filter((e) => e.event === "user_message" && e.data.nonce === "resume:turnnonce1");
    assert.equal(resumes().length, 1);
    assert.match(resumes()[0].data.text, /^Continue the interrupted turn\./);
    assert.equal(h.index()[0].autoResumeAttempted, "turnnonce1");
    assert.equal(h.index()[0].turnNonce, "turnnonce1");
    if (bridge) assert.equal(h.journal(id).filter((e) => e.event === "turn_start").at(-1).data.resume, "latest");
    await h.stop("SIGKILL"); await h.start(); await sleep(150);
    assert.equal(resumes().length, 1, "a crash in recovery cannot loop");
    const next = await h.client();
    assert.equal(next.hello.data.sessions[0].status, "cold");
    next.send("prompt.submit", { session: id, text: "fresh manual turn", nonce: "turnnonce2" });
    await until(() => h.index()[0].turnNonce === "turnnonce2");
    await until(() => h.journal(id).filter((e) => e.event === "turn_start").length === 3);
    await h.stop("SIGKILL"); await h.start();
    await until(() => h.journal(id).some((e) => e.event === "user_message" && e.data.nonce === "resume:turnnonce2"));
    await until(() => h.journal(id).filter((e) => e.event === "turn_start").length === 4);
  });
}

test("auto-resume defaults off even for a persisted working turn", async (t) => {
  const h = await durableHost(t, { env: { FAKE_DEXT_TURN_DELAY_MS: "3000" } });
  const c = await h.client(); const id = await h.open(c);
  c.send("prompt.submit", { session: id, text: "work", nonce: "defaultoff1" });
  await c.wait((e) => e.event === "turn_start");
  await h.stop("SIGKILL"); await h.start(); await sleep(150);
  assert.equal(h.journal(id).filter((e) => e.event === "user_message").length, 1);
  assert.equal((await h.client()).hello.data.sessions[0].status, "cold");
});

test("interrupt before bridge ready never dispatches the queued prompt", async (t) => {
  const h = await durableHost(t, { bridge: true, env: { FAKE_DEXT_READY_DELAY_MS: "400" } });
  const c = await h.client(); const id = await h.open(c);
  c.send("prompt.submit", { session: id, text: "must not run" });
  await c.wait((e) => e.event === "user_message");
  c.send("interrupt", { session: id });
  await c.wait((e) => e.event === "interrupted");
  await sleep(450);
  assert.equal(h.journal(id).filter((e) => e.event === "turn_start").length, 0);
  assert.equal(h.index()[0].working, false);
});

test("failed resume journaling preserves queued steering and never dispatches", async (t) => {
  if (process.getuid?.() === 0) return t.skip("chmod-based failure is invisible to root");
  const h = await durableHost(t, { args: ["--auto-resume"], env: { FAKE_DEXT_TURN_DELAY_MS: "3000" } });
  const c = await h.client(); const id = await h.open(c);
  c.send("prompt.submit", { session: id, text: "work", nonce: "failedresume1" });
  await c.wait((e) => e.event === "turn_start");
  c.send("steering.inject", { session: id, text: "keep this queued instruction" });
  await c.wait((e) => e.event === "steering_received");
  await h.stop("SIGKILL");
  const file = path.join(h.state, "journals", `${id}.jsonl`);
  fs.chmodSync(file, 0o400);
  t.after(() => { try { fs.chmodSync(file, 0o600); } catch { /* removed */ } });
  await h.start(); await sleep(200);
  assert.equal(h.journal(id).filter((e) => e.event === "turn_start").length, 1);
  assert.deepEqual(h.index()[0].steeringQueue, ["keep this queued instruction"]);
  assert.equal(h.index()[0].autoResumeAttempted, "failedresume1");
  fs.chmodSync(file, 0o600);
});

test("a manual follow-up resumes a checkpoint from an interrupted first turn", async (t) => {
  const h = await durableHost(t, { bridge: true });
  const c = await h.client(); const id = await h.open(c);
  await h.stop();
  const e = h.index()[0];
  const dir = path.join(h.home, "projects", "fixture", "sessions", "partial-first");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "_latest.jsonl"), JSON.stringify({ seat: { id: e.seat } }) + "\n");
  const linked = path.join(h.home, "projects", "fixture", "sessions", "linked");
  fs.mkdirSync(linked);
  const outside = path.join(h.temp, "unowned.jsonl");
  fs.writeFileSync(outside, JSON.stringify({ seat: { id: e.seat } }) + "\n");
  fs.utimesSync(outside, Date.now() / 1000 + 60, Date.now() / 1000 + 60);
  fs.symlinkSync(outside, path.join(linked, "_latest.jsonl"));
  await h.start();
  const next = await h.client(); next.send("session.subscribe", { id });
  await next.wait((e) => e.event === "session.snapshot");
  next.send("prompt.submit", { session: id, text: "continue manually" });
  const start = await next.wait((e) => e.event === "turn_start");
  assert.equal(start.data.resume, dir);
});

test("explicit false overrides a bare recovery flag and environment enablement", async (t) => {
  const h = await durableHost(t, { args: ["--auto-resume", "--auto-resume=false"], env: { AGENTLINKD_AUTO_RESUME: "true", FAKE_DEXT_TURN_DELAY_MS: "3000" } });
  const c = await h.client(); const id = await h.open(c);
  c.send("prompt.submit", { session: id, text: "work" });
  await c.wait((e) => e.event === "turn_start");
  await h.stop("SIGKILL"); await h.start(); await sleep(150);
  assert.equal(h.journal(id).filter((e) => e.event === "user_message").length, 1);
});

test("idle and explicitly interrupted sessions are never auto-resumed", async (t) => {
  const h = await durableHost(t, { bridge: true, args: ["--auto-resume"] });
  const c = await h.client(); const id = await h.open(c);
  c.send("prompt.submit", { session: id, text: "idle soon" });
  await c.wait((e) => e.event === "turn_end");
  assert.equal(h.index()[0].working, false);
  await h.stop(); await h.start();
  const next = await h.client(); next.send("session.subscribe", { id });
  await next.wait((e) => e.event === "session.snapshot");
  next.send("prompt.submit", { session: id, text: "APPROVE" });
  await next.wait((e) => e.event === "permission.request");
  next.send("interrupt", { session: id });
  await until(() => h.index()[0].working === false);
  await h.stop("SIGKILL"); await h.start(); await sleep(150);
  assert.equal(h.journal(id).filter((e) => e.event === "user_message" && e.data.nonce?.startsWith("resume:")).length, 0);
});
