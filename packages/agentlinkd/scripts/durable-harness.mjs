// Provider-free durability harness; every state root and child is test-owned.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, message = "condition timed out") {
  for (let i = 0; i < 200; i++) { const value = fn(); if (value) return value; await sleep(20); }
  throw new Error(message);
}
export async function durableHost(t, { bridge = false, args = [], env = {} } = {}) {
  const root = path.resolve("packages/agentlinkd");
  const temp = fs.mkdtempSync(path.join(root, ".durable-test-"));
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
    if (signal === "SIGKILL" && fs.existsSync(path.join(state, "sessions.json"))) {
      for (const s of index()) {
        let active = null;
        for (const e of journal(s.id).slice(journalStarts.get(s.id) ?? 0)) {
          if (e.event === "turn_start") active = e.data?.pid;
          if (e.event === "turn_end" || e.event === "interrupted") active = null;
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
    child = spawn(process.execPath, [path.join(root, "src/server.mjs"), "--port=0", "--token=durable-test-token", `--cwd=${cwd}`, `--state-dir=${state}`, `--crew=${temp}/no-crew`, `--dext=${root}/scripts/fake-dext.mjs`, ...args, ...extra], {
      env: { ...process.env, HOME: home, DEXT_HOME: home, DEXT_SESSIONS_DIR: "", DEXT_LOGS_DIR: "", AGENTLINKD_AUTO_RESUME: "false", AGENTLINKD_TIMERS: "false", FAKE_DEXT_NDJSON: bridge ? "1" : "0", ...env },
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
  await start();
  return { temp, home, state, cwd, journal, index, start, stop, client, open };
}
