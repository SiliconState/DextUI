import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../dist/index.js";
import { fold } from "../../mock-server/src/fold.mjs";
import { applyAll, journal, stripIds, envelope } from "./helpers.mjs";

const events = [
  { event: "thinking_delta", data: "saved" },
  { event: "thinking_block_complete", data: "saved" },
  { event: "thinking_preview_committed" },
  { event: "thinking_delta", data: "bad" },
  { event: "thinking_block_complete", data: "bad" },
  { event: "tool_call_preview", data: { call_id: "t", name: "read_file", summary: "x" } },
  { event: "thinking_delta", data: "also bad" },
  { event: "warn", data: "retrying" },
  { event: "thinking_preview_discarded" },
  { event: "tool_call_result", data: { call_id: "t", ok: true, content: "ok" } },
  { event: "thinking_delta", data: "good" },
  { event: "text_delta", data: "answer" },
  { event: "thinking_block_complete", data: "good" },
  { event: "text_block_complete", data: "answer" },
  { event: "thinking_preview_committed" },
  { event: "thinking_preview_discarded" },
];

test("thinking transaction: live and folded replay agree, committed blocks survive, tool indexes remain valid", () => {
  const input = journal(events);
  const store = applyAll(new SessionStore("s"), input);
  assert.deepEqual(stripIds(store.state.blocks), fold(input));
  assert.deepEqual(store.state.blocks.filter((b) => b.kind === "thinking").map((b) => b.text), ["saved", "good"]);
  assert.equal(store.state.blocks.filter((b) => b.kind === "text").length, 1);
  assert.equal(store.state.blocks[store.state.toolIndex.get("t")].content, "ok");
});

test("snapshot during provisional thinking preserves rollback identity across reconnect", () => {
  const prefix = journal(events.slice(0, 8));
  const store = new SessionStore("s");
  store.apply(envelope(10, { event: "session.snapshot", data: {
    meta: { id: "s", title: "s", cwd: "/w", status: "live" }, last_seq: 10,
    blocks: fold(prefix), pending_permissions: [], working: true,
  } }));
  store.apply(envelope(11, { event: "thinking_preview_discarded" }));
  assert.deepEqual(store.state.blocks.filter((b) => b.kind === "thinking").map((b) => b.text), ["saved"]);
  store.apply(envelope(12, { event: "tool_call_result", data: { call_id: "t", ok: true, content: "done" } }));
  assert.equal(store.state.blocks[store.state.toolIndex.get("t")].content, "done");
});
