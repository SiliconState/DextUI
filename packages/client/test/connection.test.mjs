// Connection lifecycle: hello auth, subscribe/resume, reconnect backoff, host
// restart detection, seq-gap quarantine. Uses a fake global WebSocket and
// node:test mock timers; no network.

import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { Connection } from "../dist/index.js";
import { envelope, journal } from "./helpers.mjs";

// ---------- fake WebSocket ----------

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.closeCalls = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    FakeWebSocket.instances.push(this);
  }

  send(frame) {
    this.sent.push(JSON.parse(frame));
  }

  close() {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
  }

  // --- test drivers ---
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }

  receive(env) {
    this.onmessage?.({ data: JSON.stringify(env) });
  }

  drop() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({});
  }

  frames(cmdName) {
    return this.sent.filter((f) => f.cmd === cmdName);
  }
}

function install(t) {
  const prevWs = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  t.after(() => {
    mock.timers.reset();
    globalThis.WebSocket = prevWs;
    FakeWebSocket.instances = [];
  });
}

const helloOk = (over = {}) => ({
  v: 1,
  ts: 1,
  event: "hello_ok",
  data: {
    capabilities: ["approvals", "steering"],
    sessions: [{ id: "s1", title: "S1", cwd: "/a", status: "warm" }],
    instance: "host-A",
    commands: [{ cmd: "/help", desc: "list host commands" }],
    ...over,
  },
});

/** Build a Connection with recording callbacks; optionally bring it live. */
function setup(t, opts = {}) {
  install(t);
  const calls = { phases: [], lists: [], gaps: [], restarts: [], events: [] };
  const conn = new Connection({
    url: "ws://test/ws",
    token: "tok_test",
    onPhase: (p, d) => calls.phases.push([p, d]),
    onSessionList: (s) => calls.lists.push(s),
    onSeqGap: (id, exp, got) => calls.gaps.push([id, exp, got]),
    onHostRestart: (i) => calls.restarts.push(i),
    onEvent: (env, store) => calls.events.push([env, store]),
    ...opts,
  });
  t.after(() => conn.close());
  return { conn, calls };
}

function goLive(conn, hello = helloOk()) {
  conn.connect();
  const ws = FakeWebSocket.instances.at(-1);
  ws.open();
  ws.receive(hello);
  return ws;
}

// ---------- tests ----------

test("(a) open → hello with token → hello_ok → live, capabilities/commands/instance captured", (t) => {
  const { conn, calls } = setup(t);
  conn.connect();
  assert.equal(conn.phase, "connecting");
  assert.equal(FakeWebSocket.instances.length, 1);
  const ws = FakeWebSocket.instances[0];
  assert.equal(ws.url, "ws://test/ws");
  ws.open();
  assert.equal(conn.phase, "authing");
  assert.equal(ws.sent.length, 1);
  assert.deepStrictEqual(ws.sent[0], { v: 1, cmd: "hello", token: "tok_test", client: "dextui", protocol: 1 });
  ws.receive(helloOk());
  assert.equal(conn.phase, "live");
  assert.deepStrictEqual(conn.capabilities, ["approvals", "steering"]);
  assert.deepStrictEqual(conn.commands, [{ cmd: "/help", desc: "list host commands" }]);
  assert.equal(conn.instance, "host-A");
  assert.equal(calls.lists.length, 1);
  assert.equal(calls.lists[0][0].id, "s1");
  assert.ok(conn.hasCap("approvals"));
});

test("(b) hello_fail → phase failed, socket closed, no reconnect scheduled", (t) => {
  const { conn, calls } = setup(t);
  conn.connect();
  const ws = FakeWebSocket.instances[0];
  ws.open();
  ws.receive({ v: 1, ts: 1, event: "hello_fail", data: { reason: "bad token" } });
  assert.equal(conn.phase, "failed");
  assert.equal(ws.closeCalls, 1);
  assert.deepStrictEqual(calls.phases.at(-1), ["failed", "bad token"]);
  // The server-side close follows; it must not downgrade "failed" or reconnect.
  ws.drop();
  assert.equal(conn.phase, "failed");
  mock.timers.tick(60_000);
  assert.equal(FakeWebSocket.instances.length, 1, "no new socket after hello_fail");
});

test("(c) subscribe sends since_seq undefined when empty, then lastSeq after events", (t) => {
  const { conn } = setup(t);
  const ws = goLive(conn);
  conn.subscribe("s1");
  assert.ok(conn.subscribed.has("s1"));
  let subs = ws.frames("session.subscribe");
  assert.equal(subs.length, 1);
  assert.equal(subs[0].id, "s1");
  assert.ok(!("since_seq" in subs[0]) || subs[0].since_seq === undefined);

  for (const env of journal(Array.from({ length: 5 }, (_, i) => ({ event: "info", data: `m${i}` })))) {
    ws.receive({ ...env, session: "s1" });
  }
  assert.equal(conn.session("s1").state.lastSeq, 5);
  conn.subscribe("s1");
  subs = ws.frames("session.subscribe");
  assert.equal(subs.length, 2);
  assert.equal(subs[1].since_seq, 5);
});

test("(d) close → reconnecting → backoff → new socket; same instance resumes by seq and keeps stores", (t) => {
  const { conn, calls } = setup(t);
  const ws1 = goLive(conn);
  conn.subscribe("s1");
  for (const env of journal([{ event: "user_message", data: { text: "hi" } }, { event: "info", data: "x" }, { event: "info", data: "y" }])) {
    ws1.receive({ ...env, session: "s1" });
  }
  const store1 = conn.session("s1");
  assert.equal(store1.state.lastSeq, 3);
  assert.equal(store1.state.blocks.length, 3);

  ws1.drop();
  assert.equal(conn.phase, "reconnecting");
  assert.equal(FakeWebSocket.instances.length, 1, "reconnect waits for backoff");
  mock.timers.tick(999);
  assert.equal(FakeWebSocket.instances.length, 1);
  mock.timers.tick(1);
  assert.equal(FakeWebSocket.instances.length, 2, "first backoff is 500ms * 2^1");
  const ws2 = FakeWebSocket.instances[1];
  ws2.open();
  assert.equal(ws2.frames("hello").length, 1);
  ws2.receive(helloOk({ instance: "host-A" }));
  assert.equal(conn.phase, "live");
  const subs = ws2.frames("session.subscribe");
  assert.deepStrictEqual(subs, [{ v: 1, cmd: "session.subscribe", id: "s1", since_seq: 3 }]);
  assert.equal(conn.session("s1"), store1, "store preserved across same-instance reconnect");
  assert.equal(store1.state.blocks.length, 3);
  assert.equal(calls.restarts.length, 0);
});

test("(e) hello_ok with a different instance → onHostRestart, sessions cleared, fresh subscribe", (t) => {
  const { conn, calls } = setup(t);
  const ws1 = goLive(conn, helloOk({ instance: "host-A" }));
  conn.subscribe("s1");
  ws1.receive({ ...envelope(0, { event: "info", data: "x" }), session: "s1" });
  const store1 = conn.session("s1");
  assert.equal(store1.state.lastSeq, 1);

  ws1.drop();
  mock.timers.tick(1000);
  const ws2 = FakeWebSocket.instances[1];
  ws2.open();
  ws2.receive(helloOk({ instance: "host-B" }));
  assert.deepStrictEqual(calls.restarts, ["host-B"]);
  assert.equal(conn.instance, "host-B");
  assert.notEqual(conn.session("s1"), store1, "sessions map was cleared");
  assert.equal(conn.session("s1").state.lastSeq, 0);
  const subs = ws2.frames("session.subscribe");
  assert.equal(subs.length, 1);
  assert.equal(subs[0].id, "s1");
  assert.equal(subs[0].since_seq, undefined);
  assert.ok(!("since_seq" in subs[0]), "fresh subscribe carries no since_seq key");
});

test("(f) legacy host (no instance) on reconnect behaves like a restart", (t) => {
  const { conn, calls } = setup(t);
  const ws1 = goLive(conn, helloOk({ instance: undefined }));
  assert.equal(conn.instance, undefined);
  assert.equal(calls.restarts.length, 0, "first hello on a legacy host is not a restart");
  conn.subscribe("s1");
  ws1.receive({ ...envelope(0, { event: "info", data: "x" }), session: "s1" });
  const store1 = conn.session("s1");

  ws1.drop();
  mock.timers.tick(1000);
  const ws2 = FakeWebSocket.instances[1];
  ws2.open();
  ws2.receive(helloOk({ instance: undefined }));
  assert.deepStrictEqual(calls.restarts, [""]);
  assert.notEqual(conn.session("s1"), store1);
  const subs = ws2.frames("session.subscribe");
  assert.equal(subs.length, 1);
  assert.ok(!("since_seq" in subs[0]));
});

test("(g) subscribed ids absent from hello_ok.sessions are dropped", (t) => {
  const { conn } = setup(t);
  const ws1 = goLive(conn);
  conn.subscribe("s1");
  conn.subscribe("gone");
  assert.deepStrictEqual([...conn.subscribed], ["s1", "gone"]);

  ws1.drop();
  mock.timers.tick(1000);
  const ws2 = FakeWebSocket.instances[1];
  ws2.open();
  ws2.receive(helloOk());
  assert.deepStrictEqual([...conn.subscribed], ["s1"]);
  const subs = ws2.frames("session.subscribe").map((f) => f.id);
  assert.deepStrictEqual(subs, ["s1"]);
});

test("(h) seq gap → onSeqGap, fresh subscribe, quarantine until snapshot", (t) => {
  const { conn, calls } = setup(t);
  const ws = goLive(conn);
  conn.subscribe("s1");
  const sent0 = ws.sent.length;
  for (const env of journal([{ event: "info", data: "1" }, { event: "info", data: "2" }, { event: "info", data: "3" }])) {
    ws.receive({ ...env, session: "s1" });
  }
  const store = conn.session("s1");
  assert.equal(store.state.lastSeq, 3);
  assert.equal(store.state.blocks.length, 3);

  ws.receive({ v: 1, session: "s1", seq: 5, ts: 5, event: "info", data: "5" });
  assert.deepStrictEqual(calls.gaps, [["s1", 4, 5]]);
  assert.equal(store.state.lastSeq, 3, "gap event not applied");
  assert.equal(store.state.blocks.length, 3);
  const resync = ws.sent.slice(sent0).filter((f) => f.cmd === "session.subscribe");
  assert.equal(resync.length, 1);
  assert.equal(resync[0].id, "s1");
  assert.ok(!("since_seq" in resync[0]), "resync subscribe has no since_seq");

  // Quarantined: even the in-order seq 4 is dropped until a snapshot arrives.
  ws.receive({ v: 1, session: "s1", seq: 4, ts: 4, event: "info", data: "4" });
  ws.receive({ v: 1, session: "s1", seq: 6, ts: 6, event: "info", data: "6" });
  assert.equal(store.state.lastSeq, 3);
  assert.equal(store.state.blocks.length, 3);
  assert.equal(calls.gaps.length, 1, "no second gap report while quarantined");

  ws.receive({
    v: 1,
    session: "s1",
    ts: 7,
    event: "session.snapshot",
    data: {
      meta: { id: "s1", title: "S1", cwd: "/a", status: "warm" },
      last_seq: 6,
      blocks: [{ kind: "marker", level: "info", text: "snap" }],
      pending_permissions: [],
    },
  });
  assert.equal(store.state.lastSeq, 6);
  assert.equal(store.state.blocks.length, 1);
  ws.receive({ v: 1, session: "s1", seq: 7, ts: 8, event: "info", data: "7" });
  assert.equal(store.state.lastSeq, 7, "events apply again after snapshot");
  assert.equal(store.state.blocks.length, 2);
});

test("(i) duplicate or old seq (<= lastSeq) is ignored", (t) => {
  const { conn, calls } = setup(t);
  const ws = goLive(conn);
  conn.subscribe("s1");
  for (const env of journal([{ event: "info", data: "1" }, { event: "info", data: "2" }])) ws.receive({ ...env, session: "s1" });
  const store = conn.session("s1");
  const blocks = store.state.blocks;
  ws.receive({ v: 1, session: "s1", seq: 2, ts: 2, event: "info", data: "dup" });
  ws.receive({ v: 1, session: "s1", seq: 1, ts: 1, event: "info", data: "old" });
  assert.equal(store.state.blocks, blocks, "no change for stale envelopes");
  assert.equal(store.state.lastSeq, 2);
  assert.equal(calls.gaps.length, 0);
  assert.equal(calls.events.length, 2, "onEvent not invoked for ignored envelopes");
});

test("(j) onEvent is invoked for each applied data envelope with its store", (t) => {
  const { conn, calls } = setup(t);
  const ws = goLive(conn);
  const envs = journal([{ event: "user_message", data: { text: "a" } }, { event: "text_delta", data: "b" }]).map((e) => ({
    ...e,
    session: "s1",
  }));
  for (const e of envs) ws.receive(e);
  assert.equal(calls.events.length, 2);
  assert.deepStrictEqual(calls.events[0][0], envs[0]);
  assert.deepStrictEqual(calls.events[1][0], envs[1]);
  assert.equal(calls.events[0][1], conn.session("s1"));
  assert.equal(calls.events[1][1], conn.session("s1"));
  // Fired after the fold: the store already reflects the envelope.
  assert.equal(calls.events[1][1].state.blocks.length, 2);
  // Control-plane envelopes never reach onEvent.
  ws.receive({ v: 1, ts: 9, event: "pong" });
  ws.receive({ v: 1, ts: 9, event: "session.list", data: { sessions: [] } });
  assert.equal(calls.events.length, 2);
  assert.equal(calls.lists.length, 2);
});

test("(k) close() cancels a pending reconnect timer", (t) => {
  const { conn } = setup(t);
  const ws1 = goLive(conn);
  ws1.drop();
  assert.equal(conn.phase, "reconnecting");
  conn.close();
  assert.equal(conn.phase, "closed");
  mock.timers.tick(60_000);
  assert.equal(FakeWebSocket.instances.length, 1, "no reconnect after close()");
});

test("(k) close() on a live socket closes it and publishes closed without reconnect", (t) => {
  const { conn } = setup(t);
  const ws = goLive(conn);
  conn.close();
  assert.equal(ws.closeCalls, 1);
  assert.equal(conn.phase, "closed");
  ws.drop();
  assert.equal(conn.phase, "closed");
  mock.timers.tick(60_000);
  assert.equal(FakeWebSocket.instances.length, 1);
});

test("(l) routing does not throw without a window global", (t) => {
  assert.equal(typeof globalThis.window, "undefined");
  const { conn } = setup(t);
  const ws = goLive(conn);
  assert.doesNotThrow(() => {
    ws.receive({ ...envelope(0, { event: "info", data: "x" }), session: "s1" });
    ws.receive({ v: 1, ts: 1, event: "error", data: { code: "x", message: "y" } });
    ws.receive({ v: 1, ts: 1, event: "x-unknown" });
  });
  assert.equal(conn.session("s1").state.blocks.length, 1);
});

test("session management commands wait for acknowledgments; removal drops tails", (t) => {
  const removed = [];
  const { conn } = setup(t, { onSessionRemoved: (id) => removed.push(id) });
  const ws = goLive(conn);
  conn.subscribe("s1");
  conn.clearSession("s1");
  conn.deleteSession("s1");
  conn.deleteSessions("cold");
  assert.deepEqual(ws.frames("session.clear"), [{ v: 1, cmd: "session.clear", id: "s1" }]);
  assert.deepEqual(ws.frames("session.delete_all"), [{ v: 1, cmd: "session.delete_all", scope: "cold" }]);
  assert.ok(conn.sessions.has("s1"), "no optimistic deletion");
  ws.receive({ v: 1, event: "session.removed", data: { id: "s1" } });
  assert.deepEqual(removed, ["s1"]);
  assert.equal(conn.sessions.has("s1"), false);
  assert.equal(conn.subscribed.has("s1"), false);
  ws.receive({ v: 1, session: "s1", seq: 99, event: "text_delta", data: "late" });
  assert.equal(conn.sessions.has("s1"), false);
});

test("clear replaces store, drops pending approvals, and subscribes without seq", (t) => {
  const cleared = [];
  const { conn } = setup(t, { onSessionCleared: (...args) => cleared.push(args) });
  const ws = goLive(conn);
  conn.subscribe("s1");
  const old = conn.session("s1");
  old.state.lastSeq = 40;
  old.state.pending.set("p", { request_id: "p" });
  ws.receive({ v: 1, event: "session.cleared", data: { id: "s1", generation: 1 } });
  assert.notEqual(conn.session("s1"), old);
  assert.equal(conn.session("s1").state.pending.size, 0);
  assert.deepEqual(ws.frames("session.subscribe").at(-1), { v: 1, cmd: "session.subscribe", id: "s1" });
  assert.deepEqual(cleared, [["s1", 1]]);
  ws.receive({ v: 1, event: "session.list", data: { sessions: [{ id: "s1", generation: 1 }] } });
  assert.equal(cleared.length, 1, "list after acknowledgment does not reset twice");
});

test("reconnect reconciles offline clears by generation and offline deletes", (t) => {
  const cleared = [], removed = [];
  const { conn } = setup(t, { onSessionCleared: (...args) => cleared.push(args), onSessionRemoved: (id) => removed.push(id) });
  const ws = goLive(conn);
  conn.subscribe("s1");
  conn.session("s1").state.lastSeq = 1;
  ws.drop();
  mock.timers.tick(1000);
  const next = FakeWebSocket.instances.at(-1);
  next.open();
  next.receive(helloOk({ sessions: [{ id: "s1", generation: 2 }] }));
  assert.deepEqual(cleared, [["s1", 2]]);
  assert.equal(conn.session("s1").state.lastSeq, 0);
  assert.ok(!("since_seq" in next.frames("session.subscribe").at(-1)));
  next.receive({ v: 1, event: "session.list", data: { sessions: [] } });
  assert.deepEqual(removed, ["s1"]);
  assert.equal(conn.sessions.size, 0);
  assert.equal(conn.subscribed.size, 0);
});

test("live ping is sent on the interval and stops after close", (t) => {
  const { conn } = setup(t);
  const ws = goLive(conn);
  assert.equal(ws.frames("ping").length, 0);
  mock.timers.tick(25_000);
  assert.equal(ws.frames("ping").length, 1);
  conn.close();
  mock.timers.tick(25_000);
  assert.equal(ws.frames("ping").length, 1);
});
