import { test } from "node:test";
import assert from "node:assert/strict";
import { durableHost, sleep } from "./durable-harness.mjs";

for (const cmd of ["slash", "prompt.submit"]) test(`${cmd} nested refusal is nonce-correlated, never success-acked or accepted on replay`, async (t) => {
  const h = await durableHost(t, { bridge: true }), c = await h.client(), id = await h.open(c);
  const nonce = "nestedrefusal1", payload = cmd === "slash" ? { raw: "/compact invalid" } : { text: "/pack inspect not-a-pack" };
  c.send(cmd, { session: id, nonce, ...payload });
  const error = await c.wait((e) => e.event === "error" && e.data.nonce === nonce);
  assert.equal(error.data.cmd, cmd);
  await sleep(80);
  assert.ok(!c.events.some((e) => e.event === "cmd_ack" && e.data.nonce === nonce));
  const at = c.events.length;
  c.send(cmd, { session: id, nonce, ...(cmd === "slash" ? { raw: "/help" } : { text: "must not run" }) });
  const replay = await c.wait((e) => e.event === "error" && e.data.duplicate, at);
  assert.equal(replay.data.code, error.data.code);
  assert.ok(!h.journal(id).some((e) => e.event === "user_message"));
  // A later independent command must not inherit the rejected request flag.
  c.send("slash", { session: id, raw: "/help", nonce: "independenthelp1" });
  await c.wait((e) => e.event === "cmd_ack" && e.data.nonce === "independenthelp1");
});

test("busy slash refusal never emits success and pre-ready cancellation rejects the original pending identity", async (t) => {
  const h = await durableHost(t, { bridge: true, env: { FAKE_DEXT_READY_DELAY_MS: "600" } });
  const c = await h.client(), id = await h.open(c);
  c.send("slash", { session: id, raw: "/compact", nonce: "pendingcompact1" });
  await c.wait((e) => e.event === "compact_start");
  c.send("slash", { session: id, raw: "/compact", nonce: "busycompact1" });
  await c.wait((e) => e.event === "error" && e.data.nonce === "busycompact1" && e.data.code === "busy");
  c.send("slash", { session: id, raw: "/compact", nonce: "pendingcompact1" });
  await sleep(80);
  assert.ok(!c.events.some((e) => e.event === "cmd_ack" && ["pendingcompact1", "busycompact1"].includes(e.data.nonce)), "duplicate pending command has no outcome yet");
  c.send("interrupt", { session: id });
  await c.wait((e) => e.event === "error" && e.data.nonce === "pendingcompact1");
  assert.ok(!c.events.some((e) => e.event === "cmd_ack" && ["pendingcompact1", "busycompact1"].includes(e.data.nonce)));
  const at = c.events.length;
  c.send("slash", { session: id, raw: "/help", nonce: "pendingcompact1" });
  await c.wait((e) => e.event === "error" && e.data.nonce === "pendingcompact1" && e.data.duplicate, at);
});
