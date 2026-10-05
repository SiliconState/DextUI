import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readForkSource, forkBoundary, forkEvents } from "../src/session-fork.mjs";
import { withDisplayContext } from "../src/display-context.mjs";
const messages = [
  { role: "user", content: [{ type: "text", text: withDisplayContext("First task") }] },
  { role: "assistant", content: [{ type: "text", text: "Inspecting" }, { type: "tool_use", id: "read-1", name: "read_file", input: { path: "x" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: "result" }] },
  { role: "assistant", content: [{ type: "text", text: "Done" }] },
];
const journal = [{ seq: 8, event: "user_message", data: { text: "First task" } }, { seq: 24, event: "text_block_complete", data: "Inspecting" }, { seq: 30, event: "tool_call_result", data: { call_id: "read-1" } }];
test("fork mapping uses exact complete message identities, not journal counts", () => {
  assert.equal(forkBoundary(messages, journal), 4);
  assert.equal(forkBoundary(messages, journal, 0), 0);
  assert.equal(forkBoundary(messages, journal, 8), 1);
  assert.equal(forkBoundary(messages, journal, 24), 2);
  assert.equal(forkBoundary(messages, journal, 30), 3);
  for (const n of [-1, 2.5, 999]) assert.throws(() => forkBoundary(messages, journal, n));
  assert.throws(() => forkBoundary([...messages, messages[0]], journal, 8), /ambiguous/);
  assert.throws(() => forkBoundary(messages.slice(1), journal, 8), /compacted away/);
  assert.throws(() => forkBoundary([{ role: "user", content: [{ type: "tool_result" }] }], [{ seq: 1, event: "tool_call_result", data: {} }], 1), /ambiguous/);
});
test("fork projection excludes control state and reconstructs only retained messages", () => {
  const events = forkEvents(messages);
  assert.equal(events[0].data.text, "First task");
  assert.ok(events.some((e) => e.event === "tool_call_result" && e.data.call_id === "read-1" && e.data.content === "result"));
  assert.ok(!events.some((e) => ["permission.request", "background_compaction", "usage_update"].includes(e.event)));
});
test("fork source refuses linked, invalid and wrong-seat checkpoints", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dextui-fork-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "source.jsonl");
  const header = { session_id: "fork-source", sandbox: root, seat: { id: "dextui-1234" } };
  fs.writeFileSync(file, [header, ...messages].map(JSON.stringify).join("\n") + "\n");
  assert.equal(readForkSource(file, "dextui-1234").messages.length, 4);
  assert.throws(() => readForkSource(file, "dextui-other"), /identity/);
  fs.symlinkSync(file, path.join(root, "linked.jsonl"));
  assert.throws(() => readForkSource(path.join(root, "linked.jsonl"), "dextui-1234"), /symlink/);
  for (const content of [[null], [123], [{}]]) {
    fs.writeFileSync(file, [header, { role: "user", content }].map(JSON.stringify).join("\n") + "\n");
    assert.throws(() => readForkSource(file, "dextui-1234"), /invalid messages/);
  }
  fs.writeFileSync(file, "{"); assert.throws(() => readForkSource(file, "dextui-1234"));
});
