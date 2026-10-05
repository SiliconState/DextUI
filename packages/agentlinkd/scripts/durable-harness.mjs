// Provider-free durability harness; every state root and child is test-owned.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, message = "condition timed out") {
  for (let i = 0; i < 200; i++) { const value = fn(); if (value) return value; await sleep(20); }
  throw new Error(message);
}
export async function durableHost(t, { bridge = false, args = [], env = {}, bin, setup } = {}) {
  const root = path.resolve("packages/agentlinkd");
  // Real core checkpoints must not discover the surrounding UI repository:
  // concurrent fake-host tests legitimately mutate scratch files there.
  const temp = fs.mkdtempSync(path.join(bin ? os.tmpdir() : root, ".durable-test-"));
  const home = path.join(temp, "home");
  const state = path.join(temp, "state");
  const cwd = path.join(temp, "workspace");
  fs.mkdirSync(cwd);
  let child, base, stderr = "";
  let journalStarts = new Map();
  const sockets = [];
  const journal = (id) => {
    try { return fs.readFileSync(path.join(state, "journals", `${id}.jsonl`), "utf8").split("\n").filter(Boolean).map(JSON.parse); }
    catch { return []; }
  };
  const index = () => JSON.parse(fs.readFileSync(path.join(state, "sessions.json"), "utf8"));
  const stop = async (signal = "SIGTERM") => {
    for (const ws of sockets.splice(0)) ws.close();
    const fakePids = new Set();
    if (signal === "SIGKILL" && !bin && fs.existsSync(path.join(state, "sessions.json"))) {
      for (const s of index()) {
        let active = null;
        for (const e of journal(s.id).slice(journalStarts.get(s.id) ?? 0)) {
          if (e.event === "turn_start") active = e.data?.pid;
          // An idle fake bridge remains test-owned until host EOF. Include its
          // current-host pid even when only disposable background work remains.
          if (!bridge && (e.event === "turn_end" || e.event === "interrupted")) active = null;
        }
        if (active) fakePids.add(active);
      }
    }
    if (child?.exitCode === null && child?.signalCode === null) {
      const exit = once(child, "exit"); child.kill(signal); await exit;
    }
    // SIGKILL bypasses host cleanup; terminate only fake children recorded in
    // this isolated journal, never inspect or signal unrelated processes.
    for (const pid of fakePids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  };
  t.after(async () => { await stop(); fs.rmSync(temp, { recursive: true, force: true }); });
  async function start(extra = []) {
    journalStarts = new Map();
    if (fs.existsSync(path.join(state, "sessions.json"))) for (const s of index()) journalStarts.set(s.id, journal(s.id).length);
    const childEnv = { ...process.env, HOME: home, DEXT_HOME: home, AGENTLINKD_AUTO_RESUME: "false", AGENTLINKD_TIMERS: "false", FAKE_DEXT_NDJSON: bridge ? "1" : "0", ...env };
    // Empty core overrides mean cwd-relative state, not "unset". Never inherit
    // operator paths into isolated tests; use the temporary DEXT_HOME layout.
    if (!env.DEXT_SESSIONS_DIR) delete childEnv.DEXT_SESSIONS_DIR;
    if (!env.DEXT_LOGS_DIR) delete childEnv.DEXT_LOGS_DIR;
    child = spawn(process.execPath, [path.join(root, "src/server.mjs"), "--port=0", "--token=durable-test-token", `--cwd=${cwd}`, `--state-dir=${state}`, `--crew=${env.CREW_BIN ?? `${temp}/no-crew`}`, `--dext=${bin ?? `${root}/scripts/fake-dext.mjs`}`, ...args, ...extra], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", (b) => stderr += b);
    let stdout = ""; child.stdout.on("data", (b) => stdout += b);
    const match = await until(() => /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout), stderr);
    base = match[1];
  }
  async function client() {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws"); sockets.push(ws);
    const events = []; ws.addEventListener("message", (e) => events.push(JSON.parse(e.data)));
    await once(ws, "open");
    const send = (cmd, payload = {}) => ws.send(JSON.stringify({ v: 1, cmd, ...payload }));
    const wait = (pred, from = 0) => until(() => events.slice(from).find(pred), `event timed out: ${stderr}`);
    send("hello", { token: "durable-test-token" });
    const hello = await wait((e) => e.event === "hello_ok");
    return { ws, events, send, wait, hello };
  }
  async function open(c) {
    const existing = new Set(fs.existsSync(path.join(state, "sessions.json")) ? index().map((s) => s.id) : []);
    c.send("session.open");
    const list = await c.wait((e) => e.event === "session.list" && e.data.sessions.some((s) => !existing.has(s.id)));
    const id = list.data.sessions.find((s) => !existing.has(s.id)).id;
    assert.ok(id); c.send("session.subscribe", { id });
    await c.wait((e) => e.event === "session.snapshot" && e.session === id);
    return id;
  }
  if (setup) await setup({ temp, home, state, cwd });
  await start();
  return { temp, home, state, cwd, journal, index, start, stop, client, open,
    get child() { return child; },
    request(route, init = {}) {
      const token = child.spawnargs.find((arg) => arg.startsWith("--token="))?.slice(8);
      return fetch(base + route, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
    },
  };
}
