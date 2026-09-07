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

test("spawnBridge: exit before ready rejects whenReady", async () => {
  const b = spawnBridge({ bin: process.execPath, args: ["-e", "process.exit(3)"], cwd: os.tmpdir(), env: process.env });
  await assert.rejects(b.whenReady(), /exited before ready/);
});
