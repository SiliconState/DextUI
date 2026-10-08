import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
const source = fs.readFileSync(new URL("../../../apps/web/src/lib/session-header.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { headerStatus, headerContext } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
const view = (patch = {}) => ({ blocks: [], pending: new Map(), uiProgress: new Map(), working: false, compacting: false, failed: false, status: "live", ...patch });
test("header attention and actual lifecycle take priority over old answers", () => {
  assert.equal(headerStatus(null, "live").label, "Idle");
  assert.equal(headerStatus(view(), "failed").label, "Offline");
  const blocks = [{ kind: "text", text: "old", complete: true }, { kind: "user", text: "new" }];
  assert.equal(headerStatus(view({ blocks }), "live").label, "Idle");
  assert.equal(headerStatus(view({ blocks, working: true }), "live").label, "Working");
  assert.equal(headerStatus(view({ working: true, pending: new Map([["a", { summary: "Approve action" }]]) }), "live").label, "Review");
  assert.equal(headerStatus(view({ failed: true }), "live").target, "error");
  assert.equal(headerStatus(view({ failed: true, compacting: true }), "live").label, "Working");
  assert.equal(headerStatus(view({ blocks: [{ kind: "text", complete: true }] }), "live").label, "Done");
  assert.equal(headerStatus(view({ blocks: [{ kind: "marker", text: "Interrupted." }] }), "live").label, "Stopped");
  assert.equal(headerStatus(view({ status: "cold", blocks: [{ kind: "text", complete: true }] }), "live").label, "Closed");
});
test("header never fabricates step totals; only valid progress measurements are shown", () => {
  const tool = { kind: "tool", status: "running", summary: "Rebuilding report", name: "bash" };
  const state = view({ working: true, blocks: [tool] });
  assert.equal(headerStatus(state, "live").step, "Rebuilding report");
  assert.equal(headerStatus(state, "live").progress, undefined);
  state.uiProgress.set("a", { params: { state: "running", title: "Report", message: "Rebuilding report", current: 5, total: 8 } });
  assert.equal(headerStatus(state, "live").step, "5 of 8 · Rebuilding report");
  for (const total of [0, -1, NaN, Infinity, 2]) {
    state.uiProgress.set("a", { params: { state: "running", title: "Report", current: 5, total } });
    assert.equal(headerStatus(state, "live").progress, undefined);
  }
  assert.equal(headerStatus(view({ backgroundCompaction: { phase: "running" } }), "live").busy, false);
});
test("header context distinguishes unavailable from zero and validates window/estimates", () => {
  assert.equal(headerContext(null).pct, undefined);
  assert.equal(headerContext(view({ contextTokens: 0 })).pct, 0);
  assert.equal(headerContext(view({ contextTokens: 25000, diagnostics: { context_window: 100000 } })).pct, 25);
  assert.equal(headerContext(view({ contextChars: 100000 })).used, 25000);
  assert.equal(headerContext(view({ contextTokens: Infinity })).pct, undefined);
  assert.equal(headerContext(view({ contextTokens: -1 })).pct, undefined);
  assert.equal(headerContext(view({ contextTokens: 500000 })).pct, 100);
  assert.equal(headerContext(view({ diagnostics: { context_window: -1 } })).window, 200000);
});
