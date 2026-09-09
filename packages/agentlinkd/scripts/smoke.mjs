// Provider-free agentlinkd conformance smoke. Spawns the real host around a
// deterministic fake dext executable; validates process/session/protocol edges.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const host = path.join(here, "..", "src", "server.mjs");
const fake = path.join(here, "fake-dext.mjs");
const cwd = path.join(process.env.HOME, "dextui-workspace");
const stateDir = path.join(cwd, `state-${process.pid}`);
const dextHome = path.join(cwd, `dext-home-${process.pid}`);
const port = 8992;
const token = "smoke-token";
const base = `http://127.0.0.1:${port}`;
const wsUrl = `ws://127.0.0.1:${port}/ws`;
fs.mkdirSync(cwd, { recursive: true, mode: 0o755 });
fs.rmSync(stateDir, { recursive: true, force: true });
fs.rmSync(dextHome, { recursive: true, force: true });

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

// Wrong-token hello on a throwaway connection; resolves with the hello_fail.
async function badHello(tok) {
  const c = connect();
  await new Promise((r) => c.ws.addEventListener("open", r));
  c.send({ v: 1, cmd: "hello", token: tok, protocol: 1 });
  const fail = await c.waitFor((e) => e.event === "hello_fail", 3000, "hello_fail");
  try {
    c.ws.close();
  } catch {}
  return fail;
}

function spawnHost() {
  return spawn(process.execPath, [host, `--port=${port}`, `--token=${token}`, `--dext=${fake}`, `--cwd=${cwd}`, `--state-dir=${stateDir}`], {
    stdio: ["ignore", "ignore", "inherit"],
    // Isolated dext state root: the todos check plants a seat-scoped session
    // dir here — the host's real ~/.dext is never touched by the smoke.
    env: { ...process.env, DEXT_HOME: dextHome },
  });
}

async function waitHealthy() {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return true;
    } catch {}
    await sleep(100);
  }
  return false;
}

const waitExit = (child) =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", resolve);
  });

let server = spawnHost();
try {
  ok("host healthy", await waitHealthy());

  const a = await openClient("A");
  ok(
    "hello advertises discovered models and effort options",
    a.hello.data.model_catalog?.length === 2 &&
      a.hello.data.model_catalog[1]?.models?.includes("beta") &&
      a.hello.data.effort_options?.includes("xhigh") &&
      a.hello.data.capabilities?.includes("model_select") &&
      a.hello.data.capabilities?.includes("effort_select") &&
      a.hello.data.capabilities?.includes("todos_read") &&
      a.hello.data.capabilities?.includes("files_read") &&
      a.hello.data.capabilities?.includes("steering"),
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
  await a.waitFor((e) => e.session === sid && e.event === "turn_start" && e.seq > end1.seq, 3000, "turn 2 start");
  // Mid-turn input: steering.inject and a bare prompt.submit both queue; the
  // host acks instantly and auto-runs them as one prompt at the boundary.
  a.send({ v: 1, cmd: "steering.inject", session: sid, text: "steer: sent while busy" });
  a.send({ v: 1, cmd: "prompt.submit", session: sid, text: "queued while busy" });
  const ackS = await a.waitFor((e) => e.session === sid && e.event === "steering_received", 3000, "steering ack");
  ok("mid-turn steering accepted and journaled", Array.isArray(ackS.data.messages) && ackS.data.preview.includes("steer:"));
  const busyDigest = JSON.parse(await (await fetch(`${base}/__agent`, { headers: { authorization: `Bearer ${token}` } })).text());
  ok(
    "digest marks prompt.submit valid while working (queues as steering)",
    busyDigest.actions.some((x) => x.cmd === "prompt.submit" && x.session === sid && /steering/.test(x.note ?? "")) &&
      busyDigest.actions.some((x) => x.cmd === "interrupt" && x.session === sid),
  );
  const end2 = await a.waitFor((e) => e.session === sid && e.event === "turn_end" && e.seq > end1.seq, 5000, "turn 2 end");
  const resumed = a.events.find((e) => e.session === sid && e.event === "text_block_complete" && e.seq < end2.seq && String(e.data).includes("two"));
  ok("second turn accepted immediately", !!end2);
  ok("second turn uses seat resume", String(resumed?.data).includes("[resumed]"));
  ok("resume keeps model and applies new effort", String(resumed?.data).includes("[fake-b/beta; effort=xhigh]"));
  // Queued messages deliver as one prompt — no stop, no manual resend.
  const autoMsg = await a.waitFor(
    (e) => e.session === sid && e.event === "user_message" && e.seq > end2.seq && String(e.data.text).includes("steer: sent while busy"),
    5000,
    "auto-delivered steering",
  );
  ok("queued input joins one next-turn prompt", autoMsg.data.text.includes("queued while busy"));
  const end3 = await a.waitFor((e) => e.session === sid && e.event === "turn_end" && e.seq > autoMsg.seq, 8000, "auto turn end");
  ok("auto-delivered turn completes without user action", end3.seq > autoMsg.seq);

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
  const tailSeq = final.data.last_seq;

  // ---------- REST surface: per-session meta, digest, todos ----------

  const H = { authorization: `Bearer ${token}` };
  const one = await (await fetch(`${base}/sessions/${sid}`, { headers: H })).json();
  ok(
    "GET /sessions/:id returns session meta",
    one.session?.id === sid && one.session?.status === "live" && one.session?.last_seq === tailSeq && one.session?.cwd === cwd,
  );
  const missing = await fetch(`${base}/sessions/sess_999`, { headers: H });
  const missingBody = await missing.json();
  ok("unknown session id -> JSON 404 no_session", missing.status === 404 && missingBody.error === "no_session");

  const digestRes = await fetch(`${base}/__agent`, { headers: H });
  const digestText = await digestRes.text();
  const digest = JSON.parse(digestText);
  ok(
    "GET /__agent digest has instance and live actions",
    typeof digest.instance === "string" &&
      digest.instance === a.hello.data.instance &&
      digest.server === "agentlinkd" &&
      Array.isArray(digest.capabilities) &&
      digest.actions.some((x) => x.cmd === "prompt.submit" && x.session === sid) &&
      digest.actions.some((x) => x.cmd === "session.close" && x.session === sid) &&
      digest.actions.some((x) => x.cmd === "session.open" && x.note === "new session") &&
      digest.sessions.some((x) => x.id === sid && x.status === "live" && x.working === false && typeof x.last_event_age_ms === "number"),
  );
  ok("__agent body capped under 4096 bytes", Buffer.byteLength(digestText) <= 4096, `${Buffer.byteLength(digestText)} bytes`);

  // Todos are seat-scoped: planted in the dext state dir whose header seat
  // matches this session. The project-level file must be IGNORED (anti-bleed).
  // The seat never rides the wire — read it from the host's persisted session
  // index inside the state dir this smoke owns.
  const indexEntries = JSON.parse(fs.readFileSync(path.join(stateDir, "sessions.json"), "utf8"));
  const seat = indexEntries.find((x) => x.id === sid)?.seat ?? "";
  const dextSessDir = path.join(dextHome, "projects", "smoke", "sessions", "1700000000-1-smoke");
  fs.mkdirSync(dextSessDir, { recursive: true });
  fs.writeFileSync(path.join(dextSessDir, "_latest.jsonl"), `${JSON.stringify({ version: 4, seat: { id: seat } })}\n`);
  const projectTodo = path.join(cwd, "DEXT.todo.json");
  fs.writeFileSync(projectTodo, JSON.stringify([{ text: "stale project item", status: "completed" }])); // must never be read
  fs.writeFileSync(
    path.join(dextSessDir, "DEXT.todo.json"),
    JSON.stringify([
      { text: "  write smoke checks  ", status: "in_progress" },
      { text: "", status: "completed" }, // dropped: empty text
      { text: "clean the state dir", status: "bogus" }, // unknown status -> pending
    ]),
  );
  let todos = await (await fetch(`${base}/sessions/${sid}/todos`, { headers: H })).json();
  ok(
    "todos read from the seat's session file, parsed like dext (project file ignored)",
    todos.session === sid &&
      todos.source === "session" &&
      todos.path === path.join(dextSessDir, "DEXT.todo.json") &&
      todos.items.length === 2 &&
      todos.items[0].text === "write smoke checks" &&
      todos.items[0].status === "in_progress" &&
      todos.items[1].text === "clean the state dir" &&
      todos.items[1].status === "pending",
  );
  fs.rmSync(path.join(dextSessDir, "DEXT.todo.json"));
  todos = await (await fetch(`${base}/sessions/${sid}/todos`, { headers: H })).json();
  ok("todos read as none once the session file is gone (no project bleed)", todos.source === "none" && todos.items.length === 0);
  fs.rmSync(projectTodo);
  fs.rmSync(dextSessDir, { recursive: true, force: true }); // later resume-target logic sees the pristine state again

  // ---------- session files: images a turn wrote, cwd-confined ----------

  const fileDir = path.join(cwd, `dextui-smoke-${process.pid}`);
  fs.mkdirSync(fileDir, { recursive: true });
  const png1x1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  fs.writeFileSync(path.join(fileDir, "chart-check.png"), png1x1);
  fs.writeFileSync(path.join(fileDir, "notes.txt"), "not an image");
  const outside = path.join(os.tmpdir(), `dextui-smoke-escape-${process.pid}.png`);
  fs.writeFileSync(outside, png1x1);
  fs.symlinkSync(outside, path.join(fileDir, "trap.png"));
  const fileRes = await fetch(
    `${base}/sessions/${sid}/file?p=${encodeURIComponent(`${path.basename(fileDir)}/chart-check.png`)}`,
    { headers: H },
  );
  ok(
    "session file serves a workspace image",
    fileRes.status === 200 &&
      fileRes.headers.get("content-type") === "image/png" &&
      Buffer.compare(Buffer.from(await fileRes.arrayBuffer()), png1x1) === 0,
  );
  const trapRes = await fetch(
    `${base}/sessions/${sid}/file?p=${encodeURIComponent(`${path.basename(fileDir)}/trap.png`)}`,
    { headers: H },
  );
  ok("symlink escape rejected", trapRes.status === 404);
  const mimeRes = await fetch(
    `${base}/sessions/${sid}/file?p=${encodeURIComponent(`${path.basename(fileDir)}/notes.txt`)}`,
    { headers: H },
  );
  ok(
    "text file served inline as text/plain",
    mimeRes.status === 200 && mimeRes.headers.get("content-type") === "text/plain; charset=utf-8",
  );
  fs.writeFileSync(path.join(fileDir, "payload.bin"), "MZ");
  const badRes = await fetch(
    `${base}/sessions/${sid}/file?p=${encodeURIComponent(`${path.basename(fileDir)}/payload.bin`)}`,
    { headers: H },
  );
  ok("non-allowlisted file type rejected", badRes.status === 404);
  const travRes = await fetch(`${base}/sessions/${sid}/file?p=${encodeURIComponent("../../../etc/passwd")}`, { headers: H });
  ok("path traversal rejected", travRes.status === 404);

  // HTML artifact tier: path-shaped URLs (so nested relative images resolve),
  // ?t= token auth for subresource loads that cannot send headers, and the
  // sandboxing CSP. Encoded traversal via the path shape is rejected too.
  fs.writeFileSync(
    path.join(fileDir, "dash.html"),
    `<!doctype html><title>dash</title><img src="chart-check.png"><p>ok</p>`,
  );
  const T = `?t=${encodeURIComponent(token)}`;
  const dashRes = await fetch(`${base}/sessions/${sid}/file/${path.basename(fileDir)}/dash.html${T}`);
  ok(
    "html artifact served via path URL with ?t auth",
    dashRes.status === 200 &&
      (dashRes.headers.get("content-type") ?? "").startsWith("text/html") &&
      (dashRes.headers.get("content-security-policy") ?? "").includes("sandbox allow-scripts"),
  );
  const nestedRes = await fetch(`${base}/sessions/${sid}/file/${path.basename(fileDir)}/chart-check.png${T}`);
  ok(
    "nested image resolves via path URL (relative to the artifact)",
    nestedRes.status === 200 && nestedRes.headers.get("content-type") === "image/png",
  );
  const noAuthRes = await fetch(`${base}/sessions/${sid}/file/${path.basename(fileDir)}/chart-check.png`);
  ok("file request with no token -> 401 and no lockout strike", noAuthRes.status === 401);
  const encTravRes = await fetch(`${base}/sessions/${sid}/file/%2e%2e%2f%2e%2e%2fetc%2fpasswd${T}`);
  ok("encoded traversal via path URL rejected", encTravRes.status === 404);
  fs.rmSync(fileDir, { recursive: true, force: true });
  fs.rmSync(outside, { force: true });

  // ---------- restart: durable journals restore the session cold ----------

  server.kill("SIGTERM");
  await waitExit(server);
  await sleep(200);
  server = spawnHost();
  ok("host healthy after restart", await waitHealthy());

  const r = await openClient("R");
  const restored = r.hello.data.sessions.find((x) => x.id === sid);
  ok(
    "restored session listed cold with same last_seq",
    r.hello.data.sessions.length === 1 && restored?.status === "cold" && restored?.last_seq === tailSeq && restored?.model === "beta",
  );
  r.send({ v: 1, cmd: "session.subscribe", id: sid, since_seq: tailSeq - 2 });
  await r.waitFor((e) => e.session === sid && e.seq === tailSeq && e.event !== "session.snapshot", 3000, "replay tail");
  const replay = r.events.filter((e) => e.session === sid && typeof e.seq === "number" && e.event !== "session.snapshot");
  ok(
    "subscribe since_seq replays exactly the last two envelopes",
    replay.length === 2 && replay[0].seq === tailSeq - 1 && replay[1].seq === tailSeq,
    replay.map((e) => e.seq).join(","),
  );
  ok("no snapshot fallback while since_seq is retained", !r.events.some((e) => e.session === sid && e.event === "session.snapshot"));

  r.send({ v: 1, cmd: "session.open", id: sid });
  const wakeStarting = await r.waitFor((e) => e.session === sid && e.event === "session.state" && e.data?.status === "starting", 3000, "wake starting");
  const wakeLive = await r.waitFor((e) => e.session === sid && e.event === "session.state" && e.data?.status === "live", 3000, "wake live");
  ok("cold session wakes starting -> live", wakeStarting.seq === tailSeq + 1 && wakeLive.seq === tailSeq + 2);

  // ---------- close -> cold, prompt auto-wakes ----------

  r.send({ v: 1, cmd: "session.close", id: sid });
  const closed = await r.waitFor((e) => e.session === sid && e.event === "session.state" && e.data?.status === "cold", 3000, "close cold");
  ok("session.close sets cold", closed.seq === tailSeq + 3);
  await sleep(400); // let a dying child (none here) finish before re-waking
  r.send({ v: 1, cmd: "prompt.submit", session: sid, text: "wake from cold" });
  const autoStarting = await r.waitFor(
    (e) => e.session === sid && e.event === "session.state" && e.data?.status === "starting" && e.seq > closed.seq,
    3000,
    "auto-wake starting",
  );
  const autoLive = await r.waitFor(
    (e) => e.session === sid && e.event === "session.state" && e.data?.status === "live" && e.seq > closed.seq,
    3000,
    "auto-wake live",
  );
  const wokenTurn = await r.waitFor(
    (e) => e.session === sid && e.event === "turn_end" && e.seq > closed.seq,
    8000,
    "post-wake turn end",
  );
  ok(
    "prompt.submit auto-wakes and completes a turn",
    autoStarting.seq < autoLive.seq && autoLive.seq < wokenTurn.seq && String(a.hello.data.instance).length > 0,
  );

  // ---------- digest cap: >4 KiB drops oldest sessions, reports sessions_omitted ----------

  const beforeCount = r.hello.data.sessions.length;
  for (let i = 0; i < 20; i++) r.send({ v: 1, cmd: "session.open" });
  const grown = await r.waitFor(
    (e) => e.event === "session.list" && e.data.sessions.length === beforeCount + 20,
    4000,
    "20 new sessions in list",
  );
  const newestId = grown.data.sessions[grown.data.sessions.length - 1].id;
  const cappedRes = await fetch(`${base}/__agent`, { headers: H });
  const cappedText = await cappedRes.text();
  const capped = JSON.parse(cappedText);
  ok(
    "digest over 4 KiB drops oldest sessions and reports sessions_omitted",
    Buffer.byteLength(cappedText) <= 4096 &&
      typeof capped.sessions_omitted === "number" &&
      capped.sessions_omitted >= 1 &&
      capped.sessions.length === beforeCount + 20 - capped.sessions_omitted &&
      !capped.sessions.some((x) => x.id === sid) &&
      capped.sessions.some((x) => x.id === newestId),
    `${Buffer.byteLength(cappedText)}B omitted=${capped.sessions_omitted}`,
  );

  // ---------- restart mid-turn: an unterminated turn is journaled as failed ----------

  server.kill("SIGTERM");
  await waitExit(server);
  const journalPath = path.join(stateDir, "journals", `${sid}.jsonl`);
  const injectedBase = JSON.parse(fs.readFileSync(journalPath, "utf8").trim().split("\n").at(-1)).seq;
  const inject = [
    { event: "user_message", data: { text: "lost prompt" } },
    { event: "turn_start" },
    { event: "text_delta", data: "half-written" },
  ].map((e, i) => JSON.stringify({ v: 1, session: sid, seq: injectedBase + 1 + i, ts: Date.now(), ...e }));
  fs.appendFileSync(journalPath, `${inject.join("\n")}\n`);
  server = spawnHost();
  ok("host healthy after mid-turn restart", await waitHealthy());
  const m = await openClient("M");
  const lostMeta = m.hello.data.sessions.find((x) => x.id === sid);
  ok(
    "unfinished turn terminated on restore (+error +turn_end)",
    lostMeta?.status === "cold" && lostMeta?.last_seq === injectedBase + 5,
    `last_seq=${lostMeta?.last_seq} expected ${injectedBase + 5}`,
  );
  m.send({ v: 1, cmd: "session.subscribe", id: sid });
  const lostSnap = await m.waitFor((e) => e.session === sid && e.event === "session.snapshot", 3000, "mid-turn snapshot");
  const [sealedText, lostMarker] = lostSnap.data.blocks.slice(-2);
  ok(
    "restored snapshot: text sealed, error marker, failed:true, not working",
    lostSnap.data.working === false &&
      lostSnap.data.failed === true &&
      sealedText?.kind === "text" &&
      sealedText?.text === "half-written" &&
      sealedText?.complete === true &&
      lostMarker?.kind === "marker" &&
      lostMarker?.level === "error",
    JSON.stringify(lostSnap.data.blocks.slice(-2)),
  );

  // ---------- auth: wrong token, then rate limiting (last: locks auth) ----------

  const wrong = await badHello("definitely-not-the-token");
  ok("wrong token -> hello_fail invalid token", wrong.data.reason === "invalid token");
  let lastFail = null;
  for (let i = 0; i < 6; i++) lastFail = await badHello("definitely-not-the-token");
  ok("rapid auth failures -> rate_limited", lastFail.data.reason === "rate_limited");
  const lockedRes = await fetch(`${base}/sessions`, { headers: H });
  ok("REST auth attempts during lockout -> 429", lockedRes.status === 429);
} catch (err) {
  ok("agentlinkd smoke completed", false, String(err));
} finally {
  server.kill("SIGTERM");
  fs.rmSync(stateDir, { recursive: true, force: true });
  // File-endpoint fixtures live outside stateDir; clear them even if a
  // mid-section throw skipped the in-try cleanup.
  fs.rmSync(path.join(cwd, `dextui-smoke-${process.pid}`), { recursive: true, force: true });
  fs.rmSync(path.join(os.tmpdir(), `dextui-smoke-escape-${process.pid}.png`), { force: true });
}

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
