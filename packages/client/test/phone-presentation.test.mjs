import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { SessionStore } from "../dist/index.js";

const source = fs.readFileSync(new URL("../../../apps/web/src/lib/phone-presentation.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { phoneCopyIds, phoneWorkCounts, phoneWorkState, toolResultMetadata, readableOutput, phoneTranscriptItems, phoneWorkRows, tipSummary, isAdvisoryMarker, isBatchFailureMarker, isRuntimeGuidanceMarker } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("runtime checkpoint guidance stays in work without capturing narration or private user text", () => {
  const text = "runtime guidance: objective checkpoints still look unresolved: log decisions and follow-up improvements. Before ending this turn, address them or explicitly say why each remaining item is not applicable / blocked.";
  const guidance = { id: 4, kind: "marker", level: "warn", text };
  const blocks = [
    { id: 1, kind: "user", text: "- Systems involved - Private ERP and storefront\n- What you built yourself - A private integration" },
    { id: 2, kind: "tool", call_id: "a", name: "read_file", status: "ok", summary: "Read" },
    { id: 3, kind: "text", complete: true, text },
    guidance,
    { id: 5, kind: "marker", level: "error", text },
    { id: 6, kind: "marker", level: "warn", text, auth: { tool: "http", message: "Sign in" } },
    { id: 7, kind: "marker", level: "warn", text: "Provider sign-in failed" },
  ];
  for (const compact of [true, false]) {
    const items = phoneTranscriptItems(blocks, compact);
    assert.ok(items.some((item) => item.kind === "work" && item.blocks.includes(guidance)));
    for (const id of [1, 3, 5, 6, 7]) assert.ok(items.some((item) => item.kind === "block" && item.id === id));
  }
  for (const prefix of ["runtime guidance:", "[runtime-note] runtime guidance:", "final objective warning:", "queued update unresolved:"]) assert.equal(isRuntimeGuidanceMarker({ ...guidance, text: `${prefix} review checkpoint` }), true);
  assert.equal(isRuntimeGuidanceMarker({ ...guidance, text: "We discussed runtime guidance: previously" }), false);
  assert.equal(isRuntimeGuidanceMarker({ ...guidance, text: "runtime guidance:" }), false);
});

test("phone work counts report tool outcomes without inventing success for unfinished steps", () => {
  const blocks = [
    { id: 1, kind: "tool", status: "ok" },
    { id: 2, kind: "tool", status: "ok" },
    { id: 3, kind: "tool", status: "failed" },
    { id: 4, kind: "tool", status: "running" },
    { id: 5, kind: "tool", status: "preview" },
    { id: 6, kind: "thinking", text: "Plan" },
    { id: 7, kind: "marker", level: "warn", text: "bash advisory: use native tools" },
  ];
  assert.deepEqual(phoneWorkCounts(blocks), { total: 5, passed: 2, failed: 1, running: 1, pending: 1 });
  assert.deepEqual(phoneWorkCounts([]), { total: 0, passed: 0, failed: 0, running: 0, pending: 0 });
});

test("warning-level Bash advisory stays in phone work in both compact and show-all modes", () => {
  const blocks = [
    { id: 1, kind: "user", text: "Inspect" },
    { id: 2, kind: "tool", name: "bash", call_id: "a", status: "ok", summary: "grep", content: "result" },
    { id: 3, kind: "text", text: "Agent narration", complete: true },
    { id: 4, kind: "marker", level: "warn", text: "bash advisory: prefer native rg" },
    { id: 5, kind: "marker", level: "note", text: "[runtime-note] bash advisory: prefer native rg" },
    { id: 6, kind: "marker", level: "warn", text: "Command denied by policy" },
    { id: 7, kind: "marker", level: "error", text: "bash advisory: action blocked" },
    { id: 8, kind: "marker", level: "warn", text: "bash advisory: sign in", auth: { tool: "bash", message: "Sign in" } },
  ];
  const before = JSON.stringify(blocks);
  for (const compact of [true, false]) {
    const items = phoneTranscriptItems(blocks, compact);
    const work = items.filter((item) => item.kind === "work");
    assert.equal(work.length, compact ? 2 : 1);
    const guidance = work.find((item) => item.blocks.includes(blocks[3]));
    assert.ok(guidance, "Recognized guidance remains in its own phase");
    assert.ok(guidance.blocks.includes(blocks[4]));
    assert.deepEqual(items.flatMap((item) => item.kind === "work" ? item.blocks : [item.block]), blocks, "Guidance never moves across narration");
    assert.ok(items.filter((item) => item.kind === "block").every((item) => item.id !== 4 && item.id !== 5));
    assert.ok(items.some((item) => item.kind === "block" && item.id === 3), "Agent prose stays outside work");
    for (const id of [6, 7, 8]) assert.ok(items.some((item) => item.kind === "block" && item.id === id));
    if (!compact) assert.ok(items.some((item) => item.kind === "block" && item.id === 2), "Show all retains rich tools");
    const tip = phoneWorkRows(guidance.blocks).find((row) => row.kind === "tip");
    assert.equal(tip.count, 2);
    assert.equal(tip.warning, true);
    assert.equal(tip.text, "prefer native rg");
  }
  assert.equal(JSON.stringify(blocks), before);
});

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

test("phone batch labels survive when execution stops before tools start", () => {
  const marker = { id: 1, kind: "marker", level: "note", text: "Batch: read_file: reports/weekly.md" };
  const notice = { id: 2, kind: "marker", level: "warn", text: "Batch: 1 tool call(s) failed." };
  const rows = phoneWorkRows([marker, notice]);
  assert.deepEqual(rows.map((row) => row.block), [marker, notice]);
  assert.equal(phoneWorkCounts([marker, notice]).total, 0);
  const earlier = { id: 3, kind: "tool", name: "bash", call_id: "earlier", status: "ok" };
  assert.deepEqual(phoneWorkRows([earlier, marker, notice]).map((row) => row.block), [earlier, marker, notice], "An earlier tool cannot erase a batch that never started");
  const recovery = { ...earlier, id: 4, call_id: "recovery" };
  assert.deepEqual(phoneWorkRows([marker, notice, recovery]).map((row) => row.block), [marker, notice, recovery], "A later recovery tool cannot erase a failed batch that never started");
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
  assert.equal(isAdvisoryMarker({ kind: "marker", level: "warn", text: "bash advisory: use rg" }), true);
  assert.equal(isAdvisoryMarker({ kind: "marker", level: "note", text: "bash advisory: use rg", auth: { tool: "x", message: "y" } }), false);
  assert.equal(isAdvisoryMarker({ kind: "marker", level: "note", text: "bash advisory:   " }), false);
  assert.equal(isAdvisoryMarker({ kind: "marker", level: "note", text: "Consider the bash advisory: later" }), false);
});

test("phone batch filtering leaves unrelated warnings, errors and auth outside work", () => {
  const blocks = [
    { id: 1, kind: "marker", level: "error", text: "Batch: 2 tool call(s) failed." },
    { id: 2, kind: "marker", level: "warn", text: "Batch: bash: command needs review" },
    { id: 3, kind: "marker", level: "note", text: "Batch: bash: sign in", auth: { tool: "bash", message: "Sign in" } },
    { id: 4, kind: "marker", level: "warn", text: "Command blocked: inspect this warning" },
    { id: 5, kind: "marker", level: "info", text: "Batch: unfamiliar status" },
  ];
  const before = JSON.stringify(blocks);
  assert.deepEqual(phoneTranscriptItems(blocks).map((item) => item.kind), blocks.map(() => "block"));
  assert.deepEqual(phoneWorkRows(blocks).map((row) => row.block), blocks);
  assert.equal(JSON.stringify(blocks), before);
});

test("exact batch failures stay inside active and completed phone work without double counting", () => {
  const notice = { id: 4, kind: "marker", level: "warn", text: "Batch: 1 tool call(s) failed." };
  const blocks = [
    { id: 1, kind: "user", text: "Inspect" },
    { id: 2, kind: "tool", name: "read_file", call_id: "failed", status: "failed", summary: "Read evidence" },
    { id: 3, kind: "thinking", text: "Continuing the work", complete: true },
    notice,
  ];
  const before = JSON.stringify(blocks);
  assert.equal(isBatchFailureMarker(notice), true);
  assert.equal(isBatchFailureMarker({ ...notice, text: "Batch: 2 tool call(s) failed" }), true);
  for (const other of [
    { ...notice, text: "Batch: bash: command needs approval" },
    { ...notice, text: "Something went wrong. Batch: 1 tool call(s) failed." },
    { ...notice, level: "error" },
    { ...notice, auth: { tool: "bash", message: "Sign in" } },
  ]) assert.equal(isBatchFailureMarker(other), false);
  for (const compact of [true, false]) {
    for (const completedTurn of [false, true]) {
      const source = completedTurn ? [...blocks, { id: 5, kind: "user", text: "Next turn" }] : blocks;
      const items = phoneTranscriptItems(source, compact);
      const work = items.find((item) => item.kind === "work");
      assert.equal(work.current, !completedTurn);
      assert.ok(work.blocks.includes(notice));
      assert.ok(!items.some((item) => item.kind === "block" && item.id === notice.id));
      const row = phoneWorkRows(work.blocks).find((item) => item.id === notice.id);
      assert.equal(row.kind, "block");
      assert.equal(row.block, notice, "Full warning stays inspectable within work");
      assert.equal(phoneWorkCounts(work.blocks).failed, compact ? 1 : 0, "Batch warning does not invent/double-count tool outcomes");
    }
  }
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
  assert.deepEqual(work.map((item) => item.blocks.map((block) => block.id)), [[2], [4, 5], [12]]);
  assert.deepEqual(work.map((item) => item.current), [false, false, true]);
  assert.deepEqual(items.filter((item) => item.kind === "block").map((item) => item.id), [1, 3, 6, 7, 8, 9, 10, 11]);
  assert.equal(work[1].blocks[0], blocks[3], "failed output stays lossless and reachable");
  assert.deepEqual(items.flatMap((item) => item.kind === "work" ? item.blocks : [item.block]), blocks, "All blocks retain transcript order");
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
  assert.deepEqual(phoneTranscriptItems([block]), [{ kind: "work", id: 20, blocks: [block], current: true, currentTurn: true }]);
});

test("phone work alternates with streaming responses and keeps stable phase identities", () => {
  const blocks = [
    { id: 1, kind: "user", text: "Check and update" },
    { id: 2, kind: "thinking", text: "Inspect", complete: true },
    { id: 3, kind: "tool", call_id: "read", name: "read_file", status: "ok" },
    { id: 4, kind: "text", text: "Found the cause", complete: false },
    { id: 5, kind: "thinking", text: "Implement", complete: true },
    { id: 6, kind: "marker", level: "note", text: "Batch: edit_file: view.ts" },
    { id: 7, kind: "tool", call_id: "edit", name: "edit_file", status: "running" },
  ];
  const before = JSON.stringify(blocks);
  const groups = (items) => items.filter((item) => item.kind === "work");
  assert.deepEqual(groups(phoneTranscriptItems(blocks.slice(0, 3))).map((item) => [item.id, item.current]), [[2, true]]);
  assert.deepEqual(groups(phoneTranscriptItems(blocks.slice(0, 4))).map((item) => [item.id, item.current]), [[2, false]], "The first text delta closes preceding work");
  const items = phoneTranscriptItems(blocks);
  assert.deepEqual(items.map((item) => [item.kind, item.id]), [["block", 1], ["work", 2], ["block", 4], ["work", 5]]);
  assert.deepEqual(groups(items).map((item) => [item.id, item.current, item.blocks.map((block) => block.id)]), [[2, false, [2, 3]], [5, true, [5, 6, 7]]]);
  assert.deepEqual(groups(items).map((item) => phoneWorkCounts(item.blocks).total), [1, 1], "Each card counts only its own phase");
  const updated = blocks.map((block) => block.id === 4 ? { ...block, text: "Found the cause; applying the fix", complete: true } : block.id === 7 ? { ...block, status: "ok" } : block);
  assert.deepEqual(phoneTranscriptItems(updated).map((item) => [item.kind, item.id]), items.map((item) => [item.kind, item.id]), "Streaming/status updates preserve disclosure keys");
  const finished = [...updated, { id: 8, kind: "text", text: "Done", complete: true }];
  assert.deepEqual(groups(phoneTranscriptItems(finished)).map((item) => item.current), [false, false]);
  assert.deepEqual(phoneTranscriptItems(finished).flatMap((item) => item.kind === "work" ? item.blocks : [item.block]), finished);
  assert.deepEqual(phoneTranscriptItems(blocks, false).map((item) => item.block), blocks, "Show all still renders rich tools in order");
  assert.equal(JSON.stringify(blocks), before, "Presentation never mutates canonical history");
});

test("phone guidance never joins or deduplicates across a Dext response", () => {
  const blocks = [
    { id: 1, kind: "marker", level: "warn", text: "bash advisory: use native tools" },
    { id: 2, kind: "text", text: "I will use native tools", complete: true },
    { id: 3, kind: "marker", level: "warn", text: "bash advisory: use native tools" },
    { id: 4, kind: "text", text: "Checked", complete: false },
  ];
  for (const compact of [true, false]) {
    const items = phoneTranscriptItems(blocks, compact);
    assert.deepEqual(items.map((item) => item.kind), ["work", "block", "work", "block"]);
    assert.deepEqual(items.filter((item) => item.kind === "work").map((item) => [item.id, item.current, phoneWorkRows(item.blocks)[0].count]), [[1, false, 1], [3, false, 1]]);
  }
});

test("phone work never moves later tools ahead of safety notices or artifacts", () => {
  const tool = (id) => ({ id, kind: "tool", call_id: `tool-${id}`, name: "read_file", status: "ok" });
  for (const boundary of [
    { kind: "marker", level: "warn", text: "Approval needed", auth: { tool: "read_file", message: "Sign in" } },
    { kind: "marker", level: "error", text: "Tool failed" },
    { kind: "marker", level: "warn", text: "Workspace policy warning" },
    { kind: "view", pack: "report", title: "Report", markdown: "Evidence" },
    { kind: "compact", status: "complete" },
    { kind: "user", text: "Change direction" },
  ]) {
    const blocks = [tool(1), { id: 2, ...boundary }, tool(3)];
    const items = phoneTranscriptItems(blocks);
    assert.deepEqual(items.map((item) => [item.kind, item.id]), [["work", 1], ["block", 2], ["work", 3]]);
    assert.deepEqual(items.filter((item) => item.kind === "work").map((item) => item.current), [false, true]);
    assert.deepEqual(items.flatMap((item) => item.kind === "work" ? item.blocks : [item.block]), blocks);
  }
  const failed = phoneTranscriptItems([tool(1), { id: 2, kind: "marker", level: "error", text: "Turn failed" }]);
  assert.equal(failed[0].current, true, "A trailing error can still label the latest work as failed");
  const prose = [{ id: 1, kind: "text", text: "One", complete: true }, { id: 2, kind: "text", text: "Two", complete: false }];
  assert.deepEqual(phoneTranscriptItems(prose).map((item) => item.block), prose, "Adjacent responses do not create empty cards");
});

test("phone phase identity survives runtime guidance inserted before live thinking", () => {
  const store = new SessionStore("phone-phase");
  const event = (event, data) => store.apply({ v: 1, session: store.state.id, event, ts: 100, data });
  event("user_message", { text: "Review the update" });
  event("turn_start", {});
  event("text_block_complete", "Checking the implementation.");
  event("thinking_delta", "Inspecting the renderer");
  const phase = phoneTranscriptItems(store.state.blocks).find((item) => item.kind === "work");
  event("warn", "runtime guidance: preserve the original order");
  const annotated = phoneTranscriptItems(store.state.blocks).find((item) => item.kind === "work");
  assert.equal(annotated.id, phase.id, "Annotations must not reset disclosure identity");
  assert.deepEqual(annotated.blocks.map((block) => block.kind), ["marker", "thinking"], "Canonical annotation order is preserved");
  assert.deepEqual(phoneTranscriptItems(store.state.blocks).flatMap((item) => item.kind === "work" ? item.blocks : [item.block]), store.state.blocks);
});

test("Show all and slash output close the preceding guidance phase", () => {
  const guidance = { id: 1, kind: "marker", level: "warn", text: "bash advisory: use native tools" };
  for (const block of [
    { id: 2, kind: "tool", call_id: "read", name: "read_file", status: "running" },
    { id: 2, kind: "thinking", text: "Checking", complete: false },
    { id: 2, kind: "slash", text: "Current settings", structured: true },
  ]) {
    const items = phoneTranscriptItems([guidance, block], false);
    assert.equal(items[0].current, false, `Visible ${block.kind} must not leave old guidance active`);
  }
});

test("phone phase status follows overlapping tool results without reviving historical work", () => {
  const store = new SessionStore("phone-status");
  const event = (event, data) => store.apply({ v: 1, session: store.state.id, event, ts: 100, data });
  const work = () => phoneTranscriptItems(store.state.blocks).filter((item) => item.kind === "work");
  const states = () => work().map((item) => phoneWorkState(item, store.state));
  event("user_message", { text: "Check the report" });
  event("turn_start", {});
  event("tool_call_start", { call_id: "parallel", name: "read_file", summary: "Check evidence" });
  event("text_delta", "The report is ready to review.");
  assert.equal(work()[0].current, false);
  assert.deepEqual(states(), ["working"], "A response cannot mark a still-running tool complete");
  event("text_block_complete", "The report is ready to review.");
  event("tool_call_start", { call_id: "next", name: "edit_file", summary: "Update report" });
  assert.deepEqual(states(), ["working", "working"], "Parallel phases can both contain active work");
  event("tool_call_result", { call_id: "parallel", name: "read_file", ok: false, content: "Evidence missing" });
  assert.deepEqual(states(), ["failed", "working"], "Failure belongs to its own phase, not the latest card");
  event("tool_call_result", { call_id: "next", name: "edit_file", ok: true, content: "Updated" });
  event("text_delta", "The update is complete.");
  assert.deepEqual(states(), ["failed", "complete"]);
  event("turn_end", { failed: false });
  assert.deepEqual(states(), ["failed", "complete"], "Recovery does not erase an earlier failed tool outcome");
  event("tool_call_preview", { call_id: "unstarted", name: "read_file", summary: "Unstarted preview" });
  event("user_message", { text: "Next request" });
  event("turn_start", {});
  assert.deepEqual(work().map((item) => item.currentTurn), [false, false, false]);
  assert.deepEqual(states(), ["failed", "complete", "complete"], "A new turn must not revive an old preview");
});

test("phone notes do not inherit unrelated session failures", () => {
  const session = { working: false, failed: true };
  const guidance = { id: 1, kind: "marker", level: "warn", text: "bash advisory: use native tools" };
  const group = (blocks, compact = true) => phoneTranscriptItems(blocks, compact).filter((item) => item.kind === "work").at(-1);
  assert.equal(phoneWorkState(group([guidance]), session), "complete", "A Bash tip is not failed execution");
  assert.equal(phoneWorkState(group([{ id: 2, kind: "marker", level: "warn", text: "runtime guidance: review the next step" }]), session), "complete");
  assert.equal(phoneWorkState(group([{ id: 3, kind: "marker", level: "warn", text: "Batch: 0 tool call(s) failed." }]), session), "complete");
  assert.equal(phoneWorkState(group([{ id: 4, kind: "marker", level: "warn", text: "Batch: 1 tool call(s) failed." }], false), { working: false, failed: false }), "failed", "An explicit batch failure remains a failed phase in Show all");
  const tool = { id: 5, kind: "tool", call_id: "check", name: "bash", status: "ok" };
  assert.equal(phoneWorkState(group([tool, { id: 6, kind: "marker", level: "error", text: "Turn failed" }]), session), "failed", "Unfinished execution can still inherit terminal failure");
  assert.equal(phoneWorkState(group([tool, { id: 6, kind: "text", text: "Done", complete: true }, guidance]), session), "complete", "Later guidance cannot take the preceding execution's failure");
});

test("terminal failure labels unfinished overlapping work, not later notes or historical previews", () => {
  const running = { id: 2, kind: "tool", call_id: "unfinished", name: "read_file", status: "running" };
  const blocks = [
    { id: 1, kind: "user", text: "Review" }, running,
    { id: 3, kind: "text", text: "Still checking", complete: true },
    { id: 4, kind: "marker", level: "warn", text: "runtime guidance: check remaining evidence" },
  ];
  const states = (source, session) => phoneTranscriptItems(source).filter((item) => item.kind === "work").map((item) => phoneWorkState(item, session));
  assert.deepEqual(states(blocks, { working: false, failed: true }), ["failed", "complete"]);
  assert.deepEqual(states(blocks, { working: false, failed: false }), ["complete", "complete"], "An interruption is not fabricated failure");
  assert.deepEqual(states([...blocks, { id: 5, kind: "user", text: "Next request" }], { working: false, failed: true }), ["complete", "complete"], "Another turn's failure cannot relabel historical running tools");
});

test("phone snapshot replay preserves phase order, counts and status", () => {
  const store = new SessionStore("phone-replay");
  const event = (event, data) => store.apply({ v: 1, session: store.state.id, event, ts: 100, data });
  event("user_message", { text: "Review" });
  event("turn_start", {});
  event("tool_call_start", { call_id: "first", name: "read_file", summary: "Read evidence" });
  event("tool_call_result", { call_id: "first", name: "read_file", ok: false, content: "Missing" });
  event("text_block_complete", "Checking another source.");
  event("thinking_delta", "Check source");
  event("warn", "runtime guidance: preserve evidence");
  event("tool_call_start", { call_id: "second", name: "http", summary: "Fetch source" });
  const describe = (compact) => phoneTranscriptItems(store.state.blocks, compact).map((item) => item.kind === "work"
    ? { kind: item.kind, blocks: item.blocks.map(({ id, ...block }) => block), counts: phoneWorkCounts(item.blocks), state: phoneWorkState(item, store.state) }
    : { kind: item.kind, block: (({ id, ...block }) => block)(item.block) });
  const before = [describe(true), describe(false)];
  const blocks = store.state.blocks.map(({ id, ...block }) => block);
  event("session.snapshot", { meta: { id: store.state.id, title: "Review", cwd: "/mock", status: "live" }, blocks, pending_permissions: [], last_seq: 1, working: true, failed: false });
  assert.deepEqual([describe(true), describe(false)], before, "Snapshot identities may change; presentation and outcomes must not");
});

test("phone grouping is lossless for generated boundary combinations and transcript windows", () => {
  const prototypes = [
    { kind: "user", text: "Request" },
    { kind: "text", text: "Reply", complete: false },
    { kind: "tool", name: "read_file", status: "running", summary: "Read" },
    { kind: "thinking", text: "Check", complete: false },
    { kind: "marker", level: "note", text: "Batch: read_file: evidence.md" },
    { kind: "marker", level: "warn", text: "bash advisory: use native tools" },
    { kind: "marker", level: "warn", text: "runtime guidance: review" },
    { kind: "marker", level: "error", text: "Batch: 1 tool call(s) failed." },
    { kind: "marker", level: "note", text: "Batch: read_file: sign in", auth: { tool: "read_file", message: "Sign in" } },
    { kind: "marker", level: "info", text: "Unfamiliar notice" },
    { kind: "slash", text: "Settings", structured: true },
    { kind: "view", pack: "report", title: "Report", markdown: "Evidence" },
    { kind: "compact", status: "running" },
  ];
  let seed = 0x51de;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let sample = 0; sample < 128; sample++) {
    const blocks = Object.freeze(Array.from({ length: 20 }, (_, index) => {
      const block = prototypes[next() % prototypes.length];
      return Object.freeze({ ...block, id: index + 1, ...(block.kind === "tool" ? { call_id: `call-${index}` } : {}) });
    }));
    for (const compact of [true, false]) for (const start of [0, 1, 9, 19]) {
      const window = blocks.slice(start);
      const items = phoneTranscriptItems(window, compact);
      assert.deepEqual(items.flatMap((item) => item.kind === "work" ? item.blocks : [item.block]), window);
      assert.equal(new Set(items.map((item) => item.id)).size, items.length, "Render keys must be unique");
      const work = items.filter((item) => item.kind === "work");
      assert.ok(work.filter((item) => item.current).length <= 1);
      for (const item of work) {
        assert.ok(item.blocks.length > 0);
        assert.ok(!item.current || item.currentTurn);
        const counts = phoneWorkCounts(item.blocks);
        assert.equal(counts.total, counts.passed + counts.failed + counts.running + counts.pending);
      }
    }
  }
});
