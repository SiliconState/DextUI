// Isolated containment tests: a malformed WS upgrade, aggregate message limits,
// the authentication deadline, and the connection cap. No real operator state.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { FrameParser } from "../../mock-server/src/ws.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.resolve("packages/agentlinkd");

async function harness(t, env = {}) {
  const temp = fs.mkdtempSync(path.join(root, ".ws-test-"));
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
      env: { ...process.env, DEXT_HOME: home, DEXT_SESSIONS_DIR: "", DEXT_LOGS_DIR: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", (b) => (stderr += b));
    let stdout = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.on("exit", (code, sig) => (exited = { code, sig }));
    for (let i = 0; i < 100 && !/listening on http:\/\/127\.0\.0\.1:\d+/.test(stdout); i++) {
      if (exited) break;
      await sleep(30);
    }
    const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
    assert.ok(match, `host failed to start: ${stderr}`);
    base = match[1];
  }
  let exited = null;
  const alive = () => child.exitCode === null && child.signalCode === null;
  t.after(async () => {
    if (alive()) { child.kill("SIGTERM"); await once(child, "exit"); }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  await start();
  return { base, temp, alive, exited: () => exited };
}

function rawUpgrade(base, target) {
  return new Promise((resolve) => {
    const s = net.connect(Number(base.split(":").at(-1)), "127.0.0.1", () => {
      s.write(
        `GET ${target} HTTP/1.1\r\nHost: a\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString("latin1");
      if (buf.includes("\r\n\r\n")) { s.destroy(); resolve(buf); }
    });
    s.on("error", () => resolve(buf));
    setTimeout(() => { s.destroy(); resolve(buf); }, 2000);
  });
}

test("malformed upgrade target cannot crash the host", async (t) => {
  const h = await harness(t);
  const resp = await rawUpgrade(h.base, "//["); // new URL("//[", base) throws Invalid URL
  assert.match(resp, /^HTTP\/1\.1 400 Bad Request/, `socket rejected, not the process: ${JSON.stringify(resp.slice(0, 60))}`);
  await sleep(150);
  assert.ok(h.alive(), "host must survive the malformed upgrade");
  // The control plane still serves after the bad request.
  const r = await fetch(`${h.base}/`, { headers: { Authorization: "test-token" } });
  assert.ok(r.status === 200 || r.status === 404, "host still answers HTTP after malformed upgrade");
});

test("a complete garbage upgrade line is rejected without a crash", async (t) => {
  const h = await harness(t);
  const resp = await rawUpgrade(h.base, "http://example.com\\");
  assert.ok(h.alive(), "host must survive");
  assert.ok(resp.startsWith("HTTP/1.1 4") || resp === "", `bad upgrade answered: ${JSON.stringify(resp.slice(0, 40))}`);
});

test("FrameParser bounds fragmented messages, not just single frames", () => {
  const closed = [];
  let messages = 0;
  const parser = new FrameParser({
    maxMessage: 1024 * 1024,
    onMessage: () => messages++,
    onClose: (payload) => closed.push(payload),
  });
  const mask = Buffer.from([1, 2, 3, 4]);
  const chunk = Buffer.alloc(256 * 1024); // 1 MiB budget exhausted after 4 fragments
  const frame = (fin, opcode, payload) => {
    let header;
    if (payload.length < 126) {
      header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = (fin ? 0x80 : 0) | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = (fin ? 0x80 : 0) | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    return Buffer.concat([header, mask, masked]);
  };
  parser.push(frame(false, 0x1, chunk)); // first text fragment
  parser.push(frame(false, 0x0, chunk));
  parser.push(frame(false, 0x0, chunk));
  parser.push(frame(false, 0x0, chunk));
  parser.push(frame(false, 0x0, chunk)); // 5 * 256 KiB = 1.25 MiB > 1 MiB
  assert.equal(closed.length, 1, "connection closed on aggregate overflow");
  assert.deepEqual([...closed[0]], [0x03, 0xf1], "close code 1009");
  assert.equal(messages, 0);
  assert.ok(parser.fragmentBytes <= 1024 * 1024, "aggregate retained memory is bounded");
});

test("FrameParser closes on a single oversized complete message", () => {
  const closed = [];
  const parser = new FrameParser({ maxMessage: 1024, onMessage: () => assert.fail("no message"), onClose: (p) => closed.push(p) });
  const mask = Buffer.from([9, 9, 9, 9]);
  const payload = Buffer.alloc(2048);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  const frame = Buffer.concat([Buffer.from([0x81, 0x80 | 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(2048); return b; })(), mask, masked]);
  parser.push(frame);
  assert.deepEqual([...closed[0]], [0x03, 0xf1]);
});

test("upgraded sockets must authenticate within the deadline", async (t) => {
  const h = await harness(t, { AGENTLINKD_WS_AUTH_DEADLINE_MS: "400" });
  const ws = new WebSocket(h.base.replace("http", "ws") + "/ws");
  await once(ws, "open");
  const closeEvent = await Promise.race([
    once(ws, "close").then(([e]) => e),
    sleep(4000).then(() => null),
  ]);
  assert.ok(closeEvent, "socket closed");
  assert.equal(closeEvent.code, 4001, "unauthenticated socket closed with 4001");
  assert.ok(h.alive(), "host survives the deadline close");
});

test("connection cap refuses excess upgrades", async (t) => {
  const h = await harness(t, { AGENTLINKD_WS_MAX_CLIENTS: "2" });
  const port = Number(h.base.split(":").at(-1));
  const openRaw = () => new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => {
      s.write("GET /ws HTTP/1.1\r\nHost: a\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
    });
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString("latin1");
      if (buf.includes("\r\n\r\n")) { s.destroy(); resolve(buf.split("\r\n")[0]); }
    });
    s.on("error", () => resolve(buf.split("\r\n")[0] || "error"));
    setTimeout(() => { s.destroy(); resolve(buf.split("\r\n")[0] || "timeout"); }, 2000);
  });
  const a = await openRaw();
  const b = await openRaw();
  const c = await openRaw();
  assert.match(a, /101/);
  assert.match(b, /101/);
  assert.match(c, /503/, "third concurrent unauthenticated socket refused");
  assert.ok(h.alive());
});
