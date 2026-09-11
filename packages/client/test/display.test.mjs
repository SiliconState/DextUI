import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("../../../apps/web/src/lib/display.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { activityVerb, isBashAdvisory, humanizeTool, looksLikeDiff, toolStatusDisplay } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("activity verbs use present-progressive while active and past tense when settled", () => {
  for (const [kind, names, active, settled] of [
    ["read", ["read_file", "git_diff"], "Inspecting", "Inspected"],
    ["read", ["rg", "fd"], "Searching", "Searched"],
    ["web", ["http"], "Browsing web", "Browsed web"],
    ["image", ["read_image"], "Viewing image", "Viewed image"],
    ["edit", ["git_commit"], "Committing", "Committed"],
    ["edit", ["write_file"], "Writing", "Wrote"],
    ["edit", ["todo_write"], "Updating tasks", "Updated tasks"],
    ["edit", ["edit_file", "multi_edit"], "Editing", "Changed"],
    ["mixed", ["read_file", "write_file"], "Reviewing + editing", "Reviewed + changed"],
  ]) {
    assert.equal(activityVerb(kind, names, true), active);
    assert.equal(activityVerb(kind, names, false), settled);
  }
});

test("bash advisory disclosure detection stays scoped to backend marker prefixes", () => {
  assert.equal(isBashAdvisory("bash advisory: prefer native rg"), true);
  assert.equal(isBashAdvisory("[runtime-note] bash advisory: first line\nmore details"), true);
  assert.equal(isBashAdvisory("We discussed a bash advisory: earlier"), false);
  assert.equal(isBashAdvisory("runtime guidance: other warning"), false);
  assert.equal(isBashAdvisory("bash advisory:"), false);
});

test("bash output wrappers and ordinary section headings are not diffs", () => {
  const output = "exit: 0\n--- stdout ---\n✓ 197 modules transformed.\n✓ built in 1.46s\n--- stderr ---\n";
  assert.equal(looksLikeDiff(output), false);
  assert.equal(looksLikeDiff("--- stderr ---\ncommand failed\n"), false);
  assert.equal(looksLikeDiff("--- Results ---\nall checks passed"), false);
  assert.equal(looksLikeDiff("+++ Ready\n@@ status\ndiff --git mentioned in prose"), false);
  const longOutput = `exit: 0\n--- stdout ---\n${Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")}\n--- stderr ---\n`;
  assert.equal(looksLikeDiff(longOutput), false, "long bash output must use the eight-line preview path");
});

test("unified file headers and genuine hunks retain diff rendering", () => {
  assert.equal(looksLikeDiff("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new"), true);
  assert.equal(looksLikeDiff("--- old.txt\n+++ new.txt\n-old\n+new"), true);
  assert.equal(looksLikeDiff("--- /dev/null\r\n+++ b/new.txt\r\n@@ -0,0 +1 @@\r\n+new"), true);
  assert.equal(looksLikeDiff("@@ -4 +4 @@ function example\n-old\n+new"), true);
  assert.equal(looksLikeDiff("@@ -1,2 +1,3 @@\n context\n+new"), true);
});

test("image tool statuses distinguish provider, conversion, turn, and stale-file failures", () => {
  assert.deepEqual(toolStatusDisplay("read_image", "ok", "approved image"), { label: "✓ image → context", className: "st-green" });
  assert.deepEqual(toolStatusDisplay("read_image", "failed", "the active model 'x' does not advertise image input"), { label: "⚠ vision unavailable", className: "st-yellow" });
  assert.deepEqual(toolStatusDisplay("read_image", "failed", "read_image allows at most two successful images per user turn"), { label: "⚠ image turn limit", className: "st-yellow" });
  assert.deepEqual(toolStatusDisplay("read_image", "failed", "source changed since read_image approval"), { label: "⚠ image changed", className: "st-yellow" });
  assert.deepEqual(toolStatusDisplay("read_image", "failed", "image has 50000000 decoded pixels, exceeding the 40000000 pixel limit"), { label: "⚠ conversion needed", className: "st-yellow" });
  assert.deepEqual(toolStatusDisplay("bash", "failed", "unsupported image format"), { label: "✗ failed", className: "st-red" });
});
test("tool label cleanup leaves commands and distinct tool names intact", () => {
  assert.equal(humanizeTool("read_file", "read_file: read_file: /tmp/example"), "Read /tmp/example");
  assert.equal(humanizeTool("read_image", "read_image: uploads/screen.png (pixels will be sent to the model provider)"), "Inspect image uploads/screen.png");
  assert.equal(humanizeTool("bash", "printf 'read_file: x'"), "printf 'read_file: x'");
  assert.equal(humanizeTool("read_file", "read_file_extra: x"), "read_file_extra: x");
});
