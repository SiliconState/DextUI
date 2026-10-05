// Auth failures must stay visible; every root and credential here is fake/test-owned.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { authStatusError } from "../src/auth-errors.mjs";
import { durableHost } from "./durable-harness.mjs";

const status = (e) => e.event === "x-agentlinkd.auth.status";
const failure = (cmd) => (e) => e.event === "error" && e.data.cmd === cmd;
test("auth status errors disclose only reviewed diagnostic categories, never arbitrary output or secrets", () => {
  assert.match(authStatusError({ err: "provider state has unsafe writable mode 0664; /private/fixture-secret" }), /0664.*0600/);
  for (const text of ["", "secret-key-value", "invalid provider catalog JSON: secret-key-value", "symlink refused /secret-key-value"]) assert.ok(!authStatusError({ err: text }).includes("secret-key-value"));
});

for (const mode of ["mode", "empty"]) test(`host ${mode} provider-state failure yields a tagged error, no empty status or login success; refresh recovers`, async (t) => {
  const h = await durableHost(t); const c = await h.client(); c.send("x-agentlinkd.auth.status");
  const known = await c.wait(status); assert.ok(known.data.providers.length > 0);
  fs.mkdirSync(h.home, { recursive: true });
  const file = path.join(h.home, "fake-auth-failure"); fs.writeFileSync(file, mode);
  const at = c.events.length; c.send("x-agentlinkd.auth.status");
  const error = await c.wait(failure("x-agentlinkd.auth.status"), at);
  assert.equal(error.data.code, "auth_status_failed");
  if (mode === "mode") assert.match(error.data.message, /0664.*0600/);
  assert.ok(!c.events.slice(at).some(status));
  const loginAt = c.events.length; c.send("x-agentlinkd.auth.login", { provider: "fake-b", credential: "fixture-pasted-secret" });
  await c.wait(failure("x-agentlinkd.auth.login"), loginAt);
  assert.ok(!c.events.slice(loginAt).some(status));
  assert.ok(!fs.existsSync(path.join(h.home, "fake-auth.json")), "invalid state prevents credential dispatch");
  assert.ok(!JSON.stringify(c.events).includes("fixture-secret-must-not-echo"));
  assert.ok(!JSON.stringify(c.events).includes("fixture-pasted-secret"));
  fs.rmSync(file);
  const recovery = c.events.length; c.send("x-agentlinkd.auth.status");
  assert.deepEqual((await c.wait(status, recovery)).data.providers, known.data.providers);
});

test("login followed by failed provider refresh does not broadcast a blank list or false sign-out", async (t) => {
  const h = await durableHost(t, { env: { FAKE_DEXT_AUTH_POST_LOGIN_FAIL: "1" } }); const c = await h.client();
  c.send("x-agentlinkd.auth.status"); await c.wait(status);
  const at = c.events.length; c.send("x-agentlinkd.auth.login", { provider: "fake-b", credential: "fixture-pasted-secret" });
  const error = await c.wait(failure("x-agentlinkd.auth.login"), at);
  assert.equal(error.data.code, "auth_refresh_failed"); assert.match(error.data.message, /Credential saved.*0664/);
  assert.ok(!c.events.slice(at).some(status));
  assert.ok(!JSON.stringify(c.events).includes("fixture-pasted-secret"));
  assert.ok(!JSON.stringify(c.events).includes("fixture-secret-must-not-echo"));
  fs.rmSync(path.join(h.home, "fake-auth-failure"));
  const recovered = c.events.length; c.send("x-agentlinkd.auth.status");
  assert.equal((await c.wait(status, recovered)).data.providers.find((p) => p.id === "fake-b").auth, "key");
});

const core = process.env.DEXT_CORE_BIN ?? path.join(os.homedir(), "Dext/target/release/dext");
test("installed CORE login under host umask 002 keeps provider catalog owner-only across restart", { skip: !fs.existsSync(core) && "CORE binary unavailable", timeout: 20000 }, async (t) => {
  const h = await durableHost(t, { bin: core, umask: 0o002 });
  const c = await h.client();
  c.send("x-agentlinkd.auth.login", { provider: "deepseek", credential: "fixture-not-a-real-credential" });
  const logged = await c.wait((e) => status(e) && e.data.changed === "deepseek");
  assert.ok(["auth", "key"].includes(logged.data.providers.find((p) => p.id === "deepseek").auth));
  assert.equal(fs.statSync(path.join(h.home, "providers.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(h.home, "auth.json")).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(c.events).includes("fixture-not-a-real-credential"));
  await h.stop(); await h.start();
  const next = await h.client(); next.send("x-agentlinkd.auth.status");
  const resumed = await next.wait(status);
  assert.ok(["auth", "key"].includes(resumed.data.providers.find((p) => p.id === "deepseek").auth));
  assert.ok(resumed.data.model_catalog.length > 0);
});

test("installed CORE permissions refusal is surfaced and test-owned repair restores provider discovery", { skip: !fs.existsSync(core) && "CORE binary unavailable", timeout: 20000 }, async (t) => {
  const h = await durableHost(t, { bin: core, setup({ home }) { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, "providers.json"), "{}", { mode: 0o664 }); fs.chmodSync(path.join(home, "providers.json"), 0o664); } });
  const c = await h.client(); c.send("x-agentlinkd.auth.status");
  const error = await c.wait(failure("x-agentlinkd.auth.status")); assert.equal(error.data.code, "auth_status_failed"); assert.match(error.data.message, /0664.*0600/);
  assert.ok(!c.events.some(status));
  fs.rmSync(path.join(h.home, "providers.json")); // fixture repair, never operator state
  const at = c.events.length; c.send("x-agentlinkd.auth.status");
  const recovered = await c.wait(status, at); assert.ok(recovered.data.providers.some((p) => p.id === "deepseek"));
  assert.ok(recovered.data.model_catalog.length > 0);
});
