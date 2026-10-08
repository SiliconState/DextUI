import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
const source = fs.readFileSync(new URL("../../../apps/web/src/lib/session-header.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { headerStatus, headerContext, headerModel } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
const view = (patch = {}) => ({ blocks: [], pending: new Map(), uiProgress: new Map(), working: false, compacting: false, failed: false, status: "live", ...patch });
test("saved theme sets browser chrome before mount for phone and desktop", () => {
  const html = fs.readFileSync(new URL("../../../apps/web/index.html", import.meta.url), "utf8");
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.ok(html.indexOf('media="(prefers-color-scheme: dark)"') < html.indexOf("<script>"));
  const palettes = { light: ["#f4f2ec", "#ebe9e1"], dim: ["#1b1f27", "#21262f"], dark: ["#0b0d10", "#11141a"] };
  for (const mobile of [false, true]) for (const osDark of [false, true]) for (const saved of [null, "system", "invalid", "light", "dim", "dark"]) {
    const metas = [{ content: "default" }, { content: "default-dark" }];
    const root = { dataset: {} };
    vm.runInNewContext(script, {
      localStorage: { getItem: () => saved },
      matchMedia: query => ({ matches: query.includes("max-width") ? mobile : osDark }),
      document: { documentElement: root, querySelectorAll: () => metas },
    });
    const expected = palettes[saved] ? saved : osDark ? "dark" : "light";
    assert.equal(root.dataset.theme, expected);
    assert.ok(metas.every(meta => meta.content === palettes[expected][mobile ? 1 : 0]));
  }
});

test("header attention and actual lifecycle take priority over old answers", () => {
  assert.equal(headerStatus(null, "live").label, "Idle");
  assert.equal(headerStatus(view(), "failed").label, "Offline");
  const blocks = [{ kind: "text", text: "old", complete: true }, { kind: "user", text: "new" }];
  assert.equal(headerStatus(view({ blocks }), "live").label, "Idle");
  assert.equal(headerStatus(view({ blocks, working: true }), "live").label, "Active");
  assert.equal(headerStatus(view({ working: true, pending: new Map([["a", { summary: "Approve action" }]]) }), "live").label, "Needs input");
  assert.equal(headerStatus(view({ failed: true }), "live").target, "error");
  assert.equal(headerStatus(view({ failed: true, compacting: true }), "live").label, "Active");
  assert.equal(headerStatus(view({ blocks: [{ kind: "text", complete: true }] }), "live").label, "Idle");
  assert.equal(headerStatus(view({ blocks: [{ kind: "marker", text: "Interrupted." }] }), "live").label, "Idle");
  assert.equal(headerStatus(view({ status: "cold", blocks: [{ kind: "text", complete: true }] }), "live").label, "Offline");
  assert.equal(headerStatus(view({ blocks: [{ kind: "text", complete: true }] }), "live").tone, "neutral");
  assert.equal(headerStatus(view({ failed: true }), "live").label, "Error");
  assert.equal(headerStatus(view({ pendingUi: { params: { title: "Answer form" } } }), "live").label, "Needs input");
});
test("compact header reports the selected model and effort, not a generic Model label", () => {
  assert.equal(headerModel("claude-opus-4-6", "xhigh").model, "Opus 4.6");
  assert.equal(headerModel("gpt-6.1-sol", "high").model, "GPT 6.1");
  assert.equal(headerModel("gpt-5.3-codex", "max").model, "GPT 5.3 C");
  assert.equal(headerModel(undefined, undefined).model, "Unknown");
  assert.equal(headerModel(undefined, undefined).effort, "Unknown");
  assert.equal(headerModel("mock-model-with-a-long-name", "medium").model, "mock model");
});
test("one-line header aliases bound unbroken names and preserve effort levels", () => {
  const model = "ExtremelyLongUnbrokenModelIdentifier";
  const compact = headerModel(model, "medium");
  assert.ok(compact.model.length <= 13);
  assert.ok(compact.model.endsWith("…"));
  assert.equal(compact.shortEffort, "Med");
  assert.equal(headerModel("claude-opus-4-6", "xhigh").shortModel, "Opus");
  assert.equal(headerModel("claude-sonnet-4-5", "minimal").shortEffort, "Min");
  assert.equal(headerModel(undefined, undefined).shortModel, "?");
  assert.equal(headerModel(undefined, undefined).shortEffort, "?");
  const tones = ["low", "medium", "high", "xhigh", "max"].map(effort => headerModel("gpt-6.1-sol", effort).effortTone);
  assert.equal(new Set(tones).size, tones.length);
  assert.equal(headerModel("gpt-6.1-sol", "off").effortTone, "var(--dim)");
  assert.equal(headerModel("gpt-6.1-sol", "unsupported").effortTone, "var(--dim)");
  for (const key of ["constructor", "toString", "__proto__"]) assert.equal(headerModel("gpt-6.1-sol", key).effortTone, "var(--dim)");
  assert.equal(headerModel("  claude-opus-4-6  ", "high").model, "Opus 4.6");
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
