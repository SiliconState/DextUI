// Client SessionStore vs mock-server fold.mjs: both must project the same
// block list from the same journal. Fixtures are real dext recordings; the
// synthetic journals pin the lifecycle/marker rules one event family at a time.

import { test } from "node:test";
import assert from "node:assert/strict";

import { SessionStore } from "../dist/index.js";
import { fold, foldMeta } from "../../mock-server/src/fold.mjs";
import { applyAll, envelopesFromFixture, fixtureFiles, journal, stripIds } from "./helpers.mjs";

function project(envelopes) {
  const store = applyAll(new SessionStore("sess_t"), envelopes);
  return { store, client: stripIds(store.state.blocks), server: fold(envelopes) };
}

function assertEquivalent(envelopes) {
  const { store, client, server } = project(envelopes);
  assert.deepStrictEqual(client, server);
  return store;
}

// ---------- fixtures ----------

const files = fixtureFiles();
assert.ok(files.length > 0, "expected at least one fixture in packages/mock-server/fixtures");

for (const file of files) {
  test(`fixture ${file}: client blocks equal fold() blocks`, () => {
    const envelopes = envelopesFromFixture(file);
    assert.ok(envelopes.length > 0);
    assertEquivalent(envelopes);
  });

  test(`fixture ${file}: client meta equals foldMeta()`, () => {
    const envelopes = envelopesFromFixture(file);
    const store = applyAll(new SessionStore("sess_t"), envelopes);
    const meta = foldMeta(envelopes);
    const s = store.state;
    assert.deepStrictEqual(
      {
        turnUsage: s.turnUsage,
        sessionUsage: s.sessionUsage,
        contextChars: s.contextChars,
        diagnostics: s.diagnostics,
        compacting: s.compacting,
        failed: s.failed,
      },
      meta,
    );
  });
}

// ---------- synthetic journals ----------

const TOOL = { call_id: "call_1", name: "bash", summary: "ls -la" };

test("(a) tool lifecycle preview→start→output_delta×3→result folds into one card", () => {
  const envelopes = journal([
    { event: "turn_start" },
    { event: "tool_call_preview", data: TOOL },
    { event: "tool_call_start", data: TOOL },
    { event: "tool_output_delta", data: { call_id: "call_1", text: "a\n" } },
    { event: "tool_output_delta", data: { call_id: "call_1", text: "b\n" } },
    { event: "tool_output_delta", data: { call_id: "call_1", text: "c\n" } },
    { event: "tool_call_result", data: { ...TOOL, ok: true, content: "a\nb\nc\n" } },
    { event: "turn_end", data: { failed: false } },
  ]);
  const store = assertEquivalent(envelopes);
  const blocks = store.state.blocks;
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "tool");
  assert.equal(blocks[0].status, "ok");
  assert.equal(blocks[0].output_tail, "a\nb\nc\n");
  assert.equal(blocks[0].content, "a\nb\nc\n");
});

test("(b) tool_call_start without a preceding preview creates the card as running", () => {
  const envelopes = journal([
    { event: "tool_call_start", data: TOOL },
    { event: "tool_call_result", data: { ...TOOL, ok: false, content: "boom" } },
  ]);
  const store = assertEquivalent(envelopes);
  assert.equal(store.state.blocks.length, 1);
  assert.equal(store.state.blocks[0].status, "failed");
});

test("(c) text_delta interleaved with a tool card yields two text blocks", () => {
  const envelopes = journal([
    { event: "text_delta", data: "before " },
    { event: "text_delta", data: "tool" },
    { event: "tool_call_preview", data: TOOL },
    { event: "tool_call_start", data: TOOL },
    { event: "tool_call_result", data: { ...TOOL, ok: true, content: "" } },
    { event: "text_delta", data: "after" },
    { event: "text_block_complete", data: "after" },
  ]);
  const store = assertEquivalent(envelopes);
  const kinds = store.state.blocks.map((b) => b.kind);
  assert.deepStrictEqual(kinds, ["text", "tool", "text"]);
  assert.equal(store.state.blocks[0].text, "before tool");
  assert.equal(store.state.blocks[2].complete, true);
});

test("(d) thinking deltas + complete collapse into one completed thinking block", () => {
  const envelopes = journal([
    { event: "thinking_delta", data: "hm" },
    { event: "thinking_delta", data: "m..." },
    { event: "thinking_block_complete", data: "hmm..." },
    { event: "text_delta", data: "ok" },
    { event: "text_block_complete", data: "ok" },
  ]);
  const store = assertEquivalent(envelopes);
  assert.deepStrictEqual(stripIds(store.state.blocks), [
    { kind: "thinking", text: "hmm...", complete: true },
    { kind: "text", text: "ok", complete: true },
  ]);
});

test("(e) permission.request → resolved once / deny produce `<tool>: <choice>` markers", () => {
  const req = (id) => ({ request_id: id, tool: "bash", summary: "rm -rf x", args: {} });
  const envelopes = journal([
    { event: "permission.request", data: req("r1") },
    { event: "permission.resolved", data: { request_id: "r1", choice: "once", by: "ui" } },
    { event: "permission.request", data: req("r2") },
    { event: "permission.resolved", data: { request_id: "r2", choice: "deny", by: "ui" } },
  ]);
  const store = assertEquivalent(envelopes);
  assert.deepStrictEqual(stripIds(store.state.blocks), [
    { kind: "marker", level: "info", text: "bash: once" },
    { kind: "marker", level: "warn", text: "bash: deny" },
  ]);
  assert.equal(store.state.pending.size, 0);
});

test("(f) permission.request → permission.timeout produces the timed-out marker", () => {
  const envelopes = journal([
    { event: "permission.request", data: { request_id: "r1", tool: "edit", summary: "x", args: {} } },
    { event: "permission.timeout", data: { request_id: "r1" } },
  ]);
  const store = assertEquivalent(envelopes);
  assert.deepStrictEqual(stripIds(store.state.blocks), [
    { kind: "marker", level: "warn", text: "edit: approval timed out (denied)" },
  ]);
});

test("(g) http_retry marker", () => {
  assertEquivalent(journal([{ event: "http_retry", data: { attempt: 2, wait_secs: 4, reason: "overloaded" } }]));
});

test("(g) reasoning_mode_changed marker", () => {
  assertEquivalent(journal([{ event: "reasoning_mode_changed", data: { mode: "deep" } }]));
});

test("(g) runtime_control (string) marker", () => {
  assertEquivalent(journal([{ event: "runtime_control", data: "/model opus" }]));
});

test("(g) runtime_control_applied with and without stream_aborted", () => {
  assertEquivalent(
    journal([
      { event: "runtime_control_applied", data: { commands: 1, model_changed: true } },
      {
        event: "runtime_control_applied",
        data: { commands: 3, model_changed: true, effort_changed: true, mode_changed: true, stream_aborted: true },
      },
      { event: "runtime_control_applied", data: { commands: 0 } },
    ]),
  );
});

test("(g) login_input_mode with and without provider", () => {
  assertEquivalent(
    journal([
      { event: "login_input_mode", data: { provider: "anthropic" } },
      { event: "login_input_mode", data: {} },
      { event: "login_input_mode", data: { provider: null } },
    ]),
  );
});

test("(g) local_auth_prompt marker", () => {
  assertEquivalent(journal([{ event: "local_auth_prompt", data: { tool: "gh", message: "token needed" } }]));
});

test("(g) steering_received marker", () => {
  assertEquivalent(journal([{ event: "steering_received", data: { preview: "focus on tests" } }]));
});

test("(h) pack_start stamps the turn's prompt block; runtime_view keeps its own pack", () => {
  const envelopes = journal([
    { event: "user_message", data: { text: "make a report" } },
    { event: "turn_start" },
    { event: "pack_start", data: { name: "report", task_preview: "make a report" } },
    { event: "runtime_view", data: { pack: "report", title: "t", markdown: "m" } },
    { event: "turn_end", data: { usage: { input: 0, output: 0, cache_create: 0, cache_read: 0, cost_usd: 0 }, failed: false } },
    // A second turn without a pack must not inherit the first turn's stamp.
    { event: "user_message", data: { text: "plain" } },
    { event: "turn_start" },
    { event: "pack_start", data: { name: "" } },
    { event: "pack_start", data: {} },
  ]);
  const store = assertEquivalent(envelopes);
  assert.deepStrictEqual(stripIds(store.state.blocks), [
    { kind: "user", text: "make a report", pack: "report" },
    { kind: "view", pack: "report", title: "t", markdown: "m" },
    { kind: "user", text: "plain" },
  ]);
  assert.equal(store.state.activePack, undefined, "cleared at turn_end");
});

test("(g) compact_end and compact_failed markers", () => {
  const envelopes = journal([
    { event: "compact_start" },
    { event: "compact_end", data: { before: 5000, after: 1200 } },
    { event: "compact_start" },
    { event: "compact_failed", data: { message: "provider down" } },
  ]);
  const store = assertEquivalent(envelopes);
  assert.equal(store.state.compacting, false);
});

test("(g) tool_batch_start/end with failed 0 and failed 2", () => {
  assertEquivalent(
    journal([
      { event: "tool_batch_start", data: { labels: ["bash", "read"] } },
      { event: "tool_batch_end", data: { failed: 0 } },
      { event: "tool_batch_start", data: { labels: ["edit"] } },
      { event: "tool_batch_end", data: { failed: 2 } },
    ]),
  );
});

test("(g) interrupted seals the open text block and appends the marker", () => {
  const envelopes = journal([
    { event: "turn_start" },
    { event: "text_delta", data: "half" },
    { event: "interrupted" },
  ]);
  const store = assertEquivalent(envelopes);
  assert.deepStrictEqual(stripIds(store.state.blocks), [
    { kind: "text", text: "half", complete: true },
    { kind: "marker", level: "warn", text: "Interrupted." },
  ]);
});

test("(g) turn_end seals open text and thinking blocks", () => {
  const envelopes = journal([
    { event: "turn_start" },
    { event: "thinking_delta", data: "t" },
    { event: "text_delta", data: "x" },
    { event: "turn_end", data: { failed: false } },
  ]);
  const store = assertEquivalent(envelopes);
  assert.ok(store.state.blocks.every((b) => b.complete === true));
});

test("(h) user_message after a completed text block starts a new text block", () => {
  const envelopes = journal([
    { event: "text_delta", data: "first" },
    { event: "text_block_complete", data: "first" },
    { event: "user_message", data: { text: "again" } },
    { event: "text_delta", data: "second" },
  ]);
  const store = assertEquivalent(envelopes);
  assert.deepStrictEqual(stripIds(store.state.blocks), [
    { kind: "text", text: "first", complete: true },
    { kind: "user", text: "again" },
    { kind: "text", text: "second", complete: false },
  ]);
});
