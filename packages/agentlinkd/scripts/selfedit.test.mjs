// Self-edit: staged build/swap/LKG primitives, static-dir resolution, restart
// gating, and the host surface (capability, /__self, /ui, exit code 75).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { buildUi, buildable, distPaths, distVersion, rollbackDist, swapDist } from "./ui-build.mjs";
import { RESTART_EXIT_CODE, RESTART_REQUEST_FILE, createSelfEdit, parseRestartRequest, resolveStaticDir } from "../src/selfedit.mjs";

const root = path.resolve("packages/agentlinkd");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Pairing token for the throwaway host under test (not a real credential). */
const TEST_TOKEN = "selfedit-test-pairing";

/** A fake DextUI checkout: package.json name, apps/web/src, node_modules. */
function fakeRepo(t, { dist = true } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dextui-repo-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "dextui" }));
  fs.mkdirSync(path.join(repo, "apps", "web", "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "node_modules"));
  if (dist) writeBuild(distPaths(repo).dist, "v1");
  return repo;
}

function writeBuild(dir, id) {
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), `<html>${id}</html>`);
  fs.writeFileSync(path.join(dir, "assets", "index-abc.js"), `navigator.serviceWorker.register("/sw.js?v=${id}")`);
}

test("buildable + distVersion: recognises a checkout and reads vite's build stamp", (t) => {
  const repo = fakeRepo(t);
  assert.equal(buildable(repo), true);
  assert.equal(buildable(path.join(repo, "apps")), false);
  assert.equal(distVersion(distPaths(repo).dist).id, "v1");
  assert.equal(distVersion(path.join(repo, "nope")), null);
});

test("swapDist: staging → dist, old dist → lkg; rollbackDist restores it", (t) => {
  const repo = fakeRepo(t);
  const { dist, staging, lkg } = distPaths(repo);
  assert.throws(() => swapDist(repo), /no index\.html/, "nothing staged");
  writeBuild(staging, "v2");
  assert.equal(swapDist(repo).id, "v2");
  assert.equal(distVersion(dist).id, "v2");
  assert.equal(distVersion(lkg).id, "v1", "previous build kept");
  assert.equal(fs.existsSync(staging), false);
  // A second swap replaces the LKG with the build it displaced.
  writeBuild(staging, "v3");
  swapDist(repo);
  assert.equal(distVersion(lkg).id, "v2");
  assert.equal(rollbackDist(repo).id, "v2");
  assert.equal(distVersion(dist).id, "v2");
  assert.equal(fs.existsSync(lkg), false, "rollback consumes the LKG");
  assert.throws(() => rollbackDist(repo), /no last-known-good/);
});

test("buildUi: fake steps — success swaps, a failing step leaves dist untouched and clears staging", async (t) => {
  const repo = fakeRepo(t);
  const { web, dist, staging } = distPaths(repo);
  const stage = (id) => ["stage", process.execPath, ["-e", `const fs=require('fs');fs.mkdirSync('dist.staging/assets',{recursive:true});fs.writeFileSync('dist.staging/index.html','x');fs.writeFileSync('dist.staging/assets/index-a.js','sw.js?v=${id}')`], web];
  const seen = [];
  const ok = await buildUi({ repoRoot: repo, steps: [["noop", process.execPath, ["-e", "0"], repo], stage("v9")], onStep: (s) => seen.push(s.label) });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.version.id, "v9");
  assert.deepEqual(seen, ["noop", "stage"]);
  assert.deepEqual(ok.steps.map((s) => [s.label, s.ok]), [["noop", true], ["stage", true]]);

  const fail = await buildUi({ repoRoot: repo, steps: [stage("v10"), ["boom", process.execPath, ["-e", "console.error('type error here');process.exit(3)"], repo]] });
  assert.equal(fail.ok, false);
  assert.equal(fail.error, "step_failed");
  assert.equal(fail.failed, "boom");
  assert.match(fail.tail, /type error here/);
  assert.equal(distVersion(dist).id, "v9", "served build untouched");
  assert.equal(fs.existsSync(staging), false, "staging cleaned up");

  const nope = await buildUi({ repoRoot: path.join(repo, "apps") });
  assert.equal(nope.error, "not_buildable");
});

test("resolveStaticDir: dist, --safe → lkg, missing dist falls back to lkg, foreign dirs untouched", (t) => {
  const repo = fakeRepo(t);
  const { dist, lkg } = distPaths(repo);
  assert.deepEqual(resolveStaticDir({ staticDir: dist, repoRoot: repo }), { dir: dist, mode: "dist" });
  assert.deepEqual(resolveStaticDir({ staticDir: dist, repoRoot: repo, safe: true }), { dir: dist, mode: "dist" }, "no LKG yet: --safe still serves dist");
  writeBuild(lkg, "v0");
  assert.deepEqual(resolveStaticDir({ staticDir: dist, repoRoot: repo, safe: true }), { dir: lkg, mode: "lkg" });
  fs.rmSync(dist, { recursive: true });
  assert.deepEqual(resolveStaticDir({ staticDir: dist, repoRoot: repo }), { dir: lkg, mode: "lkg" }, "missing dist → serve the LKG rather than nothing");
  fs.rmSync(lkg, { recursive: true });
  assert.equal(resolveStaticDir({ staticDir: dist, repoRoot: repo }).mode, "missing");
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "static-"));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  assert.equal(resolveStaticDir({ staticDir: other, repoRoot: repo, safe: true }).dir, other, "--static outside the repo is never redirected");
});

test("parseRestartRequest: JSON or free text, bounded", () => {
  assert.deepEqual(parseRestartRequest('{"reason":"host edit","by":"agent"}'), { reason: "host edit", by: "agent" });
  assert.deepEqual(parseRestartRequest("edited server.mjs"), { reason: "edited server.mjs", by: "file" });
  assert.deepEqual(parseRestartRequest(""), { reason: "", by: "file" });
  assert.equal(parseRestartRequest(JSON.stringify({ reason: "x".repeat(500) })).reason.length, 200);
});

test("createSelfEdit: restart is immediate when idle, queued when busy, honored by tick(), cancellable, and readable from the request file", async (t) => {
  const repo = fakeRepo(t);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "state-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const events = [];
  let idle = false;
  const restarts = [];
  const se = createSelfEdit({
    repoRoot: repo, stateDir: state, staticDir: distPaths(repo).dist,
    broadcast: (event, data) => events.push({ event, data }),
    isIdle: () => idle, busyDetail: () => (idle ? [] : [{ kind: "turn", session: "s1", title: "t" }]),
    onRestart: (code) => restarts.push(code),
  });
  assert.equal(se.enabled, true);
  const st = se.status();
  assert.equal(st.serving, "dist");
  assert.equal(st.version.id, "v1");
  assert.equal(st.lkg, null);
  assert.equal(st.restart_exit_code, RESTART_EXIT_CODE);
  assert.equal(st.request_file, path.join(state, RESTART_REQUEST_FILE));

  const r1 = se.requestRestart({ reason: "edited host", by: "test" });
  assert.equal(r1.pending, true);
  assert.deepEqual(r1.busy, [{ kind: "turn", session: "s1", title: "t" }]);
  assert.equal(events.at(-1).event, "x-agentlinkd.host.restart");
  assert.equal(events.at(-1).data.phase, "pending");
  assert.equal(se.requestRestart({ by: "again" }).already, true, "second request folds into the first");
  se.tick();
  assert.deepEqual(restarts, [], "still busy");
  assert.equal(se.cancelRestart(), true);
  assert.equal(events.at(-1).data.phase, "cancelled");
  assert.equal(se.status().restart_pending, null);

  se.requestRestart({ reason: "take two", by: "test" });
  idle = true;
  se.tick();
  await sleep(350);
  assert.deepEqual(restarts, [RESTART_EXIT_CODE], "tick at the idle boundary restarts");
  assert.equal(events.at(-1).data.phase, "restarting");

  // The agent's path: a request file under the state dir.
  idle = false;
  restarts.length = 0;
  se.cancelRestart();
  se.start();
  fs.writeFileSync(path.join(state, RESTART_REQUEST_FILE), JSON.stringify({ reason: "from agent", by: "agent" }));
  for (let i = 0; i < 30 && !se.restartPending(); i++) await sleep(50);
  assert.equal(se.restartPending()?.reason, "from agent");
  assert.equal(se.restartPending()?.by, "agent");
  idle = true;
  se.tick();
  await sleep(350);
  assert.deepEqual(restarts, [RESTART_EXIT_CODE]);
  assert.equal(fs.existsSync(path.join(state, RESTART_REQUEST_FILE)), false, "request file consumed");
});

test("createSelfEdit: rollback broadcasts ui.rebuilt; external dist swaps are noticed", async (t) => {
  const repo = fakeRepo(t);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "state-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const events = [];
  const se = createSelfEdit({ repoRoot: repo, stateDir: state, staticDir: distPaths(repo).dist, broadcast: (event, data) => events.push({ event, data }), isIdle: () => true, busyDetail: () => [], onRestart: () => {} });
  assert.equal(se.rollback().error, "rollback_failed", "no LKG");
  se.start();
  // The agent ran scripts/ui-build.mjs itself: dist gets swapped underneath the host.
  writeBuild(distPaths(repo).staging, "v2");
  swapDist(repo);
  for (let i = 0; i < 40 && !events.some((e) => e.event === "x-agentlinkd.ui.rebuilt"); i++) await sleep(50);
  const rebuilt = events.find((e) => e.event === "x-agentlinkd.ui.rebuilt");
  assert.ok(rebuilt, "external swap detected");
  assert.equal(rebuilt.data.by, "external");
  assert.equal(rebuilt.data.version.id, "v2");
  const rb = se.rollback({ by: "test" });
  assert.equal(rb.ok, true);
  assert.equal(rb.version.id, "v1");
  assert.equal(events.at(-1).data.rolled_back, true);
});

// ---------- host surface ----------

async function host(t) {
  const temp = fs.mkdtempSync(path.join(root, ".selfedit-test-"));
  const cwd = path.join(temp, "workspace");
  fs.mkdirSync(cwd, { recursive: true });
  const stateDir = path.join(temp, "state");
  const child = spawn(process.execPath, [path.join(root, "src/server.mjs"), "--port=0", `--token=${TEST_TOKEN}`, `--cwd=${cwd}`, `--state-dir=${stateDir}`, `--dext=${path.join(root, "scripts/fake-dext.mjs")}`, "--approval=auto-read"], {
    env: { ...process.env, DEXT_HOME: path.join(temp, "dext"), FAKE_PACKS_ROOT: path.join(temp, "shelves"), PATH: path.dirname(process.execPath) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) try { ws.close(); } catch { /* closed */ }
    if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([exited, sleep(4000)]); }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  let base = "";
  for (;;) {
    const [chunk] = await once(child.stdout, "data");
    const m = /listening on (http:\/\/[^\s]+)/.exec(chunk.toString());
    if (m) { base = m[1]; break; }
  }
  async function client() {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws");
    sockets.push(ws);
    const events = [];
    ws.addEventListener("message", (m) => events.push(JSON.parse(m.data)));
    await once(ws, "open");
    const send = (cmd, extra = {}) => ws.send(JSON.stringify({ v: 1, cmd, ...extra }));
    const wait = async (pred, from = 0) => {
      for (let i = 0; i < 400; i++) {
        const hit = events.slice(from).find(pred);
        if (hit) return hit;
        await sleep(25);
      }
      throw new Error(`timeout waiting; last events: ${JSON.stringify(events.slice(-5))}`);
    };
    send("hello", { token: TEST_TOKEN });
    const hello = await wait((e) => e.event === "hello_ok");
    return { events, send, wait, hello };
  }
  const req = async (p, init = {}) => {
    const r = await fetch(base + p, { ...init, headers: { Authorization: `Bearer ${TEST_TOKEN}`, ...(init.headers ?? {}) } });
    return { status: r.status, body: await r.json() };
  };
  return { client, req, base, stateDir, exited, stderr: () => stderr };
}

test("host: self_edit capability, hello_ok.self, GET /__self, /ui status, restart-when-idle exits 75", { timeout: 30000 }, async (t) => {
  const h = await host(t);
  const c = await h.client();
  assert.ok(c.hello.data.capabilities.includes("self_edit"), "running from the checkout advertises self-edit");
  const self = c.hello.data.self;
  assert.equal(path.resolve(self.repo), path.resolve("."), "workbench cwd is this checkout");
  assert.equal(self.enabled, true);
  assert.equal(self.restart_pending, null);
  assert.equal(self.request_file, path.join(h.stateDir, RESTART_REQUEST_FILE));

  const st = await h.req("/__self");
  assert.equal(st.status, 200);
  assert.equal(st.body.repo, self.repo);
  const unauth = await fetch(h.base + "/__self");
  assert.equal(unauth.status, 401);
  assert.equal((await h.req("/__self/bogus", { method: "POST" })).status, 405);

  c.send("x-agentlinkd.ui.status");
  const reply = await c.wait((e) => e.event === "x-agentlinkd.ui.status");
  assert.equal(reply.data.enabled, true);

  c.send("session.open");
  const list = await c.wait((e) => e.event === "session.list" && e.data.sessions.length === 1);
  const id = list.data.sessions[0].id;
  c.send("session.subscribe", { id });
  c.send("slash", { session: id, raw: "/ui status" });
  const out = await c.wait((e) => e.session === id && e.event === "structured_slash");
  assert.match(out.data, /^ui: serving dist/);
  assert.match(out.data, /agent path: node packages\/agentlinkd\/scripts\/ui-build\.mjs/);
  c.send("slash", { session: id, raw: "/ui frobnicate" });
  await c.wait((e) => e.event === "error" && e.data.code === "bad_request");
  assert.ok(c.hello.data.commands.some((x) => x.cmd === "/ui"), "composer menu lists /ui");

  // Busy: a turn is running → restart queues; the turn's end is the idle boundary.
  let mark = c.events.length;
  c.send("prompt.submit", { session: id, text: "hello" });
  await c.wait((e) => e.session === id && e.event === "turn_start", mark);
  c.send("x-agentlinkd.host.restart", { reason: "test edit" });
  const pending = await c.wait((e) => e.event === "x-agentlinkd.host.restart" && e.data.phase === "pending", mark);
  assert.equal(pending.data.reason, "test edit");
  assert.ok(pending.data.busy.some((b) => b.kind === "turn"));
  const restarting = await c.wait((e) => e.event === "x-agentlinkd.host.restart" && e.data.phase === "restarting", mark);
  assert.equal(restarting.data.exit_code, RESTART_EXIT_CODE);
  assert.equal(await h.exited, RESTART_EXIT_CODE, "systemd Restart=on-failure brings it back");
});
