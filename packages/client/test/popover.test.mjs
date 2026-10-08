import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../../../apps/web/src/lib/popover.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
function geometry(width, height, anchor, popupWidth = 304) {
  const exports = {};
  vm.runInNewContext(outputText, { exports, window: { innerWidth: width, innerHeight: height }, matchMedia: () => ({ matches: width <= 900 }) });
  return exports.popoverPos(anchor, popupWidth);
}

test("desktop popovers clamp tall menus above and below their anchors", () => {
  for (const height of [180, 400, 900]) for (const anchor of [null, { top: 8, bottom: 36, right: 0 }, { top: height - 36, bottom: height - 8, right: 2000 }]) {
    const style = geometry(1280, height, anchor);
    const edge = Number(/(?:top|bottom):(\d+)px/.exec(style)[1]);
    const cap = Number(/max-height:(\d+)px/.exec(style)[1]);
    const right = Number(/right:(\d+)px/.exec(style)[1]);
    assert.ok(edge >= 8);
    assert.ok(edge + cap <= height - 8);
    assert.ok(cap >= 0 && cap <= 440);
    assert.ok(right >= 8 && right + 304 <= 1280 - 8);
    assert.ok(style.includes("overflow-y:auto"));
  }
});

test("phone popovers follow visible viewport and preserve every safe inset", () => {
  const style = geometry(375, 812, null);
  for (const variable of ["--safe-top", "--safe-left", "--safe-right", "--safe-bottom", "--mobile-viewport-top", "--mobile-viewport-height"]) assert.ok(style.includes(variable));
  assert.ok(style.includes("max-width:calc("));
  assert.ok(style.includes("max-height:max(0px"));
  assert.ok(style.includes("overflow-y:auto"));
});
