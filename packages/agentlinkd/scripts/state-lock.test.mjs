// One host per state dir. Every host here is a test-owned child with its own
// temporary state dir and the fake dext; no operator state is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { acquireStateLock, processStarted, LOCK_NAME } from "../src/state-lock.mjs";

const root = path.resolve("packages/agentlinkd");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// once(child, "exit") never resolves if the child already exited.
const exited = (child) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "exit");

function tempRoot(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dextui-lock-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "workspace"));
  fs.mkdirSync(path.join(dir, "state"), { mode: 0o700 });
  return dir;
}

function sleeper(t) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  return child;
}

test("state lock: live holder refuses, dead or recycled holder is replaced, unsafe lock files refused", async (t) => {
  const dir = tempRoot(t);
  const state = path.join(dir, "state");
  const file = path.join(state, LOCK_NAME);
  const holder = sleeper(t);
  await sleep(100);
  fs.writeFileSync(file, JSON.stringify({ pid: holder.pid, started: processStarted(holder.pid), port: 8788, nonce: "live", at: "earlier" }), { mode: 0o600 });
  assert.throws(() => acquireStateLock({ stateDir: state, port: 1 }), (err) => err.code === "ELOCKED" && /pid \d+, port 8788/.test(err.message) && /Nothing was changed/.test(err.message));
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).nonce, "live", "a live holder's lock is never removed");

  // Same pid, different start time: the pid was recycled after the old host died.
  fs.writeFileSync(file, JSON.stringify({ pid: holder.pid, started: "Thu Jan 1 00:00:00 1970", nonce: "recycled" }), { mode: 0o600 });
  const logs = [];
  const recycled = acquireStateLock({ stateDir: state, port: 2, log: (m) => logs.push(m) });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, process.pid);
  assert.match(logs.join("\n"), /removed stale state lock/);
  recycled.release();
  assert.equal(fs.existsSync(file), false, "release removes our own lock");

  // A host killed with SIGKILL leaves its lock behind; the next start reclaims it.
  holder.kill("SIGKILL"); await exited(holder);
  fs.writeFileSync(file, JSON.stringify({ pid: holder.pid, started: "whatever", nonce: "dead" }), { mode: 0o600 });
  const reclaimed = acquireStateLock({ stateDir: state, port: 3 });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).nonce, reclaimed.record.nonce);
  // Release never deletes a lock that is no longer ours.
  fs.writeFileSync(file, JSON.stringify({ pid: 1, nonce: "someone-else" }));
  reclaimed.release();
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).nonce, "someone-else");
  fs.rmSync(file);

  fs.writeFileSync(file, "not json"); // torn or garbage lock: stale
  acquireStateLock({ stateDir: state, port: 4 }).release();

  const outside = path.join(dir, "outside");
  fs.writeFileSync(outside, "keep");
  fs.symlinkSync(outside, file);
  assert.throws(() => acquireStateLock({ stateDir: state, port: 5 }), /symlink, refusing/);
  assert.equal(fs.readFileSync(outside, "utf8"), "keep");
  assert.equal(fs.readdirSync(state).filter((n) => n.includes(".tmp") || n.includes(".stale.")).length, 0, "no temporary files left behind");
});

async function startHost(t, dir, port = 0, extra = []) {
  const child = spawn(process.execPath, [
    path.join(root, "src/server.mjs"), `--port=${port}`, "--token=lock-fixture-token", `--cwd=${path.join(dir, "workspace")}`,
    `--state-dir=${path.join(dir, "state")}`, `--dext=${path.join(root, "scripts/fake-dext.mjs")}`, ...extra,
  ], { env: { ...process.env, DEXT_HOME: path.join(dir, "dext"), DEXT_SESSIONS_DIR: "", DEXT_LOGS_DIR: "", AGENTLINKD_AUTO_RESUME: "false", AGENTLINKD_TIMERS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited(child); } });
  for (let i = 0; i < 300 && !/listening on/.test(stdout) && child.exitCode === null; i++) await sleep(25);
  const base = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1];
  return { child, base, stdout: () => stdout, stderr: () => stderr };
}

// A session the index says was mid-turn: a restoring host journals it as lost.
function seedWorkingSession(dir) {
  const state = path.join(dir, "state");
  fs.mkdirSync(path.join(state, "journals"), { recursive: true, mode: 0o700 });
  const id = "sess_424242";
  fs.writeFileSync(path.join(state, "sessions.json"), JSON.stringify([{ id, title: "Running", cwd: path.join(dir, "workspace"), seat: "dextui-4242", turns: 1, working: true }]));
  const journal = path.join(state, "journals", `${id}.jsonl`);
  const lines = [
    { v: 1, session: id, seq: 1, ts: Date.now(), event: "user_message", data: { text: "long task" } },
    { v: 1, session: id, seq: 2, ts: Date.now(), event: "turn_start", data: {} },
  ];
  fs.writeFileSync(journal, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { mode: 0o600 });
  return journal;
}

test("a second host on the same state dir exits before touching journals or the index", { timeout: 30000 }, async (t) => {
  const dir = tempRoot(t);
  const first = await startHost(t, dir);
  assert.ok(first.base, `first host started: ${first.stderr()}`);
  const journal = seedWorkingSession(dir); // written after A restored: A does not own this "turn"
  const index = fs.readFileSync(path.join(dir, "state", "sessions.json"), "utf8");
  const before = fs.readFileSync(journal);
  const second = await startHost(t, dir); // different (ephemeral) port, same state dir
  await exited(second.child);
  assert.equal(second.child.exitCode, 1);
  assert.equal(second.base, undefined, "the second host never listens");
  assert.match(second.stderr(), /another agentlinkd \(pid \d+, port 0.*is using state dir.*Nothing was changed/s);
  assert.deepEqual(fs.readFileSync(journal), before, "no 'turn lost' or any other line appended");
  assert.equal(fs.readFileSync(path.join(dir, "state", "sessions.json"), "utf8"), index, "index untouched");
  assert.equal(first.child.exitCode, null, "the first host keeps running");
  assert.equal((await fetch(`${first.base}/health`)).status, 200);

  // The first host dies hard (no exit hooks): its lock is stale, not permanent.
  first.child.kill("SIGKILL"); await exited(first.child);
  assert.ok(fs.existsSync(path.join(dir, "state", LOCK_NAME)), "SIGKILL leaves the lock file behind");
  const third = await startHost(t, dir);
  assert.ok(third.base, `reclaims a stale lock: ${third.stderr()}`);
  assert.match(third.stderr(), /removed stale state lock/);
  // Now it is the owner, so restoring the interrupted turn is correct.
  assert.match(fs.readFileSync(journal, "utf8"), /turn lost: agentlinkd restarted/);
  third.child.kill("SIGTERM"); await exited(third.child);
  assert.equal(fs.existsSync(path.join(dir, "state", LOCK_NAME)), false, "a clean stop releases the lock");
});

test("a busy port (even a pre-lock host) stops startup before session restore", { timeout: 30000 }, async (t) => {
  const dir = tempRoot(t);
  const journal = seedWorkingSession(dir);
  const before = fs.readFileSync(journal);
  // Something already listening on the port, holding no state lock (an older host).
  const squatter = http.createServer((_q, r) => r.end("busy"));
  await new Promise((r) => squatter.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => squatter.close(r)));
  const h = await startHost(t, dir, squatter.address().port);
  await exited(h.child);
  assert.equal(h.child.exitCode, 1);
  assert.match(h.stderr(), new RegExp(`port ${squatter.address().port} on 127\\.0\\.0\\.1 is already in use`));
  assert.doesNotMatch(h.stderr(), /at Server\.setupListenHandle|node:net/, "a clear message, not a stack trace");
  assert.deepEqual(fs.readFileSync(journal), before, "the running host's turn is not journaled as lost");
  assert.equal(fs.existsSync(path.join(dir, "state", LOCK_NAME)), false, "the refused host released its lock");
});
