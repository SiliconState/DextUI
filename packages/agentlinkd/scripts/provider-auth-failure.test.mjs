// Auth failures must stay visible; every root and credential here is fake/test-owned.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { authStatusError, authWriteError, normaliseAuthMarker } from "../src/auth-errors.mjs";
import { durableHost, sleep, until } from "./durable-harness.mjs";

const status = (e) => e.event === "x-agentlinkd.auth.status";
const failure = (cmd) => (e) => e.event === "error" && e.data.cmd === cmd;
test("auth marker normalization treats unresolved credentials as missing and never returns raw suffixes", () => {
  for (const [value, expected] of [["auth(unresolved)", "missing"], ["auth", "auth"], ["not-required", "present"], ["env:DEEPSEEK_API_KEY", "key"], ["None.", "none"], ["sk-fixture-marker", "key"]]) assert.equal(normaliseAuthMarker(value), expected);
  for (const text of ["fixture-secret", "rejected extracted credential fixture-secret", "invalid ChatGPT access token format: fixture-secret"]) assert.ok(!authWriteError({ stderr: text }, "login").includes("fixture-secret"));
});

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

test("credential-normalized tool errors never echo pasted or extracted secrets", async (t) => {
  const h = await durableHost(t, { env: { FAKE_DEXT_AUTH_ECHO_FAILURE: "1" } }); const c = await h.client();
  c.send("x-agentlinkd.auth.login", { provider: "fake-b", credential: "Bearer fixture-extracted-secret" });
  const error = await c.wait(failure("x-agentlinkd.auth.login"));
  assert.equal(error.data.code, "tool_failed");
  assert.ok(!JSON.stringify(c.events).includes("fixture-extracted-secret"));
});

test("a zero-exit login without a stored credential is not reported as success", async (t) => {
  const h = await durableHost(t, { env: { FAKE_DEXT_AUTH_NO_SAVE: "1" } }); const c = await h.client();
  c.send("x-agentlinkd.auth.login", { provider: "fake-b", credential: "fixture-unsaved-secret" });
  const error = await c.wait(failure("x-agentlinkd.auth.login"));
  assert.equal(error.data.code, "auth_unconfirmed");
  assert.ok(!c.events.some((e) => status(e) && e.data.changed));
});

test("an old provider status admitted before login cannot overwrite the final receipt", async (t) => {
  const h = await durableHost(t); const c = await h.client(), reader = await h.client();
  fs.mkdirSync(h.home, { recursive: true }); fs.writeFileSync(path.join(h.home, "fake-status-delay"), "700");
  reader.send("x-agentlinkd.auth.status"); await until(() => fs.existsSync(path.join(h.home, "fake-status-started")));
  c.send("x-agentlinkd.auth.login", { provider: "fake-b", credential: "fixture-new-key" });
  await c.wait((e) => status(e) && e.data.changed === "fake-b");
  const stale = await reader.wait(failure("x-agentlinkd.auth.status")); assert.equal(stale.data.code, "busy");
  assert.ok(!reader.events.some((e) => status(e) && !e.data.changed));
});

test("headless login refuses CORE browser/import aliases without launching a helper", async (t) => {
  const h = await durableHost(t); const c = await h.client();
  for (const credential of ["--web", "browser", "--browser", "reauth", "--reauth", "--import", "reuse", "--reuse"]) {
    const at = c.events.length; c.send("x-agentlinkd.auth.login", { provider: "fake-b", credential });
    assert.equal((await c.wait(failure("x-agentlinkd.auth.login"), at)).data.code, "bad_request");
  }
  assert.ok(!fs.existsSync(path.join(h.home, "fake-auth.json")));
});

test("one global provider write fences concurrent tabs and defers restart through final refresh", async (t) => {
  const h = await durableHost(t, { env: { FAKE_DEXT_AUTH_DELAY_MS: "900" } });
  const a = await h.client(), b = await h.client();
  a.send("x-agentlinkd.auth.login", { provider: "fake-b", credential: "fixture-first-secret" });
  await until(() => fs.existsSync(path.join(h.home, "fake-auth-started")));
  const at = b.events.length;
  b.send("x-agentlinkd.auth.logout", { provider: "fake-a" });
  const refused = await b.wait(failure("x-agentlinkd.auth.logout"), at);
  assert.equal(refused.data.code, "busy");
  const refreshAt = b.events.length; b.send("x-agentlinkd.auth.status");
  const response = await h.request("/__self/restart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "test-only provider-write boundary", force: false }) });
  const restart = await response.json(); assert.equal(restart.pending, true);
  assert.ok(restart.busy.some((item) => item.kind === "provider_auth"));
  await sleep(350); assert.equal(h.child.exitCode, null);
  await a.wait((e) => status(e) && e.data.changed === "fake-b");
  const refreshed = await b.wait((e) => status(e) && !e.data.changed, refreshAt);
  assert.equal(refreshed.data.providers.find((p) => p.id === "fake-b").auth, "key");
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.home, "fake-auth.json"), "utf8"))["fake-a"], "auth");
  await until(() => h.child.exitCode !== null); assert.equal(h.child.exitCode, 75);
});

const core = process.env.DEXT_CORE_BIN ?? path.join(os.homedir(), "Dext/target/release/dext");
test("installed CORE login under host umask 002 keeps provider catalog owner-only across restart", { skip: !fs.existsSync(core) && "CORE binary unavailable", timeout: 20000 }, async (t) => {
  const h = await durableHost(t, { bin: core, umask: 0o002 });
  const c = await h.client();
  const existing = await h.open(c);
  const oldProvider = h.index().find((s) => s.id === existing).provider;
  c.send("x-agentlinkd.auth.login", { provider: "deepseek", credential: "fixture-not-a-real-credential" });
  const logged = await c.wait((e) => status(e) && e.data.changed === "deepseek");
  assert.ok(["auth", "key"].includes(logged.data.providers.find((p) => p.id === "deepseek").auth));
  assert.equal(fs.statSync(path.join(h.home, "providers.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(h.home, "auth.json")).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(c.events).includes("fixture-not-a-real-credential"));
  const fresh = await h.open(c);
  assert.equal(h.index().find((s) => s.id === fresh).provider, "deepseek", "new sessions use the signed-in provider without restarting the host");
  assert.equal(h.index().find((s) => s.id === existing).provider, oldProvider, "existing sessions keep their provider");
  c.send("x-agentlinkd.auth.login", { provider: "openai", credential: "fixture-other-provider" });
  await c.wait((e) => status(e) && e.data.changed === "openai");
  for (let i = 0; i < 2; i++) {
    const at = c.events.length;
    c.send("x-agentlinkd.auth.login", { provider: "deepseek", credential: `fixture-replacement-${i}` });
    const replaced = await c.wait((e) => status(e) && e.data.changed === "deepseek", at);
    assert.ok(["auth", "key"].includes(replaced.data.providers.find((p) => p.id === "openai").auth), "replacing one key preserves other providers");
    assert.equal(fs.statSync(path.join(h.home, "providers.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(h.home, "auth.json")).mode & 0o777, 0o600);
  }
  await h.stop(); await h.start();
  const next = await h.client(); next.send("x-agentlinkd.auth.status");
  const resumed = await next.wait(status);
  assert.ok(["auth", "key"].includes(resumed.data.providers.find((p) => p.id === "deepseek").auth));
  assert.ok(resumed.data.model_catalog.length > 0);
  const at = next.events.length; next.send("x-agentlinkd.auth.logout", { provider: "deepseek" });
  const out = await next.wait((e) => status(e) && e.data.changed === "deepseek", at);
  assert.ok(["none", "missing"].includes(out.data.providers.find((p) => p.id === "deepseek").auth));
  assert.ok(["auth", "key"].includes(out.data.providers.find((p) => p.id === "openai").auth));
  assert.equal(fs.statSync(path.join(h.home, "providers.json")).mode & 0o777, 0o600);
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
