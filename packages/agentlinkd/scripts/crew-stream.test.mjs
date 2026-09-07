import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLogChunk, subscribeLog, CHUNK_BYTES } from "../src/crew-stream.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createCrewAdapter } from "../src/crew.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crew-stream-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "live.log");
  fs.writeFileSync(file, "first\n");
  return { root, file, attempt: "one" };
}
const text = (c) => Buffer.from(c.data, "base64").toString("utf8");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("log cursors replay only unseen bytes; replacement, truncation and attempts reset explicitly", (t) => {
  const source = fixture(t);
  const first = readLogChunk(source);
  assert.equal(first.reset, true);
  assert.equal(text(first), "first\n");
  fs.appendFileSync(source.file, "second\n");
  const second = readLogChunk(source, first);
  assert.equal(second.reset, false);
  assert.equal(text(second), "second\n");
  assert.equal(text(readLogChunk(source, second)), "");
  fs.renameSync(source.file, `${source.file}.1`);
  fs.writeFileSync(source.file, "rotated\n");
  const rotated = readLogChunk(source, second);
  assert.equal(rotated.reset, true);
  assert.equal(rotated.gap, true);
  assert.equal(text(rotated), "rotated\n");
  fs.writeFileSync(source.file, "x");
  assert.equal(readLogChunk(source, rotated).reset, true);
  assert.equal(readLogChunk({ ...source, attempt: "two" }, rotated).reset, true);
});

test("bounded reads, invalid cursors, binary fidelity and symlink refusal", (t) => {
  const source = fixture(t);
  fs.writeFileSync(source.file, Buffer.alloc(9 * 1024 * 1024, 0x61));
  const chunk = readLogChunk(source, { generation: "forged", offset: -10 });
  assert.equal(Buffer.from(chunk.data, "base64").length, CHUNK_BYTES);
  assert.equal(chunk.gap, true);
  assert.equal(chunk.start, 9 * 1024 * 1024 - 65536);
  fs.unlinkSync(source.file);
  fs.writeFileSync(source.file, Buffer.from([0xf0, 0x9f, 0x92, 0x96]));
  assert.deepEqual(Buffer.from(readLogChunk(source).data, "base64"), fs.readFileSync(source.file));
  fs.symlinkSync(source.file, path.join(source.root, "link"));
  assert.throws(() => readLogChunk({ file: path.join(source.root, "link"), attempt: "one" }));
});

test("subscription recovers missing logs, yields to backpressure, resumes without duplicates and closes", async (t) => {
  const source = fixture(t);
  let available = false;
  let writable = true;
  const sent = [];
  const stop = subscribeLog({ source: () => available ? source : null, writable: () => writable, send: (c) => sent.push(c), intervalMs: 20 });
  t.after(stop);
  assert.equal(sent[0].unavailable, true);
  available = true;
  await sleep(160);
  assert.equal(text(sent[1]), "first\n");
  writable = false;
  fs.appendFileSync(source.file, "waiting\n");
  await sleep(160);
  assert.equal(sent.length, 2);
  writable = true;
  await sleep(160);
  assert.equal(text(sent[2]), "waiting\n");
  await sleep(160);
  assert.equal(sent.length, 3);
  stop();
  fs.appendFileSync(source.file, "closed\n");
  await sleep(160);
  assert.equal(sent.length, 3);
});

test("dynamic sidecars appear before materialization and retain keys after reorder; paths stay confined", (t) => {
  const { root } = fixture(t);
  const id = "run-0123456789ab";
  const run = path.join(root, id);
  const dir = path.join(run, "dynamic");
  fs.mkdirSync(path.join(dir, "beta"), { recursive: true });
  fs.writeFileSync(path.join(dir, "beta", ".state"), JSON.stringify({ status: "running", started: 10, pid: 123 }));
  fs.writeFileSync(path.join(dir, "beta", "live.log"), "beta\n");
  fs.symlinkSync(root, path.join(dir, "escape"));
  const m = { runId: id, status: "running", cwd: root, chainDir: run, steps: [{ kind: "dynamic", dir, status: "running", agent: "scout", materialized: [] }] };
  const file = path.join(run, "manifest.json");
  fs.writeFileSync(file, JSON.stringify(m));
  const adapter = createCrewAdapter({ roots: [root] });
  t.after(() => adapter.close());
  const workers = adapter.detail(id).groups[0].workers;
  assert.equal(workers.length, 1);
  assert.equal(workers[0].status, "running");
  const key = workers[0].key;
  assert.deepEqual(adapter.tail(id, key).lines, ["beta"]);
  assert.equal(adapter.logSource(id, key).attempt, "10:123:");
  m.steps[0].materialized = [{ dir: path.join(dir, "alpha"), status: "pending" }, { dir: path.join(dir, "beta"), status: "completed" }];
  fs.writeFileSync(file, JSON.stringify(m));
  adapter.scan();
  assert.equal(adapter.detail(id).groups[0].workers[1].key, key);
  assert.equal(adapter.detail(id).groups[0].workers[1].status, "completed");
  assert.equal(adapter.logSource(id, "../escape"), null);
});

test("authenticated host streams selected logs, replays reconnect cursors, and unsubscribes", { timeout: 20000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crew-host-stream-"));
  const id = "run-0123456789ab";
  const runDir = path.join(root, ".crew", "runs", id);
  const workerDir = path.join(runDir, "worker");
  fs.mkdirSync(workerDir, { recursive: true });
  const file = path.join(workerDir, "live.log");
  fs.writeFileSync(file, "initial\n");
  fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify({ runId: id, status: "running", cwd: root, chainDir: runDir, steps: [{ kind: "sequential", dir: workerDir, agent: "scout", status: "running" }] }));
  const token = randomBytes(24).toString("hex");
  const host = spawn(process.execPath, ["packages/agentlinkd/src/server.mjs", "--port=0", `--token=${token}`, `--cwd=${root}`, `--state-dir=${path.join(root, "state")}`, `--dext=${path.resolve("packages/agentlinkd/scripts/fake-dext.mjs")}`, `--crew=${path.resolve("packages/agentlinkd/scripts/fake-dext.mjs")}`], { env: { ...process.env, DEXT_HOME: path.join(root, "home"), DEXT_SESSIONS_DIR: "", DEXT_LOGS_DIR: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  host.stdout.on("data", (b) => { output += b; });
  host.stderr.on("data", (b) => { errors += b; });
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    if (host.exitCode === null && host.signalCode === null) {
      const exited = once(host, "exit");
      host.kill("SIGTERM");
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 150 && !/listening on http:\/\/127\.0\.0\.1:\d+/.test(output); i++) await sleep(20);
  const url = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  assert.ok(url, errors);
  async function connect() {
    const ws = new WebSocket(url.replace("http", "ws") + "/ws");
    sockets.push(ws);
    const events = [];
    ws.addEventListener("message", (e) => events.push(JSON.parse(e.data)));
    await once(ws, "open");
    const send = (verb, data = {}) => ws.send(JSON.stringify({ v: 1, cmd: verb, ...data }));
    const wait = async (pred, from = 0) => {
      for (let i = 0; i < 150; i++) {
        const event = events.slice(from).find(pred);
        if (event) return event;
        await sleep(20);
      }
      throw new Error(`missing event: ${JSON.stringify(events.map((e) => e.event))} ${errors}`);
    };
    send("hello", { token, protocol: 1 });
    await wait((e) => e.event === "hello_ok");
    send("x-agentlinkd.crew.open", { run: id });
    await wait((e) => e.event === "x-agentlinkd.crew.run");
    return { ws, events, send, wait };
  }
  const a = await connect();
  a.send("x-agentlinkd.crew.subscribe", { run: id, worker: "0" });
  const first = (await a.wait((e) => e.event === "x-agentlinkd.crew.log" && e.data.data)).data;
  assert.equal(text(first), "initial\n");
  const at = a.events.length;
  const start = Date.now();
  fs.appendFileSync(file, "live\n");
  const next = (await a.wait((e) => e.event === "x-agentlinkd.crew.log" && e.data.data, at)).data;
  assert.equal(text(next), "live\n");
  t.diagnostic(`fixture append-to-WebSocket delivery: ${Date.now() - start} ms`);
  a.ws.close();
  fs.appendFileSync(file, "offline\n");
  const b = await connect();
  b.send("x-agentlinkd.crew.subscribe", { run: id, worker: "0", cursor: { generation: next.generation, offset: next.offset } });
  const replay = (await b.wait((e) => e.event === "x-agentlinkd.crew.log" && e.data.data)).data;
  assert.equal(text(replay), "offline\n");
  assert.equal(replay.reset, false);
  b.send("x-agentlinkd.crew.unsubscribe", { run: id });
  await sleep(80);
  const before = b.events.filter((e) => e.event === "x-agentlinkd.crew.log").length;
  fs.appendFileSync(file, "not subscribed\n");
  await sleep(350);
  assert.equal(b.events.filter((e) => e.event === "x-agentlinkd.crew.log").length, before);
});
