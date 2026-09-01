// AgentLink v1 conformance smoke: exercises auth, hello, cold-start, journal
// replay, a full approval turn, an echo session, a second-client replay, the
// approval race, and the REST digest — against a freshly spawned mock host.
// Zero dependencies (Node 22+ global WebSocket).

import { spawn } from "node:child_process";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const PORT = 8991;
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const TOKEN = "smoke-token";

const results = [];
const ok = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  const ws = new WebSocket(WS);
  const c = { ws, events: [], waiters: [], closed: false, phase: "connecting" };
  ws.addEventListener("open", () => (c.phase = "open"));
  ws.addEventListener("close", () => {
    c.phase = "closed";
    c.closed = true;
  });
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    let env;
    try {
      env = JSON.parse(ev.data);
    } catch {
      return;
    }
    c.events.push(env);
    c.waiters = c.waiters.filter((w) => {
      if (w.pred(env)) {
        w.resolve(env);
        return false;
      }
      return true;
    });
  });
  c.send = (obj) => ws.send(JSON.stringify(obj));
  c.waitFor = (pred, ms = 15000, label = "event") =>
    new Promise((resolve, reject) => {
      const hit = c.events.find(pred);
      if (hit) {
        resolve(hit);
        return;
      }
      const w = { pred, resolve };
      c.waiters.push(w);
      setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
    });
  return c;
}

const isData = (env, event) => env.session && env.event === event;

async function waitHealthy() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  return false;
}

async function main() {
  const server = spawn(process.execPath, [
    path.join(here, "..", "src", "server.mjs"),
    `--port=${PORT}`,
    `--token=${TOKEN}`,
    "--approval-timeout-ms=60000",
  ]);
  server.stdout.on("data", () => {});
  server.stderr.on("data", (d) => console.error("[server]", String(d).trim()));
  try {
    ok("server healthy", await waitHealthy());

    // --- A: bad token is rejected, socket closes ---
    const bad = connect();
    await new Promise((r) => {
      if (bad.phase === "open") r();
      else bad.ws.addEventListener("open", r);
    });
    bad.send({ v: 1, cmd: "hello", token: "wrong", client: "smoke", protocol: 1 });
    const fail = await bad.waitFor((e) => e.event === "hello_fail", 5000, "hello_fail");
    ok("bad token → hello_fail", fail?.data?.reason === "invalid token");
    await sleep(150);
    ok("bad token socket closed", bad.closed);

    // --- B: good token → hello_ok with capabilities + seeded sessions ---
    const a = connect();
    await new Promise((r) => {
      if (a.phase === "open") r();
      else a.ws.addEventListener("open", r);
    });
    a.send({ v: 1, cmd: "hello", token: TOKEN, client: "smoke", protocol: 1 });
    const helloOk = await a.waitFor((e) => e.event === "hello_ok", 5000, "hello_ok");
    ok("hello_ok carries protocol 1", helloOk?.data?.protocol === 1);
    ok("hello_ok advertises approvals", helloOk?.data?.capabilities?.includes("approvals"));
    const seeded = helloOk?.data?.sessions ?? [];
    ok("two seeded sessions", seeded.length === 2, seeded.map((s) => s.id).join(","));
    const toolSession = seeded.find((s) => s.approval_flow !== undefined || s.title.includes("tool"));
    ok("tool fixture session present", !!toolSession && seeded.find((s) => s.status === "cold"));

    // --- C: wake cold session, subscribe from 0, journal replay ---
    a.send({ v: 1, cmd: "session.open", id: toolSession.id });
    await sleep(450); // let starting → land
    a.send({ v: 1, cmd: "session.subscribe", id: toolSession.id, since_seq: 0 });
    const live = await a.waitFor((e) => isData(e, "session.state") && e.data.status === "live", 5000, "session.state live");
    ok("cold wake reaches live", live?.seq > 0);
    const seqs = a.events.filter((e) => e.session === toolSession.id).map((e) => e.seq);
    ok("journal replay is gapless", seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1), `seq 1..${seqs.at(-1)}`);

    // --- D: full approval turn ---
    a.send({ v: 1, cmd: "prompt.submit", session: toolSession.id, text: "run the fixture tool" });
    await a.waitFor((e) => isData(e, "user_message"), 5000, "user_message");
    await a.waitFor((e) => isData(e, "tool_call_preview"), 5000, "tool_call_preview");
    const req = await a.waitFor((e) => isData(e, "permission.request"), 8000, "permission.request");
    ok("permission.request has tool + risk", req.data.tool === "bash" && !!req.data.risk);
    await sleep(120);
    a.send({
      v: 1,
      cmd: "permission.respond",
      session: toolSession.id,
      request_id: req.data.request_id,
      choice: "once",
    });
    const resolved = await a.waitFor((e) => isData(e, "permission.resolved"), 5000, "permission.resolved");
    ok("permission.resolved echoes choice", resolved?.data?.choice === "once");
    const result = await a.waitFor((e) => isData(e, "tool_call_result"), 8000, "tool_call_result");
    ok("approved tool result ok", result?.data?.ok === true && result.data.content.includes("fixture-tool-ok"));
    const done = await a.waitFor((e) => isData(e, "text_block_complete"), 8000, "final text");
    ok("final text is done", done?.data === "done");
    const turnEnd = await a.waitFor((e) => isData(e, "turn_end"), 8000, "turn_end");
    ok("turn_end failed=false", turnEnd?.data?.failed === false);

    const allSeq = a.events.filter((e) => e.session === toolSession.id && typeof e.seq === "number").map((e) => e.seq);
    ok("live stream gapless end-to-end", allSeq.every((s, i) => i === 0 || s === allSeq[i - 1] + 1), `through seq ${allSeq.at(-1)}`);

    // --- E: second client replays the same journal ---
    const b = connect();
    await new Promise((r) => {
      if (b.phase === "open") r();
      else b.ws.addEventListener("open", r);
    });
    b.send({ v: 1, cmd: "hello", token: TOKEN, client: "smoke-2", protocol: 1 });
    await b.waitFor((e) => e.event === "hello_ok", 5000, "hello_ok(B)");
    b.send({ v: 1, cmd: "session.subscribe", id: toolSession.id, since_seq: 0 });
    await b.waitFor((e) => isData(e, "permission.resolved"), 8000, "B replay resolved");
    // The replay crosses the socket in chunks; wait for the turn's final event,
    // then one tick, before comparing tails.
    await b.waitFor((e) => isData(e, "turn_end"), 8000, "B replay turn_end");
    await sleep(150);
    const bSeq = b.events.filter((e) => e.session === toolSession.id && typeof e.seq === "number").map((e) => e.seq);
    ok("B replay reaches same tail", bSeq.at(-1) === allSeq.at(-1), `seq ${bSeq.at(-1)}`);
    ok("B replay gapless", bSeq.every((s, i) => i === 0 || s === bSeq[i - 1] + 1));

    // --- F: approval race → already_resolved ---
    b.send({
      v: 1,
      cmd: "permission.respond",
      session: toolSession.id,
      request_id: req.data.request_id,
      choice: "deny",
    });
    const race = await b.waitFor((e) => e.event === "permission.already_resolved", 5000, "already_resolved");
    ok("late deny → already_resolved", race?.data?.request_id === req.data.request_id);

    // --- G: echo session (new session flow) ---
    a.send({ v: 1, cmd: "session.open" });
    const list = await a.waitFor(
      (e) => e.event === "session.list" && e.data.sessions.length === 3,
      5000,
      "session.list(3)",
    );
    const fresh = list.data.sessions.find((s) => !seeded.some((o) => o.id === s.id));
    ok("new session appears in list", !!fresh);
    a.send({ v: 1, cmd: "session.subscribe", id: fresh.id, since_seq: 0 });
    a.send({ v: 1, cmd: "prompt.submit", session: fresh.id, text: "hello mock" });
    const echo = await a.waitFor((e) => isData(e, "text_block_complete") && e.session === fresh.id, 8000, "echo text");
    ok("echo session answers", echo?.data?.includes("hello mock"));
    await a.waitFor((e) => isData(e, "turn_end") && e.session === fresh.id, 5000, "echo turn_end");

    // --- H: REST ---
    const unauth = await fetch(`${BASE}/__agent`);
    ok("REST requires auth", unauth.status === 401);
    const digestRes = await fetch(`${BASE}/__agent`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const digest = await digestRes.json();
    ok("__agent digest lists sessions", Array.isArray(digest.sessions) && digest.sessions.length === 3);
    ok("__agent digest bounded", digestRes.headers.get("content-length") === null || Number(digestRes.headers.get("content-length")) < 8192);

    // --- I: snapshot bootstrap for a fresh subscriber with no since_seq ---
    const c3 = connect();
    await new Promise((r) => {
      if (c3.phase === "open") r();
      else c3.ws.addEventListener("open", r);
    });
    c3.send({ v: 1, cmd: "hello", token: TOKEN, client: "smoke-3", protocol: 1 });
    await c3.waitFor((e) => e.event === "hello_ok", 5000, "hello_ok(C)");
    c3.send({ v: 1, cmd: "session.subscribe", id: toolSession.id });
    const snap = await c3.waitFor((e) => isData(e, "session.snapshot"), 5000, "snapshot");
    ok("snapshot carries blocks + last_seq", Array.isArray(snap?.data?.blocks) && snap.data.blocks.length > 0 && snap.data.last_seq > 0);
    const toolBlock = snap.data.blocks.find((bl) => bl.kind === "tool");
    ok("snapshot fold includes tool result", toolBlock?.status === "ok" && !!toolBlock?.content);
    ok("snapshot is at journal tail", snap.seq === snap.data.last_seq && snap.seq === allSeq.at(-1), `seq ${snap.seq}`);
    const resolvedMarker = snap.data.blocks.find((bl) => bl.kind === "marker" && bl.text === "bash: once");
    ok("snapshot fold includes approval resolution", !!resolvedMarker);

    // A snapshot is sent to one subscriber and must not consume a journal seq;
    // otherwise every other subscriber sees a phantom gap. The next journaled
    // event must be exactly snapshot-tail + 1.
    a.send({ v: 1, cmd: "slash", session: toolSession.id, raw: "/help" });
    const afterSnap = await a.waitFor(
      (e) => e.session === toolSession.id && e.event === "slash" && e.seq > snap.seq,
      5000,
      "post-snapshot slash",
    );
    ok("snapshot does not consume seq", afterSnap.seq === snap.seq + 1, `${snap.seq} → ${afterSnap.seq}`);

    // --- J: a subscriber joining while a turn is paused for approval receives
    // working=true and the original turn start time, so it cannot submit a
    // conflicting second prompt.
    const boundary = afterSnap.seq;
    a.send({ v: 1, cmd: "prompt.submit", session: toolSession.id, text: "run fixture again" });
    const req2 = await a.waitFor(
      (e) => e.session === toolSession.id && e.event === "permission.request" && e.seq > boundary,
      8000,
      "second permission.request",
    );
    const c4 = connect();
    await new Promise((r) => {
      if (c4.phase === "open") r();
      else c4.ws.addEventListener("open", r);
    });
    c4.send({ v: 1, cmd: "hello", token: TOKEN, client: "smoke-4", protocol: 1 });
    await c4.waitFor((e) => e.event === "hello_ok", 5000, "hello_ok(D)");
    c4.send({ v: 1, cmd: "session.subscribe", id: toolSession.id });
    const midSnap = await c4.waitFor((e) => isData(e, "session.snapshot"), 5000, "mid-turn snapshot");
    ok(
      "mid-turn snapshot preserves working state",
      midSnap.data.working === true && typeof midSnap.data.turn_started_at === "number",
    );
    ok("mid-turn snapshot stays at journal tail", midSnap.seq === midSnap.data.last_seq && midSnap.seq === req2.seq);
    a.send({ v: 1, cmd: "interrupt", session: toolSession.id });
    await a.waitFor((e) => e.session === toolSession.id && e.event === "interrupted" && e.seq > req2.seq, 5000, "cleanup interrupt");
  } catch (err) {
    ok("smoke completed without exception", false, String(err));
  } finally {
    server.kill();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main();
