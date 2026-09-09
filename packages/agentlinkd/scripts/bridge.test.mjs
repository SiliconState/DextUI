// bridge.mjs unit test: drives spawnBridge against a tiny fake ndjson dext
// (node script) — ready event, frame routing, permission round-trip, close.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bridgeArgs, probeNdjsonSupport, spawnBridge, toBridgeChoice, toPermissionRequest } from "../src/bridge.mjs";

const FAKE = `
const lines = [];
let buf = "";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ event: "ready", data: { input: "ndjson", session_id: "sid-1", model: "m", provider: "p" } });
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const f = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    out({ event: "input_ack", data: { type: f.type, route: f.type === "user" ? "submitted" : f.type, seq: f.seq ?? null } });
    if (f.type === "user") {
      out({ event: "turn_start" });
      out({ event: "permission_request", data: { id: "perm-1", tool: "write_file", input: { path: "x" }, summary: "{}" } });
    }
    if (f.type === "permission") {
      out({ event: "permission_resolved", data: { id: f.id, tool: "write_file", choice: f.choice } });
      out({ event: "text_block_complete", data: "done " + f.choice });
      out({ event: "turn_end", data: { usage: {}, failed: false } });
    }
    if (f.type === "close") process.exit(0);
  }
});
process.stdin.on("end", () => process.exit(0));
`;

function fakeBin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dextui-bridge-"));
  const file = path.join(dir, "fake.mjs");
  fs.writeFileSync(file, FAKE);
  return file;
}

test("bridgeArgs: ndjson + stream-json, --resume only with history, explicit path after a folder change", () => {
  const a = bridgeArgs({ cwd: "/w", approval: "ask", effort: "low", seat: "s1", resume: false });
  assert.deepEqual(a.slice(0, 4), ["--input", "ndjson", "--output", "stream-json"]);
  assert.ok(!a.some((x) => x.startsWith("--resume")));
  assert.ok(bridgeArgs({ cwd: "/w", approval: "ask", effort: "low", seat: "s1", resume: true }).includes("--resume"));
  const moved = bridgeArgs({ cwd: "/w2", approval: "ask", effort: "low", seat: "s1", resume: "/state/sessions/abc" });
  assert.ok(moved.includes("--resume=/state/sessions/abc"), "a string resume names the session explicitly (seat records are project-scoped)");
  assert.ok(!moved.includes("--resume"), "never both forms");
});

test("probeNdjsonSupport keys off `--input ndjson` in --help", () => {
  assert.equal(probeNdjsonSupport(() => "usage: dext --input ndjson host protocol"), true);
  assert.equal(probeNdjsonSupport(() => "usage: dext -p"), false);
  assert.equal(probeNdjsonSupport(() => ""), false);
});

test("choice + permission mapping", () => {
  assert.equal(toBridgeChoice("allow"), "once");
  assert.equal(toBridgeChoice("allow_always"), "always");
  assert.equal(toBridgeChoice("deny"), "deny");
  assert.equal(toBridgeChoice("maybe"), null);
  assert.deepEqual(toPermissionRequest({ id: 7, tool: "bash", summary: "s", input: { a: 1 } }), { request_id: "7", tool: "bash", summary: "s", input: { a: 1 } });
  assert.deepEqual(
    toPermissionRequest({ id: "img-1", tool: "read_image", summary: "{\"path\":\"uploads/shot.png\"}", input: { path: "uploads/shot.png" } }),
    { request_id: "img-1", tool: "read_image", summary: "{\"path\":\"uploads/shot.png\"}", input: { path: "uploads/shot.png" }, risk: "sensitive read" },
  );
});

test("spawnBridge: ready, frames, permission round-trip, close", async () => {
  const events = [];
  let exit = null;
  const b = spawnBridge({
    bin: process.execPath,
    args: [fakeBin()],
    cwd: os.tmpdir(),
    env: process.env,
    onEvent: (v) => events.push(v),
    onExit: (code) => { exit = code; },
  });
  const ready = await b.whenReady();
  assert.equal(ready.session_id, "sid-1");
  assert.ok(b.user("hello", 1));
  const wait = (pred, ms = 3000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const hit = events.find(pred);
      if (hit) { clearInterval(iv); res(hit); } else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error("timeout")); }
    }, 20);
  });
  const req = await wait((e) => e.event === "permission_request");
  assert.equal(req.data.id, "perm-1");
  assert.ok(b.permission("perm-1", "once"));
  const resolved = await wait((e) => e.event === "permission_resolved");
  assert.equal(resolved.data.choice, "once");
  await wait((e) => e.event === "turn_end");
  const acks = events.filter((e) => e.event === "input_ack").map((e) => e.data.type);
  assert.deepEqual(acks, ["user", "permission"]);
  b.close();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(b.exited, true);
  assert.equal(exit, 0);
  assert.equal(b.user("late"), false);
});

test("spawnBridge: split UTF-8, many bounded lines in one chunk, and oversized line", { timeout: 5000 }, async (t) => {
  const events = [];
  const b = spawnBridge({ bin: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], maxBuffer: 64, onEvent: (e) => events.push(e) });
  t.after(() => b.kill("SIGKILL"));
  // Inject transport chunks deterministically: pipe chunk boundaries are otherwise OS-dependent.
  const line = Buffer.from(JSON.stringify({ event: "text_delta", data: "café 🌍" }) + "\n");
  const split = line.indexOf(Buffer.from("🌍")) + 2;
  b.child.stdout.emit("data", line.subarray(0, split));
  b.child.stdout.emit("data", line.subarray(split));
  assert.equal(events[0].data, "café 🌍");
  b.child.stdout.emit("data", Buffer.from('{"event":"ready"}\n'.repeat(20)));
  assert.equal(events.length, 21, "limit applies per line, not per chunk");
  b.child.stdout.emit("data", Buffer.from("x".repeat(65)));
  await new Promise((resolve) => b.child.once("close", resolve));
  assert.equal(b.exited, true);
});

test("spawnBridge: bounded writes refuse before enqueue, preserve seq=0", { timeout: 5000 }, async (t) => {
  const b = spawnBridge({ bin: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], maxInputBuffer: 128 });
  t.after(() => b.kill("SIGKILL"));
  const frames = [];
  const original = b.child.stdin.write;
  b.child.stdin.write = (line) => { frames.push(JSON.parse(line)); return false; };
  assert.equal(b.user("hello", 0), true, "Node false means accepted, not rejected");
  assert.equal(frames[0].seq, 0);
  assert.equal(b.user("é".repeat(128)), false);
  assert.equal(frames.length, 1);
  b.child.stdin.write = original;
  Object.defineProperty(b.child.stdin, "writableLength", { value: 128 });
  assert.equal(b.user("hello"), false);
});

test("spawnBridge: exit before ready rejects whenReady", async () => {
  const b = spawnBridge({ bin: process.execPath, args: ["-e", "process.exit(3)"], cwd: os.tmpdir(), env: process.env });
  await assert.rejects(b.whenReady(), /exited before ready/);
});
