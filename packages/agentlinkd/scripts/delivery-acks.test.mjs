// Delivery-ack semantics: identity + outcome together. A rejected nonce can
// never be acked ok; accepted prompt nonces survive a restart; a failing
// journal append is reported as durable:false instead of a silent "ok".
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.resolve("packages/agentlinkd");

async function harness(t) {
  const temp = fs.mkdtempSync(path.join(root, ".ack-test-"));
  const home = path.join(temp, "dext");
  const state = path.join(temp, "state");
  const cwd = path.join(temp, "workspace");
  fs.mkdirSync(cwd);
  let child;
  let base;
  let stderr = "";
  async function start() {
    child = spawn(process.execPath, [
      path.join(root, "src/server.mjs"),
      "--port=0", `--token=test-token`, `--cwd=${cwd}`, `--state-dir=${state}`,
      `--dext=${path.join(root, "scripts/fake-dext.mjs")}`,
    ], {
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
  }
  const stop = async () => {
    if (child?.exitCode === null && child?.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      await exit;
    }
  };
  t.after(async () => { await stop(); fs.rmSync(temp, { recursive: true, force: true }); });
  async function client() {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws");
    const events = [];
    ws.addEventListener("message", (e) => events.push(JSON.parse(e.data)));
    await once(ws, "open");
    const send = (o) => ws.send(JSON.stringify({ v: 1, ...o }));
    const wait = async (pred) => {
      for (let i = 0; i < 300; i++) {
        const hit = events.find(pred);
        if (hit) return hit;
        await sleep(20);
      }
      throw new Error(`event timeout: ${stderr}`);
    };
    send({ cmd: "hello", token: "test-token" });
    await wait((e) => e.event === "hello_ok");
    return { ws, events, send, wait };
  }
  const openSession = async (c) => {
    c.send({ cmd: "session.open" });
    const env = await c.wait((e) => e.event === "session.snapshot" || (e.event === "session.list" && e.data?.sessions?.length > 0));
    const id = env.session ?? env.data?.sessions?.[0]?.id;
    assert.ok(id, "session opened");
    // Journal events (user_message …) only reach subscribed clients.
    c.send({ cmd: "session.subscribe", id });
    await c.wait((e) => e.event === "session.snapshot" && e.session === id);
    return id;
  };
  await start();
  return { temp, state, cwd, client, openSession, stop, start, stderr: () => stderr };
}

test("a rejected nonce replays as the same rejection, never as ok", async (t) => {
  const h = await harness(t);
  const c = await h.client();
  const id = await h.openSession(c);
  const nonce = "rejnonce1";
  c.send({ cmd: "prompt.submit", session: id, text: "   ", nonce });
  const err1 = await c.wait((e) => e.event === "error" && e.data?.cmd === "prompt.submit");
  assert.equal(err1.data.code, "bad_request");
  // Replay the SAME nonce with valid text: the nonce identity was rejected, so
  // the replay must be refused again — not acked ok, not run.
  c.send({ cmd: "prompt.submit", session: id, text: "a real prompt", nonce });
  const err2 = await c.wait((e) => e.event === "error" && e.data?.cmd === "prompt.submit" && e.data?.duplicate);
  assert.equal(err2.data.code, "bad_request", "replay gets the same rejection");
  const acks = c.events.filter((e) => e.event === "cmd_ack" && e.data?.nonce === nonce);
  assert.equal(acks.length, 0, "no ok-ack for a rejected nonce");
  // And the session transcript never received the prompt.
  assert.equal(c.events.filter((e) => e.event === "user_message").length, 0, "no prompt journaled");
});

test("an accepted nonce replays as duplicate and runs once", async (t) => {
  const h = await harness(t);
  const c = await h.client();
  const id = await h.openSession(c);
  const nonce = "oknonce1";
  c.send({ cmd: "prompt.submit", session: id, text: "run me once", nonce });
  await c.wait((e) => e.event === "cmd_ack" && e.data?.nonce === nonce);
  await c.wait((e) => e.event === "user_message");
  c.send({ cmd: "prompt.submit", session: id, text: "run me once", nonce });
  const ack = await c.wait((e) => e.event === "cmd_ack" && e.data?.nonce === nonce && e.data?.duplicate);
  assert.equal(ack.data.ok, true);
  assert.notEqual(ack.data.durable, false);
  await sleep(300);
  assert.equal(c.events.filter((e) => e.event === "user_message").length, 1, "prompt ran exactly once");
});

test("accepted prompt nonces are restart-durable", async (t) => {
  const h = await harness(t);
  {
    const c = await h.client();
    const id = await h.openSession(c);
    const nonce = "restartnonce1";
    c.send({ cmd: "prompt.submit", session: id, text: "journal me", nonce });
    await c.wait((e) => e.event === "user_message" && e.data?.nonce === nonce);
    c.ws.close();
  }
  await h.stop();
  await h.start(); // same --state-dir: nonce state must be rebuilt from the journal
  {
    const c = await h.client();
    const hello = await c.wait((e) => e.event === "hello_ok");
    const id = hello.data.sessions[0]?.id;
    assert.ok(id, "session restored");
    c.send({ cmd: "session.subscribe", id });
    await c.wait((e) => e.event === "session.snapshot");
    c.send({ cmd: "prompt.submit", session: id, text: "journal me", nonce: "restartnonce1" });
    const ack = await c.wait((e) => e.event === "cmd_ack" && e.data?.nonce === "restartnonce1");
    assert.equal(ack.data.duplicate, true, "replay after restart is a duplicate");
    assert.equal(ack.data.ok, true);
    const msgs = c.events.filter((e) => e.event === "user_message" && e.data?.text === "journal me");
    assert.equal(msgs.length, 0, "replayed prompt did not run again (the snapshot carries the original)");
  }
});

test("journal append failure reports durable:false instead of ok", async (t) => {
  if (process.getuid?.() === 0) t.skip("chmod-based degradation is invisible to root");
  const h = await harness(t);
  const c = await h.client();
  const id = await h.openSession(c); // openSession also subscribes; the journal file exists on disk
  // Appending to an existing file needs write permission on the FILE (not the
  // directory), so make the journal itself read-only to force the failure.
  const journalFile = path.join(h.state, "journals", `${id}.jsonl`);
  assert.ok(fs.existsSync(journalFile), "journal exists before degradation");
  fs.chmodSync(journalFile, 0o400);
  t.after(() => { try { fs.chmodSync(journalFile, 0o600); } catch { /* gone */ } });
  const nonce = "degraded1";
  c.send({ cmd: "prompt.submit", session: id, text: "turn without persistence", nonce });
  const ack = await c.wait((e) => e.event === "cmd_ack" && e.data?.nonce === nonce);
  assert.equal(ack.data.ok, true, "delivery accepted");
  assert.equal(ack.data.durable, false, "but explicitly not durably saved");
  assert.match(ack.data.message ?? "", /journal/, "the ack explains the degradation");
  const live = c.events.find((e) => e.event === "user_message" && e.data?.text === "turn without persistence");
  assert.ok(live, "the live stream still carries the turn");
});
