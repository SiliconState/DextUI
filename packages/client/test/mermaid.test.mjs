import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const load = async (name, rewrite = s => s) => {
  const source = rewrite(fs.readFileSync(new URL(`../../../apps/web/src/lib/${name}.ts`, import.meta.url), "utf8"));
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
};
const { diagramIssue, diagramScale, diagramSourceForWidth } = await load("mermaid-policy");
const { unsafeDiagramCss, svgDimensions } = await load("mermaid-svg");
const { parseMarkdown } = await load("markdown", s => s.replace('import { parseChartSpec, type ChartSpec } from "@dextui/client";', 'const parseChartSpec = () => null; type ChartSpec = unknown;'));

const flow = "flowchart LR\n  A[Any browser] --> B[HTTPS + login]\n  B --> C[DextUI host]\n  C --> D[dext agent]\n  C --> E[Saved state]";

test("Mermaid fences preserve exact source and distinguish streaming from closed", () => {
  const blocks = parseMarkdown(`Before\n\n\`\`\`mermaid\n${flow}\n\`\`\`\n\nAfter`);
  assert.deepEqual(blocks.map(b => b.kind), ["para", "mermaid", "para"]);
  assert.deepEqual(blocks[1], { kind: "mermaid", text: flow, closed: true });
  assert.deepEqual(parseMarkdown(`\`\`\`MERMAID\n${flow}`), [{ kind: "mermaid", text: flow, closed: false }]);
  assert.equal(parseMarkdown(`\`\`\`text\n\`\`\`mermaid\n${flow}\n\`\`\``)[0].kind, "code");
  assert.equal(parseMarkdown(`> \`\`\`mermaid\n> ${flow.split("\n")[0]}\n> \`\`\``)[0].kind, "quote");
  assert.ok(!parseMarkdown(`    \`\`\`mermaid\n    flowchart LR\n    A-->B\n    \`\`\``).some(b => b.kind === "mermaid"));
  assert.deepEqual(parseMarkdown(`~~~mermaid\n${flow}\n~~~`)[0], { kind: "mermaid", text: flow, closed: true });
  assert.deepEqual(parseMarkdown(`  \`\`\`\`mermaid\n${flow}\n  \`\`\`\``)[0], { kind: "mermaid", text: flow, closed: true });
  assert.equal(parseMarkdown(`\`\`\`\`mermaid\n${flow}\n\`\`\``)[0].closed, false);
  assert.equal(parseMarkdown(`\`\`\`mermaid\r\n${flow.replaceAll("\n", "\r\n")}\r\n\`\`\`\r\n`)[0].closed, true);
});

test("list/quote diagram examples stay code rather than turning into diagrams", () => {
  for (const markdown of [
    `- Example\n\n  \`\`\`mermaid\n  flowchart LR\n  A-->B\n  \`\`\``,
    `1. Example\n   ~~~mermaid\n   flowchart LR\n   A-->B\n   ~~~`,
    `- \`\`\`mermaid\n  flowchart LR\n  A-->B\n  \`\`\``,
    `- \`\`\`text\n  example\n  \`\`\``,
    `> Example\n  \`\`\`mermaid\n  flowchart LR\n  A-->B\n  \`\`\``,
  ]) {
    assert.ok(!parseMarkdown(markdown).some(block => block.kind === "mermaid"), markdown);
    const followed = `${markdown}\n\n\`\`\`mermaid\n${flow}\n\`\`\``;
    assert.equal(parseMarkdown(followed).filter(block => block.kind === "mermaid").length, 1, "nested example must not swallow the following top-level diagram");
  }
  const topLevel = `- Example\n\n\`\`\`mermaid\n${flow}\n\`\`\``;
  assert.equal(parseMarkdown(topLevel).filter(block => block.kind === "mermaid").length, 1);
});

test("fence info strings preserve code and following prose", () => {
  for (const marker of ["```", "~~~", "````"]) {
    const blocks = parseMarkdown(`${marker}js title="sample"\nconst x = 1;\n${marker}\n\nAfter`);
    assert.deepEqual(blocks, [{ kind: "code", lang: "js", text: "const x = 1;" }, { kind: "para", inline: [{ t: "text", s: "After" }] }]);
  }
});

test("nested unclosed fences stop at their container and do not swallow later output", () => {
  for (const indent of ["  ", "    "]) {
    const blocks = parseMarkdown(`- Example\n${indent}\`\`\`mermaid\n${indent}flowchart LR\n${indent}A-->B\n\nOutside\n\n\`\`\`mermaid\n${flow}\n\`\`\``);
    assert.equal(blocks.filter(b => b.kind === "mermaid").length, 1);
    assert.ok(blocks.some(b => b.kind === "para" && b.inline.some(t => t.s === "Outside")));
  }
  assert.equal(parseMarkdown(`> Example\n\`\`\`mermaid\n${flow}\n\`\`\``).at(-1).kind, "mermaid", "fenced blocks cannot lazily continue a blockquote");
});

test("inline list examples retain ordering relative to following list items", () => {
  const blocks = parseMarkdown('- ```js title="sample"\n  const first = 1;\n  ```\n- Then second');
  assert.deepEqual(blocks.map(b => b.kind), ["list", "code", "list"]);
  assert.equal(blocks[1].text, "  const first = 1;");
  assert.equal(blocks[2].items[0].inline[0].s, "Then second");
});

test("pre-render policy rejects escaped CSS and C4 styling/attribute paths", () => {
  for (const source of [
    'C4Context\nPerson(a,"A")\nUpdateElementStyle(a,"red","blue")',
    'C4Context\nPerson(a,"A") UpdateElementStyle(a,"red","blue")',
    'treemap-beta\nclass emphasis fill:red',
    'C4Context\nPerson(a,"A")\nUpdateRelStyle(a,b,"red")',
    'C4Context\nUpdateLayoutConfig(999999,999999)',
    'C4Context\nPerson(a,"A",$bgColor="red")',
    "C4Context\nPerson(a,\"A\",$ bgColor =\"image-set('/blocked.svg' 1x)\")",
    'C4Context\nPerson(a,"A",$bgColor="u\\72l(/blocked-paint.svg)")',
    'flowchart LR\nA["u\\rl(/blocked-paint.svg)"]',
  ]) assert.ok(diagramIssue(source), source);
});

test("plain Mermaid supports session flowcharts, sequences, states and subgraphs", () => {
  for (const text of [flow, "flowchart TD\nsubgraph Web\n A[UI] --> B[Host]\nend", "sequenceDiagram\nparticipant A as Phone\nA->>B: Hello\nB-->>A: Done", "stateDiagram-v2\n[*] --> Idle\nIdle --> Active: Message\nActive --> [*]", "classDiagram\nA <|-- B", "erDiagram\nA ||--o{ B : owns"]) assert.equal(diagramIssue(text), null, text);
});

test("diagram input rejects config injection, actions, external resources and encoded markup", () => {
  for (const text of [
    '%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\nA-->B',
    '---\nconfig:\n securityLevel: loose\n---\nflowchart LR\nA-->B',
    'flowchart LR\nA-->B; click A "https://example.com"',
    'flowchart LR\nstyle A fill:red',
    'flowchart LR\nclassDef x fill:red',
    'flowchart LR\nA[<img src=x onerror=alert(1)>]',
    'flowchart LR\nA[&#60;img&#62;]',
    'flowchart LR\nA[#60;img#62;]',
    'flowchart LR\nA@{img: "https://example.com/image.png"}',
    'flowchart LR\nA@{icon: "fa:user"}',
    'flowchart LR\nA[url(https://example.com)]',
    'flowchart LR\nA[$$x^2$$]',
    'flowchart LR\nA[\u0000]',
    'flowchart LR\nA@{ "img": "/relative-resource.png" }',
    'flowchart LR\nA@{ "\\\\u0069mg": "/relative-resource.png" }',
    'flowchart LR\nA@{ img : //example.com/image }',
    'sequenceDiagram\nparticipant A@{ "icon": "/relative-resource.svg" }',
    'sequenceDiagram\nproperties A: {"icon":"/relative-resource.svg"}',
    'sequenceDiagram\nlinks A: {"click":"/relative-route"}',
    'mindmap\n root\n  child::icon(fa fa-user)',
    'flowchart LR\rA-->B\rclick A callback',
    'flowchart LR\rA-->B\rstyle A fill:red',
  ]) assert.ok(diagramIssue(text), text);
});

test("phone vertical fit changes only horizontal orientation and never the source", () => {
  assert.equal(diagramSourceForWidth(flow, false), flow);
  assert.equal(diagramSourceForWidth(flow, true), flow.replace("flowchart LR", "flowchart TD"));
  assert.equal(diagramSourceForWidth("%% Context\n graph RL; A[graph LR] --> B", true), "%% Context\n graph BT; A[graph LR] --> B");
  assert.equal(diagramSourceForWidth("%% Context\rgraph LR\rA-->B", true), "%% Context\rgraph TD\rA-->B");
  for (const text of ["flowchart TD\nA-->B", "sequenceDiagram\nA->>B: flowchart LR", "stateDiagram-v2\nIdle-->Active", "flowchart LRwrong\nA-->B"]) assert.equal(diagramSourceForWidth(text, true), text);
});

test("SVG checks retain quoted fragment paints but reject external or escaped CSS", () => {
  for (const css of ["fill:#abc", "marker-end:url(#arrow)", 'filter:url("#shadow")', "clip-path:url( '#clip' )", "marker-start:url(#a);marker-end:url('#b')"]) assert.equal(unsafeDiagramCss(css), false, css);
  for (const css of ["url(/relative.svg)", "url(https://example.com/x)", "url( //example.com/x )", "url(data:image/svg+xml,x)", "@import 'x'", "@font-face{}", "u\\\\72l(/relative)", "image-set('/relative' 1x)", "url( '#local' ) url('/remote')"]) assert.equal(unsafeDiagramCss(css), true, css);
});

test("SVG viewBox and raster area are finite and bounded", () => {
  assert.deepEqual(svgDimensions("0 0 200 100", null, null), { width: 200, height: 100 });
  assert.deepEqual(svgDimensions("-5,-2,200,100", "100%", null), { width: 200, height: 100 });
  assert.deepEqual(svgDimensions(null, "200", "100"), { width: 200, height: 100 });
  for (const box of ["", "0 0 200", "0 0 200 100 2", "0 0 NaN 100", "0 0 Infinity 100", "0 0 -2 100", "0 0 0 100", "0 0 20001 20", "0 0 5000 5000"]) assert.throws(() => svgDimensions(box, null, null), Error, box);
  assert.throws(() => svgDimensions(null, "100%", "100"));
});

test("diagram display bounds reject oversized sources/lines/graphs before engine download", () => {
  assert.ok(diagramIssue("x".repeat(16385)));
  assert.ok(diagramIssue("漢".repeat(6000)));
  assert.ok(diagramIssue("flowchart LR\n" + "A\n".repeat(257)));
  assert.ok(diagramIssue("flowchart LR\r" + "A\r".repeat(257)));
  assert.ok(diagramIssue("flowchart LR\n" + "A-->B\n".repeat(161)));
  assert.ok(diagramIssue("  "));
  assert.ok(diagramIssue("flowchart LR;" + "A;".repeat(300)));
  assert.ok(diagramIssue("flowchart LR;" + "A&".repeat(401)));
  const scale = diagramScale(1200, 600, 296, 420);
  assert.ok(scale > 0 && scale <= 1);
  assert.ok(1200 * scale <= 272);
  assert.ok(600 * scale <= 420);
  assert.equal(diagramScale(100, 100, 500, 420), 1);
});
