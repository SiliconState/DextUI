// SessionStore identity/immutability contract (see the header comment in
// packages/client/src/session.ts) plus the non-block state fields.

import { test } from "node:test";
import assert from "node:assert/strict";

import { SessionStore } from "../dist/index.js";
import { applyAll, envelope, journal, stripIds } from "./helpers.mjs";

const TOOL = { call_id: "call_1", name: "bash", summary: "ls" };

function seeded() {
  // user, tool card, open text — three blocks with distinct ids.
  return applyAll(
    new SessionStore("sess_t"),
    journal([
      { event: "user_message", data: { text: "hi" } },
      { event: "tool_call_start", data: TOOL },
      { event: "text_delta", data: "hel" },
    ]),
  );
}

test("text_delta replaces blocks array and only the changed block object (same id)", () => {
  const store = seeded();
  const before = store.state.blocks;
  const [u0, t0, x0] = before;
  store.apply(envelope(3, { event: "text_delta", data: "lo" }));
  const after = store.state.blocks;
  assert.notEqual(after, before, "blocks must be a new array");
  assert.equal(after.length, 3);
  assert.equal(after[0], u0, "untouched block keeps reference identity");
  assert.equal(after[1], t0, "untouched block keeps reference identity");
  assert.notEqual(after[2], x0, "changed block is a new object");
  assert.equal(after[2].id, x0.id, "changed block keeps its id");
  assert.equal(after[2].text, "hello");
  assert.equal(x0.text, "hel", "old block object is not mutated");
});

test("tool_output_delta replaces only the tool card, keeping neighbours by reference", () => {
  const store = seeded();
  const [u0, t0, x0] = store.state.blocks;
  store.apply(envelope(3, { event: "tool_output_delta", data: { call_id: "call_1", text: "out" } }));
  const [u1, t1, x1] = store.state.blocks;
  assert.equal(u1, u0);
  assert.equal(x1, x0);
  assert.notEqual(t1, t0);
  assert.equal(t1.id, t0.id);
  assert.equal(t1.output_tail, "out");
  assert.equal(t0.output_tail, undefined);
});

test("block ids are strictly increasing across pushes", () => {
  const store = applyAll(
    new SessionStore("sess_t"),
    journal([
      { event: "user_message", data: { text: "a" } },
      { event: "text_delta", data: "b" },
      { event: "text_block_complete", data: "b" },
      { event: "info", data: "c" },
      { event: "tool_call_preview", data: TOOL },
    ]),
  );
  const ids = store.state.blocks.map((b) => b.id);
  assert.equal(ids.length, 4);
  for (let i = 1; i < ids.length; i++) assert.ok(ids[i] > ids[i - 1], `ids[${i}] > ids[${i - 1}]`);
});

test("sealOpenBlocks keeps complete blocks by reference and replaces only open ones", () => {
  const store = seeded();
  const [u0, t0, x0] = store.state.blocks;
  store.apply(envelope(3, { event: "turn_end", data: { failed: false } }));
  const [u1, t1, x1] = store.state.blocks;
  assert.equal(u1, u0);
  assert.equal(t1, t0);
  assert.notEqual(x1, x0);
  assert.equal(x1.id, x0.id);
  assert.equal(x1.complete, true);
});

test("session.snapshot re-stamps ids and rebuilds toolIndex", () => {
  const store = seeded();
  const oldIds = store.state.blocks.map((b) => b.id);
  const snapshot = {
    meta: { id: "sess_t", title: "T", cwd: "/w", status: "warm" },
    last_seq: 42,
    blocks: [
      { kind: "user", text: "x" },
      { kind: "tool", call_id: "call_9", name: "read", summary: "f", status: "ok" },
      { kind: "text", text: "done", complete: true },
      { kind: "tool", call_id: "call_10", name: "bash", summary: "g", status: "running" },
    ],
    pending_permissions: [],
  };
  store.apply({ v: 1, session: "sess_t", ts: 5000, event: "session.snapshot", data: snapshot });
  const ids = store.state.blocks.map((b) => b.id);
  assert.equal(ids.length, 4);
  for (const id of ids) assert.ok(!oldIds.includes(id), "snapshot ids are fresh");
  for (let i = 1; i < ids.length; i++) assert.ok(ids[i] > ids[i - 1]);
  assert.deepStrictEqual([...store.state.toolIndex.entries()], [
    ["call_9", 1],
    ["call_10", 3],
  ]);
  assert.deepStrictEqual(stripIds(store.state.blocks), snapshot.blocks);
  assert.equal(store.state.lastSeq, 42);
  assert.equal(store.state.title, "T");
  assert.equal(store.state.cwd, "/w");
  assert.equal(store.state.status, "warm");
  // Post-snapshot deltas resolve through the rebuilt index.
  store.apply(envelope(42, { event: "tool_output_delta", data: { call_id: "call_10", text: "z" } }));
  assert.equal(store.state.blocks[3].output_tail, "z");
});

test("recent excludes text/thinking/tool_output deltas and is capped at 100", () => {
  const store = new SessionStore("sess_t");
  store.apply(envelope(0, { event: "text_delta", data: "a" }));
  store.apply(envelope(1, { event: "thinking_delta", data: "b" }));
  store.apply(envelope(2, { event: "tool_output_delta", data: { call_id: "nope", text: "c" } }));
  assert.equal(store.state.recent.length, 0);
  for (let i = 0; i < 120; i++) store.apply(envelope(10 + i, { event: "info", data: `m${i}` }));
  assert.equal(store.state.recent.length, 100);
  assert.equal(store.state.recent[0].data, "m20");
  assert.equal(store.state.recent[99].data, "m119");
});

test("pending Map is replaced (new reference) on request/resolve/timeout", () => {
  const store = new SessionStore("sess_t");
  const p0 = store.state.pending;
  store.apply(envelope(0, { event: "permission.request", data: { request_id: "r1", tool: "bash", summary: "s", args: {} } }));
  const p1 = store.state.pending;
  assert.notEqual(p1, p0);
  assert.equal(p1.size, 1);
  assert.equal(p1.get("r1").received_at, 1000, "received_at comes from envelope ts");
  store.apply(envelope(1, { event: "permission.resolved", data: { request_id: "r1", choice: "once", by: "ui" } }));
  const p2 = store.state.pending;
  assert.notEqual(p2, p1);
  assert.equal(p2.size, 0);
  assert.equal(p1.size, 1, "previous Map instance is not mutated");

  store.apply(envelope(2, { event: "permission.request", data: { request_id: "r2", tool: "edit", summary: "s", args: {} } }));
  const p3 = store.state.pending;
  assert.notEqual(p3, p2);
  store.apply(envelope(3, { event: "permission.timeout", data: { request_id: "r2" } }));
  const p4 = store.state.pending;
  assert.notEqual(p4, p3);
  assert.equal(p4.size, 0);
});

test("pack UI form and progress stay ephemeral and recover from snapshots", () => {
  const store = new SessionStore("sess_t");
  const progress = {
    id: "ui-progress",
    pack: "demo",
    request_id: "p1",
    method: "progress",
    params: { id: "work", title: "Working", current: 1, total: 2, state: "running" },
    received_at: 1000,
  };
  const form = {
    id: "ui-form",
    pack: "demo",
    request_id: "profile",
    method: "form",
    params: { title: "Profile", submit_label: "Continue", fields: [{ id: "name", label: "Name", type: "text", required: true }] },
    received_at: 1001,
  };
  store.apply({ v: 1, session: "sess_t", ts: 1000, event: "ui.progress", data: progress });
  store.apply({ v: 1, session: "sess_t", ts: 1001, event: "ui.request", data: form });
  assert.equal(store.state.pendingUi.id, "ui-form");
  assert.equal(store.state.uiProgress.get("demo:work").params.current, 1);
  assert.equal(store.state.lastSeq, 0, "ephemeral events do not advance journal sequence");
  assert.equal(store.state.blocks.length, 0, "ephemeral UI does not enter transcript blocks");
  store.apply({ v: 1, session: "sess_t", ts: 1002, event: "ui.response_failed", data: { id: "ui-form", message: "retry" } });
  assert.equal(store.state.pendingUi.id, "ui-form", "failed response keeps the form pending");
  assert.equal(store.state.uiResponseError, "retry");
  const failureRev = store.state.uiResponseErrorRev;
  store.apply({ v: 1, session: "sess_t", ts: 1003, event: "ui.response_failed", data: { id: "ui-form", message: "retry" } });
  assert.ok(store.state.uiResponseErrorRev > failureRev, "identical retry failures still notify the UI");
  store.apply({ v: 1, session: "sess_t", ts: 1004, event: "ui.resolved", data: { id: "ui-form", status: "ok" } });
  store.apply({ v: 1, session: "sess_t", ts: 1005, event: "ui.progress.cleared" });
  assert.equal(store.state.pendingUi, undefined);
  assert.equal(store.state.uiProgress.size, 0);

  store.apply({
    v: 1,
    session: "sess_t",
    seq: 4,
    ts: 1006,
    event: "session.snapshot",
    data: {
      meta: { id: "sess_t", title: "T", cwd: "/w", status: "live", pending_permissions: 0, unread: 0, last_seq: 4 },
      blocks: [], pending_permissions: [], pending_ui_request: form, ui_progress: [progress], last_seq: 4,
    },
  });
  assert.equal(store.state.pendingUi.id, "ui-form");
  assert.equal(store.state.uiProgress.size, 1);
});

test("lastSeq tracks the envelope seq", () => {
  const store = new SessionStore("sess_t");
  assert.equal(store.state.lastSeq, 0);
  store.apply(envelope(0, { event: "info", data: "a" }));
  assert.equal(store.state.lastSeq, 1);
  store.apply(envelope(6, { event: "info", data: "b" }));
  assert.equal(store.state.lastSeq, 7);
  store.apply({ v: 1, session: "sess_t", ts: 1, event: "session.state", data: { status: "warm" } });
  assert.equal(store.state.lastSeq, 7, "unsequenced envelopes leave lastSeq alone");
});

test("retry is set by http_retry and cleared by turn_end", () => {
  const store = new SessionStore("sess_t");
  const r = { attempt: 1, wait_secs: 2, reason: "429" };
  store.apply(envelope(0, { event: "turn_start" }));
  store.apply(envelope(1, { event: "http_retry", data: r }));
  assert.deepStrictEqual(store.state.retry, r);
  store.apply(envelope(2, { event: "turn_end", data: { failed: false } }));
  assert.equal(store.state.retry, undefined);
});

test("session.configured patches only the provided fields", () => {
  const store = new SessionStore("sess_t");
  const cfg = (data) => ({ v: 1, session: "sess_t", ts: 1, event: "session.configured", data });
  store.apply(cfg({ provider: "anthropic", model: "opus", thinking_effort: "high", model_locked: false }));
  assert.equal(store.state.provider, "anthropic");
  assert.equal(store.state.model, "opus");
  assert.equal(store.state.thinkingEffort, "high");
  assert.equal(store.state.modelLocked, false);
  store.apply(cfg({ thinking_effort: "low", model_locked: true }));
  assert.equal(store.state.provider, "anthropic", "provider preserved");
  assert.equal(store.state.model, "opus", "model preserved");
  assert.equal(store.state.thinkingEffort, "low");
  assert.equal(store.state.modelLocked, true);
});

test("turn_start clears failed and marks working", () => {
  const store = new SessionStore("sess_t");
  store.apply(envelope(0, { event: "turn_start" }));
  store.apply(envelope(1, { event: "turn_end", data: { failed: true } }));
  assert.equal(store.state.failed, true);
  assert.equal(store.state.working, false);
  store.apply(envelope(2, { event: "turn_start" }));
  assert.equal(store.state.failed, false);
  assert.equal(store.state.working, true);
  assert.equal(store.state.turnStartedAt, 1002);
});

test("listeners are notified on apply and unsubscribe stops them", () => {
  const store = new SessionStore("sess_t");
  let n = 0;
  const off = store.subscribe(() => n++);
  store.apply(envelope(0, { event: "info", data: "a" }));
  assert.ok(n >= 1);
  const seen = n;
  off();
  store.apply(envelope(1, { event: "info", data: "b" }));
  assert.equal(n, seen);
});
