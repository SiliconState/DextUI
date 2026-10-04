import { test } from "node:test";
import assert from "node:assert/strict";
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
