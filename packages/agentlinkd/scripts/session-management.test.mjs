// Isolated, provider-free integration tests. No real operator state is used.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { seatFiles } from "../src/session-files.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.resolve("packages/agentlinkd");

async function harness(t, mock = false) {
  const temp = fs.mkdtempSync(path.join(root, ".session-test-"));
  const home = path.join(temp, "dext");
  const state = path.join(temp, "state");
  const cwd = path.join(temp, "workspace");
  fs.mkdirSync(cwd);
  let child;
  let base;
  let stderr = "";
  const sockets = [];
  async function stop() {
    for (const ws of sockets.splice(0)) ws.close();
    if (child?.exitCode === null && child?.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      await exit;
    }
  }
  t.after(async () => { await stop(); fs.rmSync(temp, { recursive: true, force: true }); });
  async function start() {
    const script = mock ? path.resolve("packages/mock-server/src/server.mjs") : path.join(root, "src/server.mjs");
    child = spawn(process.execPath, [script, "--port=0", "--token=session-test", `--cwd=${cwd}`, `--state-dir=${state}`, `--dext=${path.join(root, "scripts/fake-dext.mjs")}`], {
      env: { ...process.env, DEXT_HOME: home, DEXT_SESSIONS_DIR: "", DEXT_LOGS_DIR: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", (b) => (stderr += b));
    let stdout = "";
    child.stdout.on("data", (b) => (stdout += b));
    for (let i = 0; i < 100 && !/listening on http:\/\/127\.0\.0\.1:\d+/.test(stdout); i++) await sleep(30);
    const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
    assert.ok(match, stderr);
    base = match[1];
    assert.notEqual(base.split(":").at(-1), "0", "server logs actual ephemeral port");
  }
  async function client() {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws");
    sockets.push(ws);
    const events = [];
    ws.addEventListener("message", (e) => events.push(JSON.parse(e.data)));
    await once(ws, "open");
    const send = (cmd, payload = {}) => ws.send(JSON.stringify({ v: 1, cmd, ...payload }));
    const wait = async (pred, from = 0) => {
      for (let i = 0; i < 300; i++) {
        const hit = events.slice(from).find(pred);
        if (hit) return hit;
        await sleep(20);
      }
      throw new Error(`event timeout: ${stderr}`);
    };
    send("hello", { token: "session-test", protocol: 1 });
    const hello = await wait((e) => e.event === "hello_ok");
    return { ws, events, send, wait, hello };
  }
  const get = async (p) => {
    const r = await fetch(base + p, { headers: { Authorization: "Bearer session-test" } });
    return { status: r.status, body: await r.json() };
  };
  const request = (p, init = {}) => {
    const token = child.spawnargs.find((arg) => arg.startsWith("--token="))?.slice(8) ?? "";
    const headers = { ...(init.headers ?? {}), Authorization: token };
    return fetch(base + p, { ...init, headers });
  };
  await start();
  return { temp, home, state, cwd, client, request, get, start, stop };
}

async function open(c) {
  const before = c.events.length;
  const existing = new Set(c.events.filter((e) => e.event === "session.list").flatMap((e) => e.data.sessions.map((s) => s.id)));
  c.send("session.open");
  const list = await c.wait((e) => e.event === "session.list" && e.data.sessions.some((s) => !existing.has(s.id) && s.title === "New session"), before);
  return list.data.sessions.find((s) => !existing.has(s.id) && s.title === "New session").id;
}

test("agentlinkd: session-file headers are valid and non-PDF previews cannot crash the host", { timeout: 30000 }, async (t) => {
  const h = await harness(t);
  const c = await h.client();
  const id = await open(c);
  fs.writeFileSync(path.join(h.cwd, "notes.txt"), "plain text");
  fs.writeFileSync(path.join(h.cwd, "report.pdf"), "%PDF-1.4\n");
  fs.writeFileSync(path.join(h.cwd, "brief.docx"), "fake docx bytes");
  const text = await h.request(`/sessions/${id}/file/notes.txt`);
  assert.equal(text.status, 200);
  assert.equal(text.headers.get("content-disposition"), null, "optional header is omitted, never undefined");
  assert.equal(await text.text(), "plain text");

  const pdf = await h.request(`/sessions/${id}/file/report.pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-disposition"), "inline");
  await pdf.arrayBuffer();

  const docx = await h.request(`/sessions/${id}/file/brief.docx`);
  assert.equal(docx.status, 200);
  assert.equal(docx.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(docx.headers.get("content-disposition"), "attachment");
  await docx.arrayBuffer();

  const head = await h.request(`/sessions/${id}/file/notes.txt`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(Buffer.byteLength("plain text")));
  assert.equal(await head.text(), "");

  const health = await h.request("/health");
  assert.equal(health.status, 200, "host survives the non-PDF response");
  assert.equal((await health.json()).ok, true);
});

function seedSeat(h, id) {
  const entry = JSON.parse(fs.readFileSync(path.join(h.state, "sessions.json"))).find((s) => s.id === id);
  const project = path.join(h.home, "projects", "test-project");
  const dirs = ["old", "new"].map((n) => path.join(project, "sessions", `${id}-${n}`));
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "_latest.jsonl"), JSON.stringify({ seat: { id: entry.seat } }) + "\nsecret transcript\n");
    fs.writeFileSync(path.join(dir, "DEXT.todo.json"), "[]");
  }
  const seat = path.join(project, "seats", entry.seat);
  fs.mkdirSync(seat, { recursive: true });
  fs.writeFileSync(path.join(seat, "seat.json"), JSON.stringify({ id: entry.seat }));
  return { dirs: [...dirs, seat], seat: entry.seat };
}

for (const mock of [false, true]) test(`${mock ? "mock" : "agentlinkd"}: clear, multi-client removal, scopes and fresh context`, { timeout: 30000 }, async (t) => {
  const h = await harness(t, mock);
  const a = await h.client(), b = await h.client();
  assert.ok(a.hello.data.capabilities.includes("session_manage"));
  const id = await open(a);
  a.send("session.subscribe", { id });
  a.send("prompt.submit", { session: id, text: "hello" });
  await a.wait((e) => e.session === id && e.event === "turn_end");
  const owned = mock ? null : seedSeat(h, id);
  fs.writeFileSync(path.join(h.cwd, "keep.html"), "workspace artifact");
  const before = a.events.length;
  a.send("session.clear", { id });
  const cleared = await a.wait((e) => e.event === "session.cleared" && e.data.id === id, before);
  assert.equal(cleared.data.generation, 1);
  await b.wait((e) => e.event === "session.cleared" && e.data.id === id);
  for (const dir of owned?.dirs ?? []) assert.equal(fs.existsSync(dir), false);
  const ix = a.events.length;
  a.send("session.subscribe", { id });
  const snap = await a.wait((e) => e.event === "session.snapshot" && e.session === id, ix);
  assert.deepEqual(snap.data.blocks, []);
  assert.deepEqual(snap.data.pending_permissions, []);
  assert.equal(snap.data.model_locked, false);
  assert.equal(snap.data.working, false);
  assert.equal(snap.seq, 0);
  const next = a.events.length;
  a.send("prompt.submit", { session: id, text: "after clear" });
  await a.wait((e) => e.session === id && e.event === "turn_end", next);
  if (!mock) {
    const text = a.events.slice(next).find((e) => e.event === "text_block_complete").data;
    assert.ok(!text.includes("[resumed]"), "new seat must not resume old context");
  }
  const cold = await open(a);
  a.send("session.close", { id: cold });
  await a.wait((e) => e.event === "session.list" && e.data.sessions.some((s) => s.id === cold && s.status === "cold"));
  const invalid = a.events.length;
  a.send("session.delete_all", { scope: "typo" });
  await a.wait((e) => e.event === "error" && e.data.code === "bad_request", invalid);
  assert.ok((await h.get("/sessions")).body.sessions.some((s) => s.id === id));
  a.send("session.delete_all", { scope: "cold" });
  await a.wait((e) => e.event === "sessions.deleted" && e.data.ids.includes(cold));
  assert.ok((await h.get("/sessions")).body.sessions.some((s) => s.id === id));
  a.send("session.delete", { id });
  await b.wait((e) => e.event === "session.removed" && e.data.id === id);
  assert.equal((await h.get("/sessions")).body.sessions.some((s) => s.id === id), false);
  if (!mock) assert.equal((await h.get(`/sessions/${id}`)).status, 404);
  assert.equal(fs.readFileSync(path.join(h.cwd, "keep.html"), "utf8"), "workspace artifact");
  if (!mock) {
    assert.equal(fs.existsSync(path.join(h.state, "journals", `${id}.jsonl`)), false);
    await h.stop();
    await h.start();
    const c = await h.client();
    assert.equal(c.hello.data.sessions.length, 0, "last deletion persists an empty index");
    assert.notEqual(await open(c), id, "ids cannot be recycled after restart");
  }
});

test("running deletion stops child before purge; failures retain retryable intent", { timeout: 30000 }, async (t) => {
  const h = await harness(t);
  const a = await h.client();
  const id = await open(a);
  const owned = seedSeat(h, id);
  a.send("session.subscribe", { id });
  a.send("prompt.submit", { session: id, text: "in flight" });
  await a.wait((e) => e.event === "turn_start" && e.session === id);
  a.send("session.delete", { id });
  await a.wait((e) => e.event === "session.removed" && e.data.id === id);
  await sleep(700);
  for (const dir of owned.dirs) assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.existsSync(path.join(h.state, "journals", `${id}.jsonl`)), false);

  const retry = await open(a);
  const seeded = seedSeat(h, retry);
  const journal = path.join(h.state, "journals", `${retry}.jsonl`);
  fs.unlinkSync(journal);
  const sentinel = path.join(h.temp, "sentinel");
  fs.writeFileSync(sentinel, "keep");
  fs.symlinkSync(sentinel, journal);
  const mark = a.events.length;
  a.send("session.delete", { id: retry });
  await a.wait((e) => e.event === "error" && e.data.code === "operation_failed", mark);
  assert.equal(a.events.slice(mark).some((e) => e.event === "session.removed"), false);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");
  assert.ok(JSON.parse(fs.readFileSync(path.join(h.state, "sessions.json"))).find((s) => s.id === retry).cleanup);
  fs.unlinkSync(journal);
  await h.stop();
  await h.start();
  const c = await h.client();
  assert.equal(c.hello.data.sessions.some((s) => s.id === retry), false, "restart completes the purge intent");
  for (const dir of seeded.dirs) assert.equal(fs.existsSync(dir), false);
});

test("seat inventory isolates unrelated state and rejects linked ancestors", (t) => {
  const temp = fs.mkdtempSync(path.join(root, ".session-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const p = path.join(temp, "projects", "p");
  const dir = path.join(p, "sessions", "unrelated");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "_latest.jsonl"), '{"seat":{"id":"other"}}\n');
  assert.deepEqual(seatFiles("dextui-1234", { DEXT_HOME: temp }), { transcripts: [], records: [] });
  fs.renameSync(path.join(p, "sessions"), path.join(p, "elsewhere"));
  fs.symlinkSync(path.join(p, "elsewhere"), path.join(p, "sessions"));
  assert.throws(() => seatFiles("dextui-1234", { DEXT_HOME: temp }), /symlink/);
});

test("agentlinkd: /login — advertised, help never reveals the code, --show pairs a fresh device", { timeout: 30000 }, async (t) => {
  const h = await harness(t, false);
  const c = await h.client();
  assert.ok(c.hello.data.commands.some((x) => x?.cmd === "/login"), "advertised in hello_ok");
  const id = await open(c);
  c.send("session.subscribe", { id });
  const m1 = c.events.length;
  c.send("slash", { session: id, raw: "/login" });
  const help = await c.wait((e) => e.session === id && e.event === "slash", m1);
  assert.match(String(help.data), /access code/);
  assert.ok(!/access code: \S/.test(String(help.data)), "plain /login never prints the code");
  const m2 = c.events.length;
  c.send("slash", { session: id, raw: "/login --show" });
  const shown = await c.wait((e) => e.session === id && e.event === "structured_slash", m2);
  const code = /access code: (\S+)/.exec(String(shown.data))?.[1];
  assert.ok(code, `revealed a code: ${shown.data}`);
  // The revealed code is the real pairing credential: a fresh client signs in with it.
  const ws = new WebSocket(c.ws.url);
  const seen = [];
  ws.addEventListener("message", (e) => seen.push(JSON.parse(e.data)));
  await once(ws, "open");
  ws.send(JSON.stringify({ v: 1, cmd: "hello", token: code, protocol: 1 }));
  for (let i = 0; i < 150 && !seen.some((e) => e.event === "hello_ok"); i++) await sleep(20);
  assert.ok(seen.some((e) => e.event === "hello_ok"), "the revealed code signs a new device in");
  ws.close();
});
