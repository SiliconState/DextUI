import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const compile = (name) => ts.transpileModule(fs.readFileSync(new URL(`../../../apps/web/src/lib/${name}.ts`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const display = `data:text/javascript;base64,${Buffer.from(compile("display")).toString("base64")}`;
const source = compile("transcript-groups").replace('"./display"', JSON.stringify(display));
const { transcriptItems } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

test("desktop grouping never folds warnings or authentication as work metadata", () => {
  for (const text of ["[phase:verify] Sign in", "[objective: Sign in | checkpoints: review]", "Batch: read_file: sign in"]) {
    for (const marker of [
      { id: 1, kind: "marker", level: "warn", text },
      { id: 1, kind: "marker", level: "error", text },
      { id: 1, kind: "marker", level: "note", text, auth: { tool: "read_file", message: "Sign in" } },
    ]) {
      const tool = { id: 2, kind: "tool", name: "read_file", call_id: "a", summary: "Read evidence", status: "ok" };
      const [first] = transcriptItems([marker, tool]);
      assert.equal(first.kind, "block");
      assert.equal(first.block, marker);
    }
  }
});
