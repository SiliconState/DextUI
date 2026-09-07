// Flow builder: validateFlow / topoOrder / compileFlow / confined IO.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FLOW_NAME_RE, compileFlow, deleteFlow, listFlows, readFlow, topoOrder, validateFlow, writeFlow } from "../src/flows.mjs";

const MONTH_END = {
  version: 1,
  name: "month-end-close",
  title: "Month-end close",
  desc: "Receipts → check → tell the accountant",
  nodes: [
    { id: "scan", type: "pack", label: "Scan receipts", pack: "receipts", task: "scan this folder and record new receipts", x: 80, y: 120 },
    { id: "check", type: "condition", label: "Ledger clean?", expr: "every receipt has a category and a source file", x: 320, y: 120 },
    { id: "ask", type: "gate", label: "Approve summary", question: "Reconciliation clean? Send the month-end summary to your accountant?", x: 540, y: 120 },
    { id: "note", type: "message", label: "Tell accountant", to: "accountant", text: "Month-end summary: {previous}", x: 760, y: 120 },
    { id: "narrate", type: "prompt", label: "Narrate", prompt: "Summarise the ledger in three plain sentences", agent: "worker", x: 320, y: 260 },
  ],
  edges: [["scan", "check"], ["check", "narrate"], ["narrate", "ask"], ["ask", "note"]],
};

test("validateFlow: accepts the month-end flow; canonicalises edges", () => {
  const r = validateFlow(MONTH_END);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.flow.nodes.length, 5);
  assert.equal(r.flow.edges.length, 4);
  assert.equal(r.flow.title, "Month-end close");
});

test("validateFlow: rejects the bad shapes", () => {
  const bad = (mutate) => { const v = JSON.parse(JSON.stringify(MONTH_END)); mutate(v); return validateFlow(v).error; };
  assert.equal(validateFlow(null).error, "flow must be a JSON object");
  assert.equal(validateFlow({ version: 2, name: "x", nodes: [{ id: "a", type: "gate", question: "q" }] }).error, "flow.version must be 1");
  assert.match(bad((v) => (v.name = "Bad Name")), /flow name/);
  assert.match(bad((v) => (v.nodes[0].id = "Bad-Id")), /node 0: id/);
  assert.match(bad((v) => (v.nodes[1].id = "scan")), /duplicate node id 'scan'/);
  assert.match(bad((v) => (v.nodes[0].type = "sparkly")), /unknown type/);
  assert.match(bad((v) => (v.nodes[0].pack = "")), /pack needs a valid pack name/);
  assert.match(bad((v) => (v.nodes[2].question = "")), /gate needs a question/);
  assert.match(bad((v) => (v.nodes[3].to = "bad name!")), /valid recipient/);
  assert.match(bad((v) => v.edges.push(["scan", "scan"])), /cannot feed itself/);
  assert.match(bad((v) => v.edges.push(["scan", "ghost"])), /existing node ids/);
  assert.match(bad((v) => v.edges.push(["note", "ask"])), /cycle/, "note→ask closes a loop with ask→note");
  assert.match(bad((v) => v.edges.push(["scan", "ask"])), /feeds 2 steps/, "branch refused at save — a flow is one chain");
  assert.match(bad((v) => v.edges.push(["narrate", "note"])), /is fed by 2 steps/, "join refused at save — merge into one step");
  assert.match(bad((v) => { v.nodes = []; }), /at least one node/);
});

test("topoOrder: dependencies first, declaration order as tiebreak", () => {
  const { flow } = validateFlow(MONTH_END);
  const order = topoOrder(flow);
  assert.deepEqual(order, ["scan", "check", "narrate", "ask", "note"], "one chain: narrate follows check, then ask, then note");
});

test("compileFlow: crew chain spec — packs infer, gates escalate, messages shell out to mesh", () => {
  const { flow } = validateFlow(MONTH_END);
  const spec = compileFlow(flow, { meshBin: "/home/u/.dext/shelves/orchestration/packs/mesh/bin/mesh", packs: new Set(["receipts"]) });
  assert.equal(spec.task, "Month-end close");
  assert.equal(spec.steps.length, 5);
  const [scan, check, narrate, ask, note] = spec.steps;
  assert.equal(scan.agent, "worker");
  assert.equal(scan.output, "scan.md");
  assert.match(scan.task, /^run receipts — scan this folder/, "dext pack inference shape");
  assert.match(scan.task, /\{previous\}/);
  assert.equal(check.output, "check.md");
  assert.match(check.task, /clearly true.*PASS/s);
  assert.match(check.task, /escalation\.json/);
  assert.equal(ask.output, undefined, "gates produce no deliverable");
  assert.match(ask.task, /"question": "Reconciliation clean\?/);
  assert.match(ask.task, /ESCALATION:/);
  assert.equal(narrate.agent, "worker");
  assert.match(narrate.task, /Summarise the ledger/);
  assert.match(note.task, /mesh" send accountant/);
  assert.match(note.task, /Month-end summary: \{previous\}/);
  // Every step is JSON-serializable (crew reads plain JSON).
  JSON.parse(JSON.stringify(spec));
});

test("compileFlow: unknown pack refused when a catalog is given", () => {
  const { flow } = validateFlow(MONTH_END);
  assert.throws(() => compileFlow(flow, { packs: new Set(["invoice"]) }), /unknown pack 'receipts'/);
  // Without a catalog the compiler trusts the name (runtime will report).
  assert.ok(compileFlow(flow).steps.length === 5);
});

test("flows IO: write/read/list/delete confined to <cwd>/.dext/flows", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "flows-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  assert.equal(writeFlow(cwd, { version: 1, name: "bad", nodes: [] }).error, "flow needs at least one node");
  const w = writeFlow(cwd, MONTH_END);
  assert.equal(w.ok, true, w.error);
  assert.ok(fs.existsSync(path.join(cwd, ".dext", "flows", "month-end-close.flow.json")));

  const list = listFlows(cwd);
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].name, list[0].title, list[0].nodes, list[0].edges], ["month-end-close", "Month-end close", 5, 4]);

  const r = readFlow(cwd, "month-end-close");
  assert.equal(r.ok, true);
  assert.equal(r.flow.nodes[0].pack, "receipts");
  assert.equal(readFlow(cwd, "nope").error, "no_flow");
  assert.equal(readFlow(cwd, "../etc/passwd").error, "bad_name");

  // Symlinks are refused even when they point inside the tree.
  fs.symlinkSync(path.join(cwd, ".dext", "flows", "month-end-close.flow.json"), path.join(cwd, ".dext", "flows", "link.flow.json"));
  assert.equal(readFlow(cwd, "link").error, "refused");
  assert.equal(listFlows(cwd).length, 1, "symlinked flow never listed");

  // Invalid content is reported on read and marked in listings, never thrown.
  fs.writeFileSync(path.join(cwd, ".dext", "flows", "broken.flow.json"), "{ not json");
  assert.equal(readFlow(cwd, "broken").error, "invalid_json");
  assert.equal(listFlows(cwd).length, 2);

  assert.equal(deleteFlow(cwd, "broken").ok, true);
  assert.equal(deleteFlow(cwd, "broken").error, "no_flow");
  assert.equal(deleteFlow(cwd, "link").error, "refused");
});

// ---------- host surface ----------

async function host(t, extraEnv = {}) {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const root = path.resolve("packages/agentlinkd");
  const temp = fs.mkdtempSync(path.join(root, ".flows-test-"));
  const cwd = path.join(temp, "workspace");
  fs.mkdirSync(cwd, { recursive: true });
  const token = "flows-test-pairing";
  const child = spawn(process.execPath, [path.join(root, "src/server.mjs"), "--port=0", `--token=${token}`, `--cwd=${cwd}`, `--state-dir=${path.join(temp, "state")}`, `--dext=${path.join(root, "scripts/fake-dext.mjs")}`, "--approval=auto-read"], {
    env: { ...process.env, DEXT_HOME: path.join(temp, "dext"), FAKE_PACKS_ROOT: path.join(temp, "shelves"), PATH: path.dirname(process.execPath), ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const sockets = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  t.after(async () => {
    for (const ws of sockets) try { ws.close(); } catch { /* closed */ }
    if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([exited, sleep(4000)]); }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  let base = "";
  for (;;) {
    const [chunk] = await once(child.stdout, "data");
    const m = /listening on (http:\/\/[^\s]+)/.exec(chunk.toString());
    if (m) { base = m[1]; break; }
  }
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  sockets.push(ws);
  const events = [];
  ws.addEventListener("message", (m) => events.push(JSON.parse(m.data)));
  await once(ws, "open");
  const send = (cmd, extra = {}) => ws.send(JSON.stringify({ v: 1, cmd, ...extra }));
  const wait = async (pred, from = 0) => {
    for (let i = 0; i < 400; i++) {
      const hit = events.slice(from).find(pred);
      if (hit) return hit;
      await sleep(25);
    }
    throw new Error(`timeout; last events: ${JSON.stringify(events.slice(-5))}`);
  };
  send("hello", { token });
  const hello = await wait((e) => e.event === "hello_ok");
  return { events, send, wait, hello, cwd };
}

test("host: flows capability; list/put/get/compile/delete round-trip; errors are cmd-tagged", { timeout: 30000 }, async (t) => {
  const c = await host(t);
  assert.ok(c.hello.data.capabilities.includes("flows"));

  c.send("x-agentlinkd.flows.list");
  const empty = await c.wait((e) => e.event === "x-agentlinkd.flows.list");
  assert.equal(empty.data.cwd, c.cwd);
  assert.deepEqual(empty.data.flows, []);

  let mark = c.events.length;
  c.send("x-agentlinkd.flows.put", { flow: { version: 1, name: "bad", nodes: [] } });
  const bad = await c.wait((e) => e.event === "error", mark);
  assert.equal(bad.data.code, "bad_request");
  assert.equal(bad.data.cmd, "x-agentlinkd.flows.put");
  assert.match(bad.data.message, /at least one node/);

  mark = c.events.length;
  c.send("x-agentlinkd.flows.put", { flow: MONTH_END });
  const put = await c.wait((e) => e.event === "x-agentlinkd.flows.put", mark);
  assert.equal(put.data.flow.name, "month-end-close");
  const changed = await c.wait((e) => e.event === "x-agentlinkd.flows.changed", mark);
  assert.equal(changed.data.flows.length, 1, "broadcast carries the refreshed list");
  assert.ok(fs.existsSync(path.join(c.cwd, ".dext", "flows", "month-end-close.flow.json")));

  mark = c.events.length;
  c.send("x-agentlinkd.flows.get", { name: "month-end-close" });
  const got = await c.wait((e) => e.event === "x-agentlinkd.flows.get", mark);
  assert.equal(got.data.flow.nodes.length, 5);

  mark = c.events.length;
  c.send("x-agentlinkd.flows.compile", { name: "month-end-close" });
  // The fake host's catalog has no `receipts` pack → the compiler refuses honestly.
  const noPack = await c.wait((e) => e.event === "error", mark);
  assert.equal(noPack.data.code, "no_pack");

  mark = c.events.length;
  const noPackFlow = { ...MONTH_END, name: "no-packs", nodes: MONTH_END.nodes.filter((n) => n.type !== "pack"), edges: MONTH_END.edges.filter(([a]) => a !== "scan") };
  c.send("x-agentlinkd.flows.put", { flow: noPackFlow });
  await c.wait((e) => e.event === "x-agentlinkd.flows.put", mark);
  c.send("x-agentlinkd.flows.compile", { name: "no-packs" });
  const spec = await c.wait((e) => e.event === "x-agentlinkd.flows.compile", mark);
  assert.equal(spec.data.spec.steps.length, 4);
  assert.match(spec.data.spec.steps.find((s) => s.label === "Tell accountant").task, /send accountant/);

  mark = c.events.length;
  c.send("x-agentlinkd.flows.get", { name: "nope" });
  assert.equal((await c.wait((e) => e.event === "error", mark)).data.code, "no_flow");
  c.send("x-agentlinkd.flows.list", { cwd: "/nonexistent/dir" });
  assert.equal((await c.wait((e) => e.event === "error" && e.data.cmd === "x-agentlinkd.flows.list", mark)).data.code, "bad_request");

  mark = c.events.length;
  c.send("x-agentlinkd.flows.delete", { name: "no-packs" });
  const after = await c.wait((e) => e.event === "x-agentlinkd.flows.changed", mark);
  assert.deepEqual(after.data.flows.map((f) => f.name), ["month-end-close"]);
});

test("validateFlow: caps hold (names, counts, text lengths)", () => {
  const many = { version: 1, name: "many", nodes: Array.from({ length: 65 }, (_, i) => ({ id: `n${i}`, type: "gate", question: "q" })), edges: [] };
  assert.match(validateFlow(many).error, /at most 64 nodes/);
  const long = JSON.parse(JSON.stringify(MONTH_END));
  long.nodes[2].question = "x".repeat(600);
  const r = validateFlow(long);
  assert.equal(r.ok, true);
  assert.equal(r.flow.nodes[2].question.length, 500, "clipped, not rejected");
  assert.equal(FLOW_NAME_RE.test("month-end-close"), true);
  assert.equal(FLOW_NAME_RE.test("has space"), false);
});

test("host: launch tracking — spawn accepted ≠ run succeeded; exit + stderr reported; list carries launches; nonce dedup acks", { timeout: 30000 }, async (t) => {
  // A fake crew that fails loudly: proves the launch is tracked spawn → exit.
  const crewDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-crew-"));
  t.after(() => fs.rmSync(crewDir, { recursive: true, force: true }));
  const crewBin = path.join(crewDir, "fake-crew");
  fs.writeFileSync(crewBin, "#!/bin/sh\necho 'crew: boom' >&2\nexit 3\n", { mode: 0o755 });

  const c = await host(t, { CREW_BIN: crewBin });
  assert.ok(c.hello.data.capabilities.includes("crew"), "explicit crew binary arms the capability");

  // The pack-free flow compiles without a catalog (mirrors the compile test).
  const noPacks = { ...MONTH_END, name: "no-packs", nodes: MONTH_END.nodes.filter((n) => n.type !== "pack"), edges: MONTH_END.edges.filter(([a]) => a !== "scan") };
  let mark = c.events.length;
  c.send("x-agentlinkd.flows.put", { flow: noPacks });
  await c.wait((e) => e.event === "x-agentlinkd.flows.put", mark);

  c.send("x-agentlinkd.flows.run", { name: "no-packs" });
  // Spawn accepted: the reply honestly says "starting" — the exit may still fail.
  const started = await c.wait((e) => e.event === "x-agentlinkd.flows.run" && e.data.started, mark);
  assert.equal(started.data.launch.state, "starting");
  // Process exit: failed state, exit code, and the stderr tail arrive as a broadcast.
  const failed = await c.wait((e) => e.event === "x-agentlinkd.flows.run" && e.data.launch && e.data.launch.state === "failed", mark);
  assert.equal(failed.data.failed, true);
  assert.equal(failed.data.launch.exit_code, 3);
  assert.match(failed.data.launch.error, /boom/);

  // The list carries the last launch per flow.
  mark = c.events.length;
  c.send("x-agentlinkd.flows.list");
  const list = await c.wait((e) => e.event === "x-agentlinkd.flows.list", mark);
  assert.equal(list.data.launches.length, 1);
  assert.equal(list.data.launches[0].name, "no-packs");
  assert.equal(list.data.launches[0].state, "failed");
  assert.equal(list.data.launches[0].exit_code, 3);

  // Nonce dedup: a replayed frame is acked as duplicate, never re-run.
  mark = c.events.length;
  const known = new Set((c.hello.data.sessions ?? []).map((s) => s.id));
  c.send("session.open");
  const listed = await c.wait((e) => e.event === "session.list" && e.data.sessions.some((s) => !known.has(s.id)), mark);
  const sid = listed.data.sessions.find((s) => !known.has(s.id)).id;
  mark = c.events.length;
  const nonce = "launch-test-nonce-1";
  c.send("prompt.submit", { session: sid, text: "hello", nonce });
  const ack1 = await c.wait((e) => e.event === "cmd_ack" && e.data.nonce === nonce, mark);
  assert.equal(ack1.data.ok, true);
  assert.notEqual(ack1.data.duplicate, true);
  c.send("prompt.submit", { session: sid, text: "hello", nonce });
  const ack2 = await c.wait((e) => e.event === "cmd_ack" && e.data.nonce === nonce && e.data.duplicate === true, mark);
  assert.equal(ack2.data.ok, true);
});
