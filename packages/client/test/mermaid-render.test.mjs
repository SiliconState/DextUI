import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function renderer() {
  const root = {
    localName: "svg", namespaceURI: "http://www.w3.org/2000/svg", attributes: [],
    querySelectorAll: () => [],
    getAttribute: key => key === "viewBox" ? "0 0 100 60" : null,
    setAttribute: () => {},
  };
  let calls = 0;
  let active = 0;
  let peak = 0;
  let reject = false;
  let release;
  let svg = "<svg/>";
  let gate = Promise.resolve();
  const mermaid = {
    initialize: () => {},
    render: async () => {
      calls++; active++; peak = Math.max(peak, active);
      try { await gate; if (reject) throw new Error("invalid"); return { svg }; }
      finally { active--; }
    },
  };
  const modules = {};
  const context = {
    exports: modules,
    require: name => {
      if (name === "mermaid") return { default: mermaid };
      if (name === "dompurify") return { default: { sanitize: text => text } };
      if (name === "./mermaid-policy") return { diagramIssue: () => null, MERMAID_EDGE_LIMIT: 160, MERMAID_SOURCE_LIMIT: 16384, MERMAID_SVG_LIMIT: 1048576 };
      if (name === "./mermaid-svg") return { unsafeDiagramCss: () => false, svgDimensions: () => ({ width: 100, height: 60 }) };
      throw new Error(name);
    },
    TextEncoder,
    document: { createElement: () => ({ setAttribute: () => {}, style: {}, remove: () => {} }), body: { appendChild: () => {} }, getElementById: () => null },
    DOMParser: class { parseFromString() { return { documentElement: root, querySelector: () => null }; } },
    XMLSerializer: class { serializeToString() { return "<svg/>"; } },
  };
  const source = fs.readFileSync(new URL("../../../apps/web/src/lib/mermaid-render.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  vm.runInNewContext(outputText, context);
  const palette = { background: "#fff", surface: "#eee", text: "#111", border: "#222", accent: "#333", line: "#444", dark: false };
  const run = (text, wanted = () => true, scope = 0) => modules.renderDiagram(text, palette, wanted, scope);
  return { ...modules, run, calls: () => calls, peak: () => peak, block: () => { gate = new Promise(resolve => { release = resolve; }); }, release: () => release(), reject: value => { reject = value; }, svg: value => { svg = value; } };
}

test("diagram jobs serialize, reuse cached content, and recover after a failure", async () => {
  const r = renderer();
  const [a, b] = await Promise.all([r.run("a"), r.run("a")]);
  assert.ok(a && b);
  assert.equal(r.calls(), 1);
  await Promise.all([r.run("b"), r.run("c")]);
  assert.equal(r.peak(), 1);
  r.reject(true);
  await assert.rejects(r.run("bad"), /invalid/);
  r.reject(false);
  assert.ok(await r.run("good"));
});

test("same-scope cache clear fences in-flight and queued jobs", async () => {
  const r = renderer(); r.block();
  const a = r.run("a"), b = r.run("b");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.calls(), 1);
  r.clearDiagramCache(0); r.release();
  assert.equal(await a, null);
  assert.equal(await b, null);
  assert.equal(r.calls(), 1);
  assert.ok(await r.run("a"));
  assert.equal(r.calls(), 2, "cleared job must not have repopulated cache");
});

test("late stale scopes cannot reset cache backward or cancel new work", async () => {
  const r = renderer();
  r.clearDiagramCache(2);
  assert.ok(await r.run("current", () => true, 2));
  const before = r.calls();
  assert.equal(await r.run("old", () => true, 1), null);
  assert.ok(await r.run("current", () => true, 2));
  assert.equal(r.calls(), before);
  assert.equal(await r.run("gone", () => false, 2), null);
});

test("diagram output budgets count UTF-8 bytes, not only JS code units", async () => {
  const r = renderer();
  r.svg("漢".repeat(400000));
  await assert.rejects(r.run("large-unicode"), /output exceeds/);
  r.svg("<svg/>");
  assert.ok(await r.run("small"));
});

test("diagram render cache evicts bounded old entries", async () => {
  const r = renderer();
  for (let i = 0; i < 13; i++) await r.run(`sample-${i}`);
  const before = r.calls();
  await r.run("sample-12");
  assert.equal(r.calls(), before);
  await r.run("sample-0");
  assert.equal(r.calls(), before + 1);
});
