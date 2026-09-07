// Live driver: real agentlinkd + real dext in bridge mode. Costs model calls;
// not part of `npm test`. Usage: node packages/agentlinkd/scripts/live-bridge.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const port = 8993;
const token = "livetest-" + process.pid;
const cwd = path.join(os.homedir(), "dextui-workspace", `live-${process.pid}`);
const state = path.join(cwd, "state");
fs.mkdirSync(cwd, { recursive: true });
const dext = process.env.DEXT_BIN ?? path.join(os.homedir(), "Dext", "target", "release", "dext");
const host = spawn("node", [new URL("../src/server.mjs", import.meta.url).pathname, `--port=${port}`, `--token=${token}`, `--cwd=${cwd}`, `--state-dir=${state}`, "--approval=ask", `--dext=${dext}`], { stdio: ["ignore", "pipe", "pipe"] });
host.stdout.on("data", (d) => process.stderr.write("[host] " + d));
host.stderr.on("data", (d) => process.stderr.write("[host!] " + d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2500);

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const events = [];
const waiters = [];
ws.addEventListener("message", (ev) => { const e = JSON.parse(ev.data); events.push(e); if (process.env.TRACE) process.stderr.write(`[ev] ${e.event} ${JSON.stringify(e.data ?? "").slice(0, 100)}\n`); for (const w of [...waiters]) w(); });
const send = (v) => ws.send(JSON.stringify(v));
const waitFor = (pred, ms, label) => new Promise((res, rej) => {
  const t0 = Date.now();
  let done = false;
  const check = () => {
    if (done) return;
    const hit = events.find(pred);
    if (hit) { done = true; res(hit); }
    else if (Date.now() - t0 > ms) { done = true; rej(new Error("timeout: " + label)); }
    if (done) { const i = waiters.indexOf(check); if (i >= 0) waiters.splice(i, 1); clearInterval(iv); }
  };
  waiters.push(check);
  const iv = setInterval(check, 200);
});
const finish = (code) => { host.kill("SIGTERM"); setTimeout(() => process.exit(code), 500); };
try {
  await new Promise((r) => ws.addEventListener("open", r));
  send({ v: 1, cmd: "hello", token, client: "live", protocol: 1 });
  const hello = await waitFor((e) => e.event === "hello_ok", 3000, "hello");
  console.error("caps:", hello.data.capabilities.filter((c) => ["steering", "steering.live", "approvals", "model_switch"].includes(c)));
  send({ v: 1, cmd: "session.open", cwd, approval: "ask" });
  const list = await waitFor((e) => e.event === "session.list" && e.data.sessions?.length >= 1, 5000, "open");
  const sid = list.data.sessions[0].id;
  console.error("session", sid);
  send({ v: 1, cmd: "session.subscribe", id: sid });

  // Turn 1: write_file under ask => permission round trip.
  send({ v: 1, cmd: "prompt.submit", session: sid, text: "Create a file named hello.txt containing exactly: hi\nUse write_file. No other actions.", nonce: "n1aaaaaa" });
  const req = await waitFor((e) => e.event === "permission.request", 90000, "permission.request");
  console.error("permission.request", req.data.tool, req.data.request_id);
  send({ v: 1, cmd: "permission.respond", session: sid, request_id: req.data.request_id, choice: "allow" });
  const resolved = await waitFor((e) => e.event === "permission.resolved", 10000, "resolved");
  console.error("permission.resolved", resolved.data);
  await waitFor((e) => e.event === "turn_end", 120000, "turn_end 1");
  console.error("hello.txt =", JSON.stringify(fs.existsSync(path.join(cwd, "hello.txt")) ? fs.readFileSync(path.join(cwd, "hello.txt"), "utf8") : null));

  // Turn 2: live steer + effort change mid-turn.
  const n0 = events.length;
  send({ v: 1, cmd: "prompt.submit", session: sid, text: "Count slowly from 1 to 5, one number per line, thinking about each. Then say done.", nonce: "n2aaaaaa" });
  await waitFor((e) => e.event === "turn_start" && events.indexOf(e) >= n0, 30000, "turn_start 2");
  send({ v: 1, cmd: "steering.inject", session: sid, text: "Also append the word BANANA after done.", nonce: "n3aaaaaa" });
  send({ v: 1, cmd: "session.configure", id: sid, thinking_effort: "low" });
  const steer = await waitFor((e) => e.event === "steering_received" && events.indexOf(e) >= n0, 10000, "steering_received");
  console.error("steering_received", steer.data);
  await waitFor((e) => e.event === "turn_end" && events.indexOf(e) > n0, 120000, "turn_end 2");
  const text = events.slice(n0).filter((e) => e.event === "text_block_complete").map((e) => e.data).join("\n");
  console.error("turn2 text tail:", JSON.stringify(text.slice(-120)));
  console.error("effort events:", events.slice(n0).filter((e) => e.event === "thinking_effort_changed").map((e) => e.data));
  console.error("errors:", events.filter((e) => e.event === "error").map((e) => e.data));

  // Model switch after history must not be locked.
  const n1 = events.length;
  const g = hello.data.model_catalog[0];
  send({ v: 1, cmd: "session.configure", id: sid, provider: g.provider, model: g.models[g.models.length - 1] });
  const cfg = await waitFor((e) => e.event === "session.configured" && events.indexOf(e) >= n1, 5000, "configured");
  console.error("configured after switch:", cfg.data);
  const errs = events.slice(n1).filter((e) => e.event === "error");
  console.error("switch errors:", errs.map((e) => e.data));
  send({ v: 1, cmd: "session.close", id: sid });
  await sleep(1500);
  finish(0);
} catch (err) {
  console.error("FAIL", err.message);
  console.error("last events:", events.slice(-8).map((e) => e.event + " " + JSON.stringify(e.data).slice(0, 120)).join("\n"));
  finish(1);
}
