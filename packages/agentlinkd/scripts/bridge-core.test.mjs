// Explicit real-core gate: no fake dext, external network, or user state.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnBridge } from "../src/bridge.mjs";
import { SessionStore } from "../../client/dist/index.js";
import { fold } from "../../mock-server/src/fold.mjs";

const bin = process.env.DEXT_CORE_BIN;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("real core: retry rollback, permission, steering, interrupt, close and EOF", { timeout: 45000 }, async (t) => {
  assert.ok(bin, "set DEXT_CORE_BIN to the verified dext binary");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dext-core-bridge-"));
  const children = [];
  const requests = [];
  let mode = "retry";
  let round = 0;
  const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`;
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(200); res.end("{}"); return; }
    const parts = [];
    for await (const part of req) parts.push(part);
    requests.push(JSON.parse(Buffer.concat(parts)));
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (mode === "retry" && round++ === 0) {
      res.write(chunk({ reasoning_content: "discard this preview" }));
      setTimeout(() => res.destroy(), 100);
    } else if (mode === "retry") {
      res.end(chunk({ reasoning_content: "kept reasoning" }) + chunk({ content: "Hello café 🌍" }, "stop") + "data: [DONE]\n\n");
    } else if (mode === "permission") {
      mode = "finish";
      res.end(chunk({ tool_calls: [{ index: 0, id: "call_write", function: { name: "write_file", arguments: JSON.stringify({ path: "proof.txt", content: "approved" }) } }] }, "tool_calls") + "data: [DONE]\n\n");
    } else if (mode === "hold") {
      res.write(chunk({ reasoning_content: "waiting for interrupt" }));
    } else {
      res.end(chunk({ content: "Done." }, "stop") + "data: [DONE]\n\n");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const child of children) if (!child.exited) child.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const events = [];
  const noise = [];
  const store = new SessionStore("real");
  let seq = 0;
  const start = () => {
    const b = spawnBridge({
      bin, cwd: root,
      args: ["--input", "ndjson", "--output", "stream-json", "--no-session", "--cd", root, "--approval", "ask"],
      env: { PATH: process.env.PATH, HOME: root, DEXT_HOME: path.join(root, ".dext"), DEXT_PROVIDER: "local", DEXT_MODEL: "test-model", DEXT_BASE_URL: `http://127.0.0.1:${server.address().port}`, DEXT_NO_TUI: "1" },
      onEvent: (e) => { events.push(e); store.apply({ ...e, v: 1, session: "real", seq: ++seq, ts: Date.now() }); },
      onNoise: (line) => noise.push(line),
    });
    children.push(b);
    return b;
  };
  const wait = async (predicate, from = 0) => {
    for (let i = 0; i < 1000; i++) {
      const hit = events.slice(from).find(predicate);
      if (hit) return hit;
      await sleep(20);
    }
    assert.fail(`event timeout: ${JSON.stringify(events.slice(-12))}`);
  };
  const exit = async (b) => {
    for (let i = 0; i < 500 && !b.exited; i++) await sleep(20);
    assert.ok(b.exited, "child must close within deadline");
  };
  const b = start();
  await b.whenReady();
  assert.equal(events[0].event, "ready");
  assert.ok(b.user("Say hello in one sentence", 0));
  await wait((e) => e.event === "turn_end");
  assert.equal(events.find((e) => e.event === "input_ack").data.seq, 0);
  assert.ok(events.some((e) => e.event === "thinking_preview_discarded"));
  assert.ok(events.some((e) => e.event === "thinking_preview_committed"));
  const thinking = store.state.blocks.filter((block) => block.kind === "thinking").map((block) => block.text).join("");
  assert.equal(thinking, "kept reasoning".repeat(requests.length - 1));
  assert.ok(store.state.blocks.some((block) => block.text === "Hello café 🌍"));
  assert.equal(events.filter((e) => e.event === "thinking_preview_discarded").length, 1, "failed stream retried exactly once");
  assert.deepEqual(fold(events.map((e, i) => ({ ...e, ts: i }))).filter((block) => block.kind === "thinking").map((block) => block.text), store.state.blocks.filter((block) => block.kind === "thinking").map((block) => block.text));

  mode = "permission";
  let at = events.length;
  assert.ok(b.user("Write proof.txt with approved content"));
  const permission = await wait((e) => e.event === "permission_request", at);
  assert.equal(fs.existsSync(path.join(root, "proof.txt")), false);
  assert.ok(b.steer("Keep your final reply brief"));
  await wait((e) => e.event === "input_ack" && e.data.route === "steering_queued", at);
  for (let i = 0; i < 40; i++) assert.ok(b.steer(`Additional note ${i}`, `flood-${i}`));
  await wait((e) => e.event === "input_ack" && e.data.seq === "flood-39", at);
  assert.ok(events.slice(at).some((e) => e.event === "input_ack" && e.data.route === "invalid" && e.data.detail.includes("queue full")));
  assert.ok(b.permission(permission.data.id, "once"));
  await wait((e) => e.event === "permission_resolved" && e.data.choice === "once", at);
  await wait((e) => e.event === "turn_end", at);
  assert.equal(fs.readFileSync(path.join(root, "proof.txt"), "utf8"), "approved");
  assert.ok(events.slice(at).some((e) => e.event === "steering_received"));
  assert.ok(JSON.stringify(requests.at(-1)).includes("Keep your final reply brief"));

  mode = "hold";
  at = events.length;
  assert.ok(b.user("Wait for me"));
  await wait((e) => e.event === "thinking_delta", at);
  assert.ok(b.interrupt());
  await wait((e) => e.event === "turn_end", at);
  b.close();
  await exit(b);
  assert.deepEqual(noise, []);
  const eof = start();
  await eof.whenReady();
  eof.child.stdin.end();
  await exit(eof);
});
