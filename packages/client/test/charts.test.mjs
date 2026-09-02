// charts.ts: strict spec parsing + safe SVG generation. These pin the security
// contract (every dynamic string escaped, no NaN coordinates, invalid specs
// rejected) and the shape of each chart type.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseChartSpec, renderChartSVG } from "../dist/index.js";

const BAR = { type: "bar", title: "Latency", labels: ["a", "b", "c"], values: [10, 20, -5], unit: "ms" };

test("parse: valid spec passes through, unknown type defaults to bar", () => {
  assert.deepStrictEqual(parseChartSpec(JSON.stringify(BAR)), BAR);
  assert.equal(parseChartSpec(JSON.stringify({ type: "scatter", values: [1] }))?.type, "bar");
});

test("parse: rejects junk JSON, non-objects, empty/oversized/non-numeric values, bad max", () => {
  assert.equal(parseChartSpec("not json"), null);
  assert.equal(parseChartSpec("[1,2,3]"), null);
  assert.equal(parseChartSpec("null"), null);
  assert.equal(parseChartSpec(JSON.stringify({ values: [] })), null);
  assert.equal(parseChartSpec(JSON.stringify({ values: Array.from({ length: 32 }, () => 1) })), null);
  assert.equal(parseChartSpec(JSON.stringify({ values: [1, "x", 3] })), null);
  assert.equal(parseChartSpec(JSON.stringify({ values: [1], max: -2 })), null);
  assert.equal(parseChartSpec('{"values":[1e999]}'), null, "Infinity is not finite");
});

test("parse: numeric strings coerce, labels truncate to values, title/unit bounded", () => {
  const s = parseChartSpec(JSON.stringify({ type: "line", values: ["1.5", 2], labels: ["a", "b", "c"], title: "t".repeat(200), unit: "u".repeat(50) }));
  assert.ok(s);
  assert.deepStrictEqual(s.values, [1.5, 2]);
  assert.equal(s.labels?.length, 2);
  assert.equal(s.title?.length, 120);
  assert.equal(s.unit?.length, 12);
});

test("bar: one rect per value, negatives rendered below baseline, value labels carry unit", () => {
  const svg = renderChartSVG(BAR);
  assert.equal((svg.match(/<rect /g) ?? []).length, 3);
  assert.ok(svg.includes("20ms"), "value label includes unit");
  assert.ok(svg.includes("Latency"), "title present");
  assert.ok(!svg.includes("NaN"), "no NaN coordinates");
});

test("labels are XML-escaped — injection via label/title/summary never survives", () => {
  const hostile = {
    type: "hbar",
    title: `</svg><script>alert(1)</script>`,
    labels: [`<img src=x onerror="al">`, `"&'`, "ok"],
    values: [1, 2, 3],
  };
  const svg = renderChartSVG(hostile);
  assert.ok(!svg.includes("<script"), "no raw script tag");
  assert.ok(!svg.includes("<img "), "no raw img tag");
  assert.ok(svg.includes("&lt;img"), "label escaped");
  assert.ok(svg.includes("&quot;&amp;&#39;"), "quotes/ampersand escaped");
});

test("line: polyline + one dot per point, survives all-negative data", () => {
  const svg = renderChartSVG({ type: "line", labels: ["m", "t", "w"], values: [-3, -1, -2] });
  assert.equal((svg.match(/<polyline /g) ?? []).length, 1);
  assert.equal((svg.match(/<circle /g) ?? []).length, 3);
  assert.ok(!svg.includes("NaN"));
});

test("spark: compact, no axes/labels, ends with a dot", () => {
  const svg = renderChartSVG({ type: "spark", values: [1, 2, 3, 2] });
  assert.ok(svg.startsWith(`<svg viewBox="0 0 560 48"`));
  assert.ok(!svg.includes("<text"), "no axis labels on a sparkline");
  assert.equal((svg.match(/<circle /g) ?? []).length, 1);
});

test("donut: slices sum to the full circumference, legend shows percentages", () => {
  const svg = renderChartSVG({ type: "donut", labels: ["x", "y"], values: [3, 1] });
  const dashes = [...svg.matchAll(/stroke-dasharray="([\d.]+) /g)].map((m) => Number(m[1]));
  const C = 2 * Math.PI * 58;
  assert.equal(dashes.length, 2);
  assert.ok(Math.abs(dashes.reduce((a, b) => a + b, 0) - C) < 0.5, "slices cover the ring");
  assert.ok(svg.includes("75%") && svg.includes("25%"));
});

test("hbar: track + fill per row, negative values colored but still sized by magnitude", () => {
  const svg = renderChartSVG({ type: "hbar", labels: ["p", "n"], values: [8, -2], unit: "GiB" });
  assert.equal((svg.match(/<rect /g) ?? []).length, 4, "track + fill per row");
  assert.ok(svg.includes("8GiB") && svg.includes("-2GiB"));
});

test("max override rescales bars without touching labels", () => {
  const scaled = renderChartSVG({ type: "bar", values: [5], max: 100 });
  const unscaled = renderChartSVG({ type: "bar", values: [5] });
  assert.ok(scaled !== unscaled);
  assert.ok(scaled.includes("5") && !scaled.includes("NaN"));
});
