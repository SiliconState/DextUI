import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("../../../apps/web/src/ext/browser/policy.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { webAddress, loopbackAddress, previewCandidate, recentWebLinks } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("addresses: bare hosts get https, loopback gets http, credentials and odd schemes refused", () => {
  assert.equal(webAddress("example.com"), "https://example.com/");
  assert.equal(webAddress("  example.com/a?b=1  "), "https://example.com/a?b=1");
  assert.equal(webAddress("localhost:5173"), "http://localhost:5173/");
  assert.equal(webAddress("127.0.0.1:3000/app"), "http://127.0.0.1:3000/app");
  assert.equal(webAddress("http://example.com"), "http://example.com/");
  for (const bad of ["", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "https://u:p@example.com", "exa mple.com", "a\\b", "x".repeat(2049)]) {
    assert.throws(() => webAddress(bad), undefined, bad);
  }
});

test("preview is offered only for another loopback http port, and only when DextUI itself is loopback", () => {
  const app = "http://127.0.0.1:8788/";
  assert.equal(previewCandidate("http://localhost:5173/", app), true);
  assert.equal(previewCandidate("http://[::1]:3000/", app), true);
  assert.equal(previewCandidate("http://127.0.0.1:8788/", app), false, "never the control plane itself");
  assert.equal(previewCandidate("https://localhost:5173/", app), false);
  assert.equal(previewCandidate("http://example.com/", app), false);
  assert.equal(previewCandidate("http://localhost:5173/", "https://dext.example.test/"), false, "remote DextUI cannot see the host's loopback");
  assert.equal(loopbackAddress("http://localhost.evil.test/"), false);
});

test("recent links come from the latest prose only, trimmed and bounded", () => {
  const blocks = [
    { kind: "text", text: "old https://old.example.com" },
    ...Array.from({ length: 20 }, () => ({ kind: "tool", text: "https://tool.example.com" })),
    { kind: "user", text: "see (https://a.example.com/x)." },
    { kind: "text", text: "and https://b.example.com, plus javascript:alert(1) and https://u:p@c.example.com" },
  ];
  const links = recentWebLinks(blocks);
  assert.deepEqual(links, ["https://b.example.com/", "https://a.example.com/x", "https://old.example.com/"]);
  const many = [{ kind: "text", text: Array.from({ length: 20 }, (_, i) => `https://s${i}.example.com`).join(" ") }];
  assert.equal(recentWebLinks(many).length, 6);
});
