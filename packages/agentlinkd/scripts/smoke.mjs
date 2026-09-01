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
  c.hello = await c.waitFor((e) => e.event === "hello_ok", 3000, `${name} hello`);
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
  ok(
    "hello advertises discovered models and effort options",
    a.hello.data.model_catalog?.length === 2 &&
      a.hello.data.model_catalog[1]?.models?.includes("beta") &&
      a.hello.data.effort_options?.includes("xhigh") &&
      a.hello.data.capabilities?.includes("model_select") &&
      a.hello.data.capabilities?.includes("effort_select"),
  );
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
  ok(
    "initial snapshot exposes default model and effort",
    initial.data.provider === "fake-a" && initial.data.meta.model === "alpha" && initial.data.thinking_effort === "medium",
  );

  // Fresh sessions accept both model and effort. The resulting event is the
  // authoritative projection update before any child process starts.
  a.send({
    v: 1,
    cmd: "session.configure",
    id: sid,
    provider: "fake-b",
    model: "beta",
    thinking_effort: "high",
  });
  const configured = await a.waitFor(
    (e) => e.session === sid && e.event === "session.configured" && e.data.model === "beta" && e.data.model_locked === false,
    3000,
    "fresh configure",
  );
  ok("fresh session model+effort configured", configured.data.provider === "fake-b" && configured.data.thinking_effort === "high");

  a.send({ v: 1, cmd: "prompt.submit", session: sid, text: "partial-stream one" });
  const start = await a.waitFor((e) => e.session === sid && e.event === "turn_start", 3000, "turn start");

  const b = await openClient("B");
  b.send({ v: 1, cmd: "session.subscribe", id: sid });
  const mid = await b.waitFor((e) => e.session === sid && e.event === "session.snapshot", 3000, "mid snapshot");
  ok("mid-turn snapshot working", mid.data.working === true && typeof mid.data.turn_started_at === "number");
  ok("snapshot does not consume seq", mid.seq === start.seq && mid.data.last_seq === start.seq);

  const end1 = await a.waitFor((e) => e.session === sid && e.event === "turn_end", 5000, "turn 1 end");
  const firstTexts = a.events.filter(
    (e) => e.session === sid && e.event === "text_block_complete" && String(e.data).includes("partial-stream one"),
  );
  const firstText = firstTexts[0];
  const partialWarnings = a.events.filter(
    (e) => e.session === sid && e.event === "warn" && String(e.data).includes("preserved partial response instead of replaying"),
  );
  const locked = a.events.find(
    (e) => e.session === sid && e.event === "session.configured" && e.data.model_locked === true && e.seq < end1.seq,
  );
  ok("selected model+effort reach child dext", String(firstText?.data).includes("[fake-b/beta; effort=high]"));
  ok("partial response preserved exactly once without replay", firstTexts.length === 1 && partialWarnings.length === 1);
  ok("model locks before completed turn becomes idle", locked?.data.model === "beta" && locked?.data.thinking_effort === "high");
  const aSeq = a.events.filter((e) => e.session === sid && typeof e.seq === "number" && e.event !== "session.snapshot").map((e) => e.seq);
  ok("A stream remains gapless after B snapshot", aSeq.every((n, i) => i === 0 || n === aSeq[i - 1] + 1), aSeq.join(","));

  // Model is immutable once history exists; effort remains configurable and
  // is explicitly reapplied by dext after seat resume.
  a.send({ v: 1, cmd: "session.configure", id: sid, provider: "fake-a", model: "alpha-pro" });
  const modelLocked = await a.waitFor(
    (e) => e.event === "error" && e.data?.code === "model_locked",
    3000,
    "model_locked",
  );
  ok("post-history model change rejected", /start a new session/i.test(modelLocked.data.message));
  a.send({ v: 1, cmd: "session.configure", id: sid, thinking_effort: "xhigh" });
  const effortChanged = await a.waitFor(
    (e) => e.session === sid && e.event === "session.configured" && e.seq > end1.seq && e.data.thinking_effort === "xhigh",
    3000,
    "effort configure",
  );
  ok("post-history effort change accepted", effortChanged.data.model_locked === true);

  // turn_end is published only after the child closes, so immediate next send
  // must be accepted (not a false busy); fake dext exposes --resume in output.
  a.send({ v: 1, cmd: "prompt.submit", session: sid, text: "two" });
  const end2 = await a.waitFor((e) => e.session === sid && e.event === "turn_end" && e.seq > end1.seq, 5000, "turn 2 end");
  const resumed = a.events.find((e) => e.session === sid && e.event === "text_block_complete" && e.seq < end2.seq && String(e.data).includes("two"));
  ok("second turn accepted immediately", !!end2);
  ok("second turn uses seat resume", String(resumed?.data).includes("[resumed]"));
  ok("resume keeps model and applies new effort", String(resumed?.data).includes("[fake-b/beta; effort=xhigh]"));

  // Snapshot after completion carries projection metadata as well as blocks.
  const c = await openClient("C");
  c.send({ v: 1, cmd: "session.subscribe", id: sid });
  const final = await c.waitFor((e) => e.session === sid && e.event === "session.snapshot", 3000, "final snapshot");
  ok("final snapshot idle", final.data.working === false);
  ok(
    "snapshot restores selected model/effort and diagnostics",
    final.data.session_usage?.input === 3 &&
      final.data.diagnostics?.model === "beta" &&
      final.data.provider === "fake-b" &&
      final.data.thinking_effort === "xhigh" &&
      final.data.model_locked === true,
  );
} catch (err) {
  ok("agentlinkd smoke completed", false, String(err));
} finally {
  server.kill("SIGTERM");
}

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
