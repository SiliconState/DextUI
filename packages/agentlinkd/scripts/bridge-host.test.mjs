// Bridge-mode integration tests: the real agentlinkd host against fake-dext
// advertising `--input ndjson` (FAKE_DEXT_NDJSON=1). Covers the persistent
// child's lifecycle: live steering + permission round-trip, warm child across
// an idle interrupt, /approval turn-boundary recycle, and queued-steering
// drain at turn_end. Default harness runs (no env) stay on the one-shot path.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.resolve("packages/agentlinkd");
const TOKEN = "testtoken";

async function harness(t) {
  const temp = fs.mkdtempSync(path.join(root, ".bridge-test-"));
  const home = path.join(temp, "dext");
  const state = path.join(temp, "state");
  const cwd = path.join(temp, "workspace");
  fs.mkdirSync(cwd);
  let child;
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
  child = spawn(process.execPath, [
    path.join(root, "src/server.mjs"),
    "--port=0",
    `--token=${TOKEN}`,
    `--cwd=${cwd}`,
    `--state-dir=${state}`,
    `--dext=${path.join(root, "scripts/fake-dext.mjs")}`,
    `--dirs-root=${temp}`,
  ], {
    env: { ...process.env, FAKE_DEXT_NDJSON: "1", DEXT_HOME: home, DEXT_SESSIONS_DIR: "", DEXT_LOGS_DIR: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (b) => (stderr += b));
  let stdout = "";
  child.stdout.on("data", (b) => (stdout += b));
  for (let i = 0; i < 100 && !/listening on http:\/\/127\.0\.0\.1:\d+/.test(stdout); i++) await sleep(30);
  const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
  assert.ok(match, stderr);
  const base = match[1];
  async function client() {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws");
    sockets.push(ws);
    const events = [];
    ws.addEventListener("message", (e) => events.push(JSON.parse(e.data)));
    await once(ws, "open");
    const send = (cmd, payload = {}) => ws.send(JSON.stringify({ v: 1, cmd, ...payload }));
    const wait = async (pred, from = 0) => {
      for (let i = 0; i < 400; i++) {
        const hit = events.slice(from).find(pred);
        if (hit) return hit;
        await sleep(20);
      }
      throw new Error(`event timeout after ${JSON.stringify(events.slice(-12).map((e) => `${e.event}:${JSON.stringify(e.data).slice(0, 60)}`))} stderr=${stderr}`);
    };
    send("hello", { token: TOKEN, protocol: 1 });
    const hello = await wait((e) => e.event === "hello_ok");
    return { ws, events, send, wait, hello };
  }
  return { temp, home, state, cwd, client, base, token: TOKEN };
}

async function open(c) {
  const before = c.events.length;
  const existing = new Set(c.events.filter((e) => e.event === "session.list").flatMap((e) => e.data.sessions.map((s) => s.id)));
  c.send("session.open");
  const list = await c.wait((e) => e.event === "session.list" && e.data.sessions.some((s) => !existing.has(s.id) && s.title === "New session"), before);
  return list.data.sessions.find((s) => !existing.has(s.id) && s.title === "New session").id;
}

test("catalog refresh discovers externally enabled Anthropic models and selects them for a worker", { timeout: 60000 }, async (t) => {
  const h = await harness(t);
  const a = await h.client();
  assert.ok(!a.hello.data.model_catalog.some((g) => g.provider === 'anthropic'));
  fs.mkdirSync(h.home, { recursive: true });
  const models = ['claude-sonnet-4-6', 'claude-opus-4-6'];
  fs.writeFileSync(path.join(h.home, 'fake-models.json'), JSON.stringify({ version: 1, providers: [
    { id: 'fake-a', models: ['alpha'] }, { id: 'anthropic', models },
  ] }));
  a.send('x-agentlinkd.auth.status');
  const refreshed = await a.wait((e) => e.event === 'x-agentlinkd.auth.status');
  assert.deepEqual(refreshed.data.model_catalog.find((g) => g.provider === 'anthropic').models, models);
  const id = await open(a);
  a.send('session.subscribe', { id });
  let at = a.events.length;
  a.send('session.configure', { id, provider: 'anthropic', model: models[0] });
  const selected = await a.wait((e) => e.session === id && e.event === 'session.configured', at);
  assert.equal(selected.data.provider, 'anthropic');
  assert.equal(selected.data.model, models[0]);
  at = a.events.length;
  a.send('prompt.submit', { session: id, text: 'test selected provider' });
  const ready = await a.wait((e) => e.session === id && e.event === 'session.configured', at);
  assert.equal(ready.data.provider, 'anthropic', 'provider reaches child environment');
  assert.equal(ready.data.model, models[0], 'model reaches child environment');
  await a.wait((e) => e.session === id && e.event === 'turn_end', at);
  const b = await h.client();
  assert.deepEqual(b.hello.data.model_catalog.find((g) => g.provider === 'anthropic').models, models);
});

test("bridge: live steering, permission round-trip, capability flags", { timeout: 60000 }, async (t) => {
  const h = await harness(t);
  const a = await h.client();
  assert.ok(a.hello.data.capabilities.includes("steering.live"), "bridge mode must advertise steering.live");
  assert.ok(a.hello.data.capabilities.includes("approvals"), "bridge mode must advertise approvals");
  assert.ok(a.hello.data.capabilities.includes("slash.compact"), "bridge mode must advertise native compaction");
  assert.ok(a.hello.data.commands.some((command) => command.cmd === "/compact"), "composer command catalog includes /compact");
  const id = await open(a);
  a.send("session.subscribe", { id });

  // Native /compact runs on the persistent child, keeps its summary collapsed
  // in projection, and sends the authoritative post-compaction CTX estimate.
  let at = a.events.length;
  a.send("slash", { session: id, raw: "/compact" });
  await a.wait((e) => e.session === id && e.event === "compact_start", at);
  const context = await a.wait((e) => e.session === id && e.event === "history_context_updated", at);
  assert.deepEqual(context.data, { chars: 4800, tokens: 1200 });
  const compacted = await a.wait((e) => e.session === id && e.event === "compact_end", at);
  assert.equal(compacted.data.before, 48);
  assert.equal(compacted.data.after, 11);
  assert.match(compacted.data.summary, /current objective/);
  at = a.events.length;
  a.send("session.subscribe", { id });
  const snapshot = await a.wait((e) => e.session === id && e.event === "session.snapshot", at);
  assert.equal(snapshot.data.context_tokens, 1200);
  assert.equal(snapshot.data.context_source, "history");
  assert.deepEqual(snapshot.data.blocks.find((block) => block.kind === "compact"), {
    kind: "compact",
    status: "complete",
    before: 48,
    after: 11,
    summary: compacted.data.summary,
    contextChars: 4800,
    contextTokens: 1200,
  });

  // Live steer: "SLOW" holds the turn open so the steer lands mid-turn.
  a.send("prompt.submit", { session: id, text: "SLOW one" });
  await a.wait((e) => e.session === id && e.event === "turn_start", at);
  a.send("steering.inject", { session: id, text: "steer mid-turn" });
  const ack = await a.wait((e) => e.session === id && e.event === "steering_received", at);
  assert.equal(ack.data.live, true, "steer during a live turn must be journaled as live");
  await a.wait((e) => e.session === id && e.event === "steering_applied", at); // core must echo the fold
  await a.wait((e) => e.session === id && e.event === "turn_end", at);

  // Permission: "APPROVE" blocks the turn until an answer arrives.
  at = a.events.length;
  a.send("prompt.submit", { session: id, text: "APPROVE write" });
  const req = await a.wait((e) => e.session === id && e.event === "permission.request", at);
  assert.equal(req.data.request_id, "perm-1");

  // Global discovery parity: while blocked, the session.list count and the
  // /__agent digest both surface the pending approval (id, tool, bounded
  // summary) plus the exact machine-form answer — no journal subscribe needed.
  const blocked = await a.wait((e) => e.event === "session.list" && e.data.sessions.some((s) => s.id === id && s.pending_permissions === 1), at);
  assert.ok(blocked, "session.list must report pending_permissions while an approval blocks the turn");
  const getDigest = async () => JSON.parse(await (await fetch(`${h.base}/__agent`, { headers: { authorization: `Bearer ${h.token}` } })).text());
  const digest = await getDigest();
  const ds = digest.sessions.find((s) => s.id === id);
  assert.equal(ds.pending.length, 1, JSON.stringify(ds));
  assert.equal(ds.pending[0].request_id, "perm-1");
  assert.equal(ds.pending[0].tool, "write_file");
  assert.equal(ds.pending[0].input, undefined, "tool input stays off the digest surface");
  const act = digest.actions.find((x) => x.cmd === "permission.respond" && x.session === id);
  assert.equal(act?.request_id, "perm-1", "digest offers the answering command");

  a.send("permission.respond", { session: id, request_id: "perm-1", choice: "allow" });
  const res = await a.wait((e) => e.session === id && e.event === "permission.resolved", at);
  assert.equal(res.data.choice, "once");
  assert.ok(res.data.by && res.data.by !== "timeout" && res.data.by !== "core", `by must name the answering client, got '${res.data.by}'`);
  await a.wait((e) => e.session === id && e.event === "turn_end", at);

  // Resolved: every discovery surface clears again.
  await a.wait((e) => e.event === "session.list" && e.data.sessions.some((s) => s.id === id && s.pending_permissions === 0), at);
  const digestAfter = await getDigest();
  assert.equal(digestAfter.sessions.find((s) => s.id === id).pending.length, 0);
  assert.equal(digestAfter.actions.some((x) => x.cmd === "permission.respond" && x.session === id), false);

  // Sensitive image read: core emits an ordinary permission request, and the
  // host labels the pixel disclosure without changing the bridge payload.
  at = a.events.length;
  a.send("prompt.submit", { session: id, text: "IMAGE_APPROVE uploads/shot.png" });
  const imageReq = await a.wait((e) => e.session === id && e.event === "permission.request", at);
  assert.equal(imageReq.data.request_id, "image-perm-1");
  assert.equal(imageReq.data.tool, "read_image");
  assert.equal(imageReq.data.risk, "sensitive read");
  assert.deepEqual(imageReq.data.input, { path: "uploads/shot.png" });
  a.send("permission.respond", { session: id, request_id: imageReq.data.request_id, choice: "once" });
  const imageResult = await a.wait((e) => e.session === id && e.event === "tool_call_result" && e.data.name === "read_image", at);
  assert.equal(imageResult.data.ok, true);
  assert.match(imageResult.data.content, /pixels are available to the model only in this turn/);
  await a.wait((e) => e.session === id && e.event === "turn_end", at);
});

test("bridge: browser disconnect does not interrupt the active turn or recycle its child", { timeout: 30000 }, async (t) => {
  const h = await harness(t);
  const a = await h.client();
  const id = await open(a);
  a.send("session.subscribe", { id });
  const at = a.events.length;
  a.send("prompt.submit", { session: id, text: "SLOW survives refresh" });
  const started = await a.wait((e) => e.session === id && e.event === "turn_start", at);
  const pid = started.data.pid;

  // A page refresh closes this WebSocket. The host owns the child and turn, so
  // client loss must only remove the subscription — never send interrupt/close.
  const closed = once(a.ws, "close");
  a.ws.close();
  await closed;
  await sleep(700); // fake dext completes the 500 ms turn with no subscribers

  const b = await h.client();
  const mark = b.events.length;
  b.send("session.subscribe", { id });
  const snapshot = await b.wait((e) => e.session === id && e.event === "session.snapshot", mark);
  assert.equal(snapshot.data.working, false, "the in-flight turn completed while the page was disconnected");
  assert.ok(snapshot.data.blocks.some((block) => block.kind === "text" && /fake SLOW survives refresh/.test(block.text)), "reconnect snapshot carries the completed turn");

  const next = b.events.length;
  b.send("prompt.submit", { session: id, text: "after refresh" });
  const restarted = await b.wait((e) => e.session === id && e.event === "turn_start", next);
  assert.equal(restarted.data.pid, pid, "browser reconnect reuses the same persistent dext child");
  await b.wait((e) => e.session === id && e.event === "turn_end", next);
});

test("bridge: warm child across idle interrupt, /approval recycle, queued-steer drain", { timeout: 60000 }, async (t) => {
  const h = await harness(t);
  const a = await h.client();
  const id = await open(a);
  a.send("session.subscribe", { id });

  const pidOf = async (from) => (await a.wait((e) => e.session === id && e.event === "turn_start", from)).data.pid;
  let at = a.events.length;
  a.send("prompt.submit", { session: id, text: "one" });
  const pid1 = await pidOf(at);
  await a.wait((e) => e.session === id && e.event === "turn_end", at);

  // Idle interrupt with an empty queue must keep the warm child.
  a.send("interrupt", { session: id });
  await sleep(300);
  at = a.events.length;
  a.send("prompt.submit", { session: id, text: "two" });
  assert.equal(await pidOf(at), pid1, "idle interrupt must not kill the persistent child");
  await a.wait((e) => e.session === id && e.event === "turn_end", at);

  // /approval while idle recycles the child: new spawn carries the new argv.
  at = a.events.length;
  a.send("slash", { session: id, raw: "/approval ask" });
  await a.wait((e) => e.session === id && e.event === "slash", at);
  at = a.events.length;
  a.send("prompt.submit", { session: id, text: "three" });
  assert.notEqual(await pidOf(at), pid1, "/approval change must recycle the child");
  await a.wait((e) => e.session === id && e.event === "turn_end", at);
  assert.ok(!a.events.slice(at).some((e) => e.session === id && e.event === "error"), "the retired child's exit must not surface as a turn failure");

  // Folder change: refused mid-turn (tool calls resolve against the cwd);
  // between turns it recycles the child so the next turn runs from the new
  // folder with the seat's history intact.
  const elsewhere = path.join(h.temp, "elsewhere");
  fs.mkdirSync(elsewhere);
  at = a.events.length;
  a.send("prompt.submit", { session: id, text: "SLOW" });
  const pid3 = await pidOf(at);
  a.send("session.configure", { id, cwd: elsewhere });
  const busy = await a.wait((e) => e.event === "error", at);
  assert.equal(busy.data.code, "busy");
  a.send("interrupt", { session: id });
  await a.wait((e) => e.session === id && e.event === "turn_end", at);
  at = a.events.length;
  a.send("session.configure", { id, cwd: elsewhere });
  assert.equal((await a.wait((e) => e.session === id && e.event === "session.configured", at)).data.cwd, elsewhere);
  // dext's seat records are project-scoped, so the host must resume the seat's
  // session by explicit path (found by its header, whatever project it is in).
  const seat = JSON.parse(fs.readFileSync(path.join(h.state, "sessions.json"), "utf8")).find((e) => e.id === id).seat;
  assert.ok(seat, "session index carries the seat");
  const seatDir = path.join(h.home, "projects", "old-project-0000", "sessions", "1700000000-1-abc");
  fs.mkdirSync(seatDir, { recursive: true });
  fs.writeFileSync(path.join(seatDir, "_latest.jsonl"), `${JSON.stringify({ version: 4, seat: { id: seat } })}\n`);
  at = a.events.length;
  a.send("prompt.submit", { session: id, text: "four" });
  const start4 = await a.wait((e) => e.session === id && e.event === "turn_start", at);
  assert.notEqual(start4.data.pid, pid3, "folder change must recycle the child");
  assert.equal(start4.data.resume, seatDir, "after a move, --resume names the seat's session explicitly");
  await a.wait((e) => e.session === id && e.event === "turn_end", at);
  assert.ok(!a.events.slice(at).some((e) => e.session === id && e.event === "error"), "recycle for a folder change must not surface as a turn failure");

  // Queued steering (child still spawning) drains at turn_end as its own turn.
  const id2 = await open(a);
  a.send("session.subscribe", { id: id2 });
  at = a.events.length;
  a.send("prompt.submit", { session: id2, text: "four" });
  a.send("steering.inject", { session: id2, text: "queued while spawning" });
  await a.wait((e) => e.session === id2 && e.event === "user_message" && e.data.text === "queued while spawning", at);
  const second = await a.wait((e) => e.session === id2 && e.event === "turn_end", a.events.length - 1);
  assert.equal(second.data.failed, false, "drained turn must run to completion");
  await sleep(400); // no further auto-turns: the queue is empty now
  const ends = a.events.filter((e) => e.session === id2 && e.event === "turn_end").length;
  assert.equal(ends, 2, "exactly prompt turn + drained steer turn");
});
