// Provider-free agentlinkd conformance smoke. Spawns the real host around a
// deterministic fake dext executable; validates process/session/protocol edges.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const host = path.join(here, "..", "src", "server.mjs");
const fake = path.join(here, "fake-dext.mjs");
const cwd = path.join(process.env.HOME, "dextui-workspace");
const port = 8992;
const token = "agentlinkd-smoke";
const base = `http://127.0.0.1:${port}`;
const wsUrl = `ws://127.0.0.1:${port}/ws`;
fs.mkdirSync(cwd, { recursive: true, mode: 0o755 });

const results = [];
const ok = (name, cond, detail = "") => {
  results.push(!!cond);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  const ws = new WebSocket(wsUrl);
  const events = [];
  const waiters = [];
  ws.addEventListener("message", (ev) => {
    const e = JSON.parse(ev.data);
    events.push(e);
    for (const w of [...waiters]) w();
  });
  const waitFor = (pred, ms = 5000, label = "event") =>
    new Promise((resolve, reject) => {
      let done = false;
      const check = () => {
        if (done) return;
        const hit = events.find(pred);
        if (hit) {
          done = true;
          resolve(hit);
        }
      };
      waiters.push(check);
      check();
      setTimeout(() => {
        if (!done) reject(new Error(`timeout waiting for ${label}`));
      }, ms);
    });
  return { ws, events, waitFor, send: (v) => ws.send(JSON.stringify(v)) };
}

async function openClient(name) {
  const c = connect();
  await new Promise((r) => c.ws.addEventListener("open", r));
  c.send({ v: 1, cmd: "hello", token, client: name, protocol: 1 });
  await c.waitFor((e) => e.event === "hello_ok", 3000, `${name} hello`);
  return c;
}

const server = spawn(process.execPath, [host, `--port=${port}`, `--token=${token}`, `--dext=${fake}`, `--cwd=${cwd}`], {
  stdio: ["ignore", "ignore", "inherit"],
});
try {
  let healthy = false;
  for (let i = 0; i < 40 && !healthy; i++) {
    try {
      healthy = (await fetch(`${base}/health`)).ok;
    } catch {}
    if (!healthy) await sleep(100);
  }
  ok("host healthy", healthy);

  const a = await openClient("A");
  a.send({ v: 1, cmd: "session.open" });
  const list = await a.waitFor((e) => e.event === "session.list" && e.data.sessions.length === 1, 3000, "session list");
  const beforeSubscribe = list.data.sessions[0].last_seq;
  const sid = list.data.sessions[0].id;
  a.send({ v: 1, cmd: "session.subscribe", id: sid });
  const initial = await a.waitFor((e) => e.event === "session.snapshot" && e.session === sid, 3000, "initial snapshot");
  ok(
    "initial snapshot stays at existing journal tail",
    initial.seq === beforeSubscribe && initial.data.last_seq === beforeSubscribe,
    `seq ${beforeSubscribe}`,
  );

  a.send({ v: 1, cmd: "prompt.submit", session: sid, text: "one" });
  const start = await a.waitFor((e) => e.session === sid && e.event === "turn_start", 3000, "turn start");

  const b = await openClient("B");
  b.send({ v: 1, cmd: "session.subscribe", id: sid });
  const mid = await b.waitFor((e) => e.session === sid && e.event === "session.snapshot", 3000, "mid snapshot");
  ok("mid-turn snapshot working", mid.data.working === true && typeof mid.data.turn_started_at === "number");
  ok("snapshot does not consume seq", mid.seq === start.seq && mid.data.last_seq === start.seq);

  const end1 = await a.waitFor((e) => e.session === sid && e.event === "turn_end", 5000, "turn 1 end");
  const aSeq = a.events.filter((e) => e.session === sid && typeof e.seq === "number" && e.event !== "session.snapshot").map((e) => e.seq);
  ok("A stream remains gapless after B snapshot", aSeq.every((n, i) => i === 0 || n === aSeq[i - 1] + 1), aSeq.join(","));

  // turn_end is published only after the child closes, so immediate next send
  // must be accepted (not a false busy); fake dext exposes --resume in output.
  a.send({ v: 1, cmd: "prompt.submit", session: sid, text: "two" });
  const end2 = await a.waitFor((e) => e.session === sid && e.event === "turn_end" && e.seq > end1.seq, 5000, "turn 2 end");
  const resumed = a.events.find((e) => e.session === sid && e.event === "text_block_complete" && e.seq < end2.seq && String(e.data).includes("two"));
  ok("second turn accepted immediately", !!end2);
  ok("second turn uses seat resume", String(resumed?.data).includes("[resumed]"));

  // Snapshot after completion carries projection metadata as well as blocks.
  const c = await openClient("C");
  c.send({ v: 1, cmd: "session.subscribe", id: sid });
  const final = await c.waitFor((e) => e.session === sid && e.event === "session.snapshot", 3000, "final snapshot");
  ok("final snapshot idle", final.data.working === false);
  ok("snapshot restores usage/diagnostics", final.data.session_usage?.input === 3 && final.data.diagnostics?.model === "fake-test");
} catch (err) {
  ok("agentlinkd smoke completed", false, String(err));
} finally {
  server.kill("SIGTERM");
}

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
