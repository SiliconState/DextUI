// Pairing token persistence and cross-site request refusal. Every host here is
// a test-owned child with its own state dir and the fake dext; no operator state.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { requestSite, allowedOrigins } from "../src/request-origin.mjs";

const root = path.resolve("packages/agentlinkd");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("request provenance: fetch metadata first, Origin fallback, native clients untouched", () => {
  const req = (headers) => ({ headers: { host: "127.0.0.1:8788", ...headers } });
  const none = new Set();
  assert.equal(requestSite(req({}), none), "native", "curl/Node/webhook senders");
  assert.equal(requestSite(req({ "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:8788" }), none), "same");
  assert.equal(requestSite(req({ "sec-fetch-site": "none" }), none), "same", "typed URL or bookmark");
  assert.equal(requestSite(req({ "sec-fetch-site": "cross-site", origin: "https://x.com" }), none), "cross");
  assert.equal(requestSite(req({ "sec-fetch-site": "same-site", origin: "http://127.0.0.1:3000" }), none), "cross", "another local port is another app");
  assert.equal(requestSite(req({ "sec-fetch-site": "cross-site" }), none), "cross", "image/navigation loads without Origin");
  // A proxy that rewrites Host: the browser's own judgement still wins.
  assert.equal(requestSite(req({ "sec-fetch-site": "same-origin", origin: "https://dext.example.test" }), none), "same");
  // Older browsers: Origin compared with Host or the first X-Forwarded-Host.
  assert.equal(requestSite(req({ origin: "http://127.0.0.1:8788" }), none), "same");
  assert.equal(requestSite(req({ origin: "https://dext.example.test", "x-forwarded-host": "dext.example.test, inner" }), none), "same");
  assert.equal(requestSite(req({ origin: "https://evil.test" }), none), "cross");
  assert.equal(requestSite(req({ origin: "null" }), none), "cross", "sandboxed/opaque documents");
  assert.equal(requestSite(req({ origin: "null", "sec-fetch-site": "same-origin" }), none), "cross");
  assert.equal(requestSite(req({ origin: "chrome-extension://abc", "sec-fetch-site": "none" }), none), "cross");
  assert.equal(requestSite(req({ "sec-fetch-site": "unexpected" }), none), "cross");
  assert.equal(requestSite(req({ origin: "chrome-extension://abc" }), none), "cross");
  assert.equal(requestSite(req({ origin: "not a url" }), none), "cross");
  const extra = allowedOrigins({ AGENTLINKD_ALLOWED_ORIGINS: " https://Dext.Example.com/ , https://other.test" });
  assert.deepEqual([...extra], ["https://dext.example.com", "https://other.test"]);
  assert.equal(requestSite(req({ "sec-fetch-site": "cross-site", origin: "https://dext.example.com" }), extra), "same");
  assert.equal(requestSite(req({ origin: "https://dext.example.com" }), extra), "same");
});

function tempRoot(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dextui-pairing-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "workspace"));
  return dir;
}

async function startHost(t, dir, args = [], env = {}) {
  const childEnv = { ...process.env, DEXT_HOME: path.join(dir, "dext"), DEXT_SESSIONS_DIR: "", DEXT_LOGS_DIR: "", AGENTLINKD_AUTO_RESUME: "false", AGENTLINKD_TIMERS: "false", ...env };
  delete childEnv.AGENTLINKD_TOKEN;
  if (env.AGENTLINKD_TOKEN) childEnv.AGENTLINKD_TOKEN = env.AGENTLINKD_TOKEN;
  const child = spawn(process.execPath, [
    path.join(root, "src/server.mjs"), "--port=0", `--cwd=${path.join(dir, "workspace")}`,
    `--state-dir=${path.join(dir, "state")}`, `--dext=${path.join(root, "scripts/fake-dext.mjs")}`, ...args,
  ], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await once(child, "exit"); } };
  t.after(stop);
  for (let i = 0; i < 200 && !/token:\s+\S+/.test(stdout); i++) {
    if (child.exitCode !== null) break;
    await sleep(25);
  }
  const base = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1];
  const token = /token:\s+(\S+)/.exec(stdout)?.[1];
  return { child, base, token, stdout: () => stdout, stderr: () => stderr, stop };
}

const tokenFile = (dir) => path.join(dir, "state", "pairing-token");

test("generated pairing token is saved 0600, reused on restart, and rotated on request", { timeout: 30000 }, async (t) => {
  const dir = tempRoot(t);
  const first = await startHost(t, dir);
  assert.ok(first.base && first.token, `host started: ${first.stderr()}`);
  assert.match(first.stdout(), /new, saved in/);
  const st = fs.statSync(tokenFile(dir));
  assert.equal(st.mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(tokenFile(dir), "utf8").trim(), first.token);
  await first.stop();

  const second = await startHost(t, dir);
  assert.equal(second.token, first.token, "a relaunch keeps the same pairing token");
  assert.match(second.stdout(), /saved in .*--rotate-token replaces it/);
  const ok = await fetch(`${second.base}/sessions`, { headers: { authorization: `Bearer ${first.token}` } });
  assert.equal(ok.status, 200, "devices paired before the relaunch stay signed in");
  await second.stop();

  const rotated = await startHost(t, dir, ["--rotate-token"]);
  assert.notEqual(rotated.token, first.token);
  assert.match(rotated.stdout(), /rotated; paired devices must sign in again/);
  assert.equal(fs.readFileSync(tokenFile(dir), "utf8").trim(), rotated.token);
  assert.equal((await fetch(`${rotated.base}/sessions`, { headers: { authorization: `Bearer ${first.token}` } })).status, 401);
  await rotated.stop();

  // Explicit configuration wins and never overwrites the saved file.
  const explicit = await startHost(t, dir, ["--token=explicit-fixture-token"]);
  assert.equal(explicit.token, "explicit-fixture-token");
  assert.match(explicit.stdout(), /from --token/);
  assert.equal(fs.readFileSync(tokenFile(dir), "utf8").trim(), rotated.token);
  await explicit.stop();
  const fromEnv = await startHost(t, dir, [], { AGENTLINKD_TOKEN: "env-fixture-token-value" });
  assert.equal(fromEnv.token, "env-fixture-token-value");
  await fromEnv.stop();
});

test("unsafe saved tokens are never reused: symlinks refused, shared or malformed files replaced", { timeout: 30000 }, async (t) => {
  const dir = tempRoot(t);
  fs.mkdirSync(path.join(dir, "state"), { mode: 0o700 });
  const outside = path.join(dir, "outside-token");
  fs.writeFileSync(outside, "planted-token-value-123\n", { mode: 0o600 });
  fs.symlinkSync(outside, tokenFile(dir));
  const linked = await startHost(t, dir);
  assert.equal(linked.base, undefined, "host refuses to start on a symlinked token file");
  assert.match(linked.stderr(), /symlink, refusing/);
  assert.equal(fs.readFileSync(outside, "utf8"), "planted-token-value-123\n", "symlink target untouched");
  const rotatedLink = await startHost(t, dir, ["--rotate-token"]);
  assert.equal(rotatedLink.base, undefined, "rotation also refuses symlinks");
  assert.match(rotatedLink.stderr(), /symlink, refusing/);
  assert.ok(fs.lstatSync(tokenFile(dir)).isSymbolicLink());
  fs.rmSync(tokenFile(dir));
  fs.mkdirSync(tokenFile(dir));
  const directory = await startHost(t, dir, ["--rotate-token"]);
  assert.equal(directory.base, undefined, "rotation cannot fall back to ephemeral auth on an unsafe path");
  assert.match(directory.stderr(), /not a regular file/);
  fs.rmdirSync(tokenFile(dir));

  fs.chmodSync(path.join(dir, "state"), 0o755);
  fs.writeFileSync(tokenFile(dir), "leaked-shared-token-value\n", { mode: 0o644 });
  fs.chmodSync(tokenFile(dir), 0o644);
  const shared = await startHost(t, dir);
  assert.ok(shared.token && shared.token !== "leaked-shared-token-value", "a group/world-readable token may have leaked");
  assert.match(shared.stderr(), /group\/other-accessible/);
  assert.equal(fs.statSync(tokenFile(dir)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, "state")).mode & 0o777, 0o700);
  await shared.stop();

  fs.writeFileSync(tokenFile(dir), "bad token with spaces\n", { mode: 0o600 });
  const malformed = await startHost(t, dir);
  assert.ok(malformed.token && malformed.token !== "bad");
  assert.match(malformed.stderr(), /malformed pairing token file replaced/);
  await malformed.stop();
});

test("conflicting pairing configuration refuses before creating state", async (t) => {
  const dir = tempRoot(t);
  for (const args of [["--token="], ["--token=fixture-explicit", "--rotate-token"]]) {
    const host = await startHost(t, dir, args);
    assert.equal(host.base, undefined);
    assert.equal(fs.existsSync(path.join(dir, "state")), false);
    assert.match(host.stderr(), /pairing token must not be empty|cannot be combined/);
  }
});

test("pairing-token FIFOs refuse promptly instead of blocking startup", { skip: process.platform === "win32" }, async (t) => {
  const dir = tempRoot(t);
  fs.mkdirSync(path.join(dir, "state"), { mode: 0o700 });
  assert.equal(spawnSync("mkfifo", [tokenFile(dir)]).status, 0);
  const host = await startHost(t, dir);
  assert.equal(host.base, undefined);
  assert.match(host.stderr(), /not a regular file/);
});

function rawRequest(base, { method = "GET", path: p = "/", headers = {} }) {
  const port = Number(new URL(base).port);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject); req.end();
  });
}

function rawUpgrade(base, headers) {
  const port = Number(new URL(base).port);
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => {
      s.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`);
    });
    let buf = "";
    s.on("data", (d) => { buf += d.toString("latin1"); if (buf.includes("\r\n\r\n")) { s.destroy(); resolve(buf.split("\r\n")[0]); } });
    s.on("error", () => resolve(buf));
    setTimeout(() => { s.destroy(); resolve(buf); }, 2000);
  });
}

async function hello(base, token) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  await once(ws, "open");
  const reply = new Promise((resolve) => ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.event === "hello_ok" || m.event === "hello_fail") resolve(m); }));
  ws.send(JSON.stringify({ v: 1, cmd: "hello", token }));
  const m = await reply;
  ws.close();
  return m;
}

test("cross-site pages cannot reach token checks, probe the token, or lock the operator out", { timeout: 30000 }, async (t) => {
  const dir = tempRoot(t);
  const h = await startHost(t, dir, ["--token=operator-fixture-token"]);
  const port = new URL(h.base).port;
  // A page from another site, open in any local browser, aims at /ws.
  for (let i = 0; i < 8; i++) {
    assert.match(await rawUpgrade(h.base, { Origin: "https://x.com", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "websocket" }), /^HTTP\/1\.1 403/);
  }
  assert.match(await rawUpgrade(h.base, { Origin: "null" }), /^HTTP\/1\.1 403/, "sandboxed documents too");
  assert.match(await rawUpgrade(h.base, { Origin: "http://127.0.0.1:3000" }), /^HTTP\/1\.1 403/, "another local app's origin too");
  // Wrong bearers and ?t= guesses from cross-site pages are refused unanswered.
  for (let i = 0; i < 8; i++) {
    assert.equal(await rawRequest(h.base, { path: "/sessions", headers: { authorization: "Bearer guess", origin: "https://evil.test", "sec-fetch-site": "cross-site" } }), 403);
    assert.equal(await rawRequest(h.base, { path: `/sessions/x/file/a.png?t=guess${i}`, headers: { "sec-fetch-site": "cross-site", "sec-fetch-dest": "image" } }), 403);
  }
  for (let i = 0; i < 6; i++) assert.equal(await rawRequest(h.base, { method: "POST", path: `/hooks/${"a".repeat(31)}${i}`, headers: { origin: "https://evil.test", "sec-fetch-site": "cross-site" } }), 403);
  // None of that counted: the operator still signs in from the app's own origin.
  assert.equal((await hello(h.base, "operator-fixture-token")).event, "hello_ok");
  assert.match(await rawUpgrade(h.base, { Origin: `http://127.0.0.1:${port}`, "Sec-Fetch-Site": "same-origin" }), /^HTTP\/1\.1 101/);
  assert.equal(await rawRequest(h.base, { path: "/sessions", headers: { authorization: "Bearer operator-fixture-token", origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" } }), 200);
  // The lockout itself still protects against same-origin/native guessing.
  for (let i = 0; i < 5; i++) assert.equal(await rawRequest(h.base, { path: "/sessions", headers: { authorization: "Bearer wrong" } }), 401);
  assert.equal(await rawRequest(h.base, { path: "/sessions", headers: { authorization: "Bearer operator-fixture-token" } }), 429);
});
