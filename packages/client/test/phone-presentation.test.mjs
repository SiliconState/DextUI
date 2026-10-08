import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("../../../apps/web/src/lib/phone-presentation.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { phoneCopyIds, toolResultMetadata, readableOutput, phoneTranscriptItems, phoneWorkRows, tipSummary, isAdvisoryMarker } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("phone Copy stays available on final prose even with trailing notices and work", () => {
  const blocks = [
    { id: 1, kind: "user" }, { id: 2, kind: "text" }, { id: 3, kind: "text" },
    { id: 4, kind: "marker", level: "warn", text: "Notice" }, { id: 5, kind: "tool" },
    { id: 6, kind: "user" }, { id: 7, kind: "text" }, { id: 8, kind: "view" },
  ];
  assert.deepEqual([...phoneCopyIds(blocks)], [3, 7]);
  assert.deepEqual([...phoneCopyIds([])], []);
});

test("tool metadata never invents an exit code or a negative/replayed duration", () => {
  const shell = { id: 1, kind: "tool", call_id: "a", name: "bash", status: "ok", content: "exit: 0\n--- stdout ---\nresult" };
  assert.deepEqual(toolResultMetadata(shell), { exitCode: 0 });
  assert.deepEqual(toolResultMetadata({ ...shell, name: "read_file" }), {});
  assert.deepEqual(toolResultMetadata({ ...shell, status: "running" }), {});
  assert.deepEqual(toolResultMetadata({ ...shell, content: "stdout\nexit: 1\nnot metadata" }), {});
  assert.deepEqual(toolResultMetadata({ ...shell, content: '{"exit_code":2,"stdout":"exit: 0"}' }), { exitCode: 2 });
  assert.deepEqual(toolResultMetadata({ ...shell, content: '{"exit_code":"2"}' }), {});
  const event = (event, ts, data = { call_id: "a" }) => ({ event, ts, data });
  const recent = [event("tool_call_start", 10), event("tool_call_result", 20), event("tool_call_start", 40), event("tool_call_result", 140), event("tool_call_result", 150, null)];
  assert.equal(toolResultMetadata(shell, recent).duration, 0.1);
  assert.equal(toolResultMetadata(shell, [event("tool_call_result", 10), event("tool_call_start", 20)]).duration, undefined);
});

test("phone work rows drop duplicate batch labels and collapse repeated shell guidance into tips", () => {
  const advisory = "[runtime-note] bash advisory: prefer the native rg tool over recursive grep; it is faster.";
  const blocks = [
    { id: 1, kind: "marker", level: "info", text: "Batch: rg: /x/ in src · read_file: a.ts" },
    { id: 2, kind: "tool", call_id: "a", name: "rg", status: "ok", summary: "rg: /x/ in src" },
    { id: 3, kind: "marker", level: "note", text: advisory },
    { id: 4, kind: "tool", call_id: "b", name: "bash", status: "failed", summary: "grep -r x ." },
    { id: 5, kind: "marker", level: "note", text: advisory },
    { id: 6, kind: "marker", level: "info", text: "[phase:verify] Tests" },
  ];
  const rows = phoneWorkRows(blocks);
  assert.deepEqual(rows.map((row) => row.kind), ["step", "tip", "step", "block"]);
  assert.equal(rows[1].count, 2);
  assert.equal(rows[1].summary, "Prefer the native rg tool over recursive grep");
  assert.ok(rows[1].text.includes("it is faster"), "full guidance remains reachable");
  assert.equal(tipSummary("bash advisory: `sed` is avoidable here. Prefer read_file."), "`sed` is avoidable here");
});

test("advisory detection never captures errors, auth prompts or empty guidance", () => {
  assert.equal(isAdvisoryMarker({ kind: "marker", level: "note", text: "bash advisory: use rg" }), true);
  assert.equal(isAdvisoryMarker({ kind: "marker", level: "error", text: "bash advisory: use rg" }), false);
  assert.equal(isAdvisoryMarker({ kind: "marker", level: "warn", text: "bash advisory: use rg" }), false);
  assert.equal(isAdvisoryMarker({ kind: "marker", level: "note", text: "bash advisory: use rg", auth: { tool: "x", message: "y" } }), false);
  assert.equal(isAdvisoryMarker({ kind: "marker", level: "note", text: "bash advisory:   " }), false);
  assert.equal(isAdvisoryMarker({ kind: "marker", level: "note", text: "Consider the bash advisory: later" }), false);
});

test("phone batch filtering never hides failure, warning or authentication markers", () => {
  const blocks = [
    { id: 1, kind: "marker", level: "info", text: "Batch: 2 tool call(s) failed." },
    { id: 2, kind: "marker", level: "warn", text: "Batch: bash: command needs review" },
    { id: 3, kind: "marker", level: "note", text: "Batch: bash: sign in", auth: { tool: "bash", message: "Sign in" } },
    { id: 4, kind: "marker", level: "warn", text: "bash advisory: inspect this warning" },
    { id: 5, kind: "marker", level: "info", text: "Batch: unfamiliar status" },
  ];
  const before = JSON.stringify(blocks);
  assert.deepEqual(phoneTranscriptItems(blocks).map((item) => item.kind), blocks.map(() => "block"));
  assert.deepEqual(phoneWorkRows(blocks).map((row) => row.block), blocks);
  assert.equal(JSON.stringify(blocks), before);
});

test("tool output decodes real JSON strings and streams but preserves literal code escapes", () => {
  assert.equal(readableOutput('"line one\\nline two"'), "line one\nline two");
  assert.equal(readableOutput('{"stdout":"passed\\n2 tests","stderr":"warning\\nretry"}'), "stdout\npassed\n2 tests\n\nstderr\nwarning\nretry");
  assert.equal(readableOutput('{"output":"one\\ntwo"}'), "one\ntwo");
  assert.equal(readableOutput('{"content":"one\\ntwo"}'), "one\ntwo");
  for (const text of ['printf "hello\\n"', '{"arbitrary":"one\\ntwo"}', '{not json}', '["one","two"]']) assert.equal(readableOutput(text), text);
});

test("phone work summaries preserve all tools without folding answers or safety prompts", () => {
  const blocks = [
    { id: 1, kind: "user", text: "Review" },
    { id: 2, kind: "thinking", text: "Plan", complete: true },
    { id: 3, kind: "text", text: "Progress", complete: true },
    { id: 4, kind: "tool", call_id: "a", name: "bash", status: "failed", summary: "test", content: "failed" },
    { id: 5, kind: "marker", level: "info", text: "[phase:verify] Tests" },
    { id: 6, kind: "marker", level: "warn", text: "Approval timed out" },
    { id: 7, kind: "marker", level: "error", text: "Sign in required", auth: { tool: "http", message: "Sign in" } },
    { id: 8, kind: "compact", status: "complete" },
    { id: 9, kind: "view", pack: "report", title: "Report", markdown: "Result" },
    { id: 10, kind: "text", text: "Verdict", complete: true },
    { id: 11, kind: "user", text: "Next" },
    { id: 12, kind: "tool", call_id: "b", name: "read_file", status: "ok", summary: "Read", content: "evidence" },
  ];
  const before = JSON.stringify(blocks);
  const items = phoneTranscriptItems(blocks);
  assert.equal(JSON.stringify(blocks), before, "canonical blocks must not change");
  const work = items.filter((item) => item.kind === "work");
  assert.deepEqual(work.map((item) => item.blocks.map((block) => block.id)), [[2, 4, 5], [12]]);
  assert.deepEqual(work.map((item) => item.current), [false, true]);
  assert.deepEqual(items.filter((item) => item.kind === "block").map((item) => item.id), [1, 3, 6, 7, 8, 9, 10, 11]);
  assert.equal(work[0].blocks[1], blocks[3], "failed output stays lossless and reachable");
});

test("phone grouping keeps steering, runtime controls and unfamiliar information visible", () => {
  const markers = ["Steering: follow-up", "Steering applied: follow-up", "Runtime control applied: effort high", "Approval profile: ask", "Provider status changed"].map((text, index) => ({ id: index + 1, kind: "marker", level: "note", text }));
  const items = phoneTranscriptItems(markers);
  assert.deepEqual(items.map((item) => item.kind), markers.map(() => "block"));
  assert.deepEqual(items.map((item) => item.block), markers);
});

test("phone grouping handles empty and windowed transcripts without requiring a user block", () => {
  assert.deepEqual(phoneTranscriptItems([]), []);
  const block = { id: 20, kind: "tool", call_id: "a", name: "rg", summary: "search", status: "running" };
  assert.deepEqual(phoneTranscriptItems([block]), [{ kind: "work", id: 20, blocks: [block], current: true }]);
});
