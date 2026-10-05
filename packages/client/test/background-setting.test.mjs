import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../dist/index.js";
import { fold } from "../../mock-server/src/fold.mjs";

test("background preference setting/sync patches are not user turns, blocks, usage or jobs", () => {
  const s = new SessionStore("sess_t");
  const events = [
    { event: "background_compaction_setting", data: { enabled: false } },
    { event: "x-agentlinkd.background_compaction_setting", data: { enabled: false, pending: true } },
    { event: "x-agentlinkd.background_compaction_setting", data: { enabled: true, pending: false } },
  ].map((e) => ({ v: 1, session: "sess_t", ts: Date.now(), ...e }));
  for (const e of events) s.apply(e);
  assert.equal(s.state.backgroundCompact, true); assert.equal(s.state.backgroundCompactPending, false);
  assert.equal(s.state.working, false); assert.equal(s.state.compacting, false);
  assert.equal(s.state.backgroundCompaction, undefined); assert.equal(s.state.sessionUsage, undefined);
  assert.deepEqual(s.state.blocks, []); assert.deepEqual(fold(events), []);
  s.apply({ event: "background_compaction_setting", data: { enabled: "false" } });
  s.apply({ event: "x-agentlinkd.background_compaction_setting", data: { enabled: false } });
  assert.equal(s.state.backgroundCompact, true, "malformed controls cannot change the setting");
});

test("background setting is restored by authoritative snapshots, retained across unrelated configuration patches", () => {
  const s = new SessionStore("sess_t");
  s.apply({ event: "session.snapshot", data: { meta: { id: "sess_t", title: "Test", cwd: "/tmp", status: "cold", background_compact: false }, blocks: [], pending_permissions: [], last_seq: 0, background_compact_pending: true } });
  assert.equal(s.state.backgroundCompact, false); assert.equal(s.state.backgroundCompactPending, true);
  s.apply({ event: "session.configured", data: { thinking_effort: "high", model_locked: false } });
  assert.equal(s.state.backgroundCompact, false);
  s.apply({ event: "session.configured", data: { background_compact: true, model_locked: false } });
  assert.equal(s.state.backgroundCompact, true);
  s.apply({ event: "session.snapshot", data: { meta: { id: "sess_t", status: "live" }, blocks: [], pending_permissions: [], last_seq: 0 } });
  assert.equal(s.state.backgroundCompact, undefined, "older hosts do not imply a setting");
  assert.equal(s.state.backgroundCompactPending, false);
});
