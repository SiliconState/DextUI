import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("../../../apps/web/src/lib/display.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { isBashAdvisory, humanizeTool } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("bash advisory disclosure detection stays scoped to backend marker prefixes", () => {
  assert.equal(isBashAdvisory("bash advisory: prefer native rg"), true);
  assert.equal(isBashAdvisory("[runtime-note] bash advisory: first line\nmore details"), true);
  assert.equal(isBashAdvisory("We discussed a bash advisory: earlier"), false);
  assert.equal(isBashAdvisory("runtime guidance: other warning"), false);
  assert.equal(isBashAdvisory("bash advisory:"), false);
});

test("tool label cleanup leaves commands and distinct tool names intact", () => {
  assert.equal(humanizeTool("read_file", "read_file: read_file: /tmp/example"), "Read /tmp/example");
  assert.equal(humanizeTool("bash", "printf 'read_file: x'"), "printf 'read_file: x'");
  assert.equal(humanizeTool("read_file", "read_file_extra: x"), "read_file_extra: x");
});
