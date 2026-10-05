import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../dist/index.js";
import { fold, foldMeta } from "../../mock-server/src/fold.mjs";
import { journal, stripIds } from "./helpers.mjs";
const job = (phase = "running", overrides = {}) => ({ version: 1, session_id: "core-1", session_epoch: 0, job_id: "bg-1", origin_turn_id: "turn-1", phase, blocking: phase === "waiting", reason: "fixture", elapsed_ms: 10, wait_ms: 0, before_chars: 25000, usage_known: true, ...overrides });
const ephemeral = (data) => ({ v: 1, session: "sess_t", ts: 1000, event: "background_compaction", data });

test("background lifecycle stays separate from working, approvals, history and usage", () => {
  const s = new SessionStore("sess_t");
  s.apply({ v: 1, ts: 1, event: "permission.request", data: { request_id: "p", tool: "write_file" } });
  for (const phase of ["running", "ready", "waiting"]) {
    s.apply(ephemeral(job(phase)));
    assert.equal(s.state.backgroundCompaction.phase, phase);
    assert.equal(s.state.working, false); assert.equal(s.state.compacting, false);
    assert.equal(s.state.pending.size, 1); assert.equal(s.state.sessionUsage, undefined);
    assert.equal(s.state.blocks.length, 0);
  }
  s.apply(ephemeral(job("applied")));
  assert.equal(s.state.backgroundCompaction, undefined);
  s.apply(ephemeral(job("ready"))); s.apply(ephemeral(job("running")));
  assert.equal(s.state.backgroundCompaction, undefined, "late job cannot revive a terminal badge");
});

test("background apply is one collapsed block and does not finish legacy compaction", () => {
  const events = journal([
    { event: "turn_start" }, { event: "compact_start" },
    { event: "history_context_updated", data: { chars: 800, tokens: 200 } },
    { event: "compact_end", data: { before: 12, after: 3, summary: "Background summary", background: true, job_id: "bg-1" } },
  ]);
  const s = new SessionStore("sess_t");
  for (const e of events) s.apply(e);
  assert.equal(s.state.working, true); assert.equal(s.state.compacting, true);
  assert.deepEqual(stripIds(s.state.blocks), fold(events));
  assert.equal(foldMeta(events).compacting, true);
  assert.equal(s.state.blocks.filter((b) => b.kind === "compact").length, 2);
  assert.equal(s.state.blocks[0].status, "running");
  const finish = { v: 1, session: "sess_t", ts: 4, event: "compact_end", data: { before: 3, after: 2, summary: "Manual summary" } };
  s.apply(finish); events.push(finish);
  assert.deepEqual(stripIds(s.state.blocks), fold(events));
  assert.equal(s.state.compacting, false);
});

test("same-child reconnect restores authoritative job or clears stale local state", () => {
  const s = new SessionStore("sess_t"); s.apply(ephemeral(job()));
  const sync = (current) => s.apply({ v: 1, ts: 2, event: "x-agentlinkd.background_compaction", data: { current } });
  sync(null); assert.equal(s.state.backgroundCompaction, undefined);
  sync(job("waiting")); assert.equal(s.state.backgroundCompaction.phase, "waiting");
  s.apply({ v: 1, ts: 3, event: "turn_end", data: { usage: { input: 14, output: 9, cache_create: 0, cache_read: 0, cost_usd: 0 }, failed: false } });
  assert.equal(s.state.backgroundCompaction.phase, "waiting", "turn end is not job end");
  s.apply({ v: 1, ts: 4, event: "session.snapshot", data: { meta: { id: "sess_t", title: "T", cwd: "/test", status: "cold" }, blocks: [], pending_permissions: [], last_seq: 0, working: false, background_compaction: null } });
  assert.equal(s.state.backgroundCompaction, undefined);
  assert.equal(s.state.working, false);
});

test("discarded job metrics never add cost to authoritative usage", () => {
  const s = new SessionStore("sess_t"); const usage = { input: 14, output: 9, cache_create: 0, cache_read: 0, cost_usd: 0.25 };
  s.apply({ v: 1, ts: 1, event: "usage_update", data: { turn: usage, session: usage } });
  s.apply(ephemeral(job())); s.apply(ephemeral(job("discarded", { usage_known: false })));
  s.apply({ v: 1, ts: 2, event: "turn_end", data: { usage: { ...usage, input: 1, output: 1, cost_usd: 0.01 }, failed: false } });
  assert.deepEqual(s.state.sessionUsage, usage);
  assert.deepEqual(foldMeta([
    { event: "usage_update", data: { turn: usage, session: usage } },
    { event: "turn_end", data: { usage: { ...usage, input: 1, output: 1 }, failed: false } },
  ]).sessionUsage, usage);
  assert.equal(s.state.backgroundCompaction, undefined);
});
