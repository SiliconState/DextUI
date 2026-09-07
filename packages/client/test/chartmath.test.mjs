// chartmath.ts: the pure hit-testing / scale / gesture math behind the
// interactive chart component. Each test pins a bug the first cut shipped:
// hover resolving the wrong sorted bar, pan compressing at the data edge,
// wheel zoom escaping the window, hbar drags flipping sign.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PLOT,
  HBAR,
  computeScale,
  scaleY,
  valueAtY,
  lineIndexAtX,
  lineX,
  sparkX,
  sparkIndexAtX,
  barX,
  hbarRowAtY,
  hbarValueAtX,
  sortOrder,
  panWindow,
  wheelZoom,
  seriesStats,
  donutRows,
  clampTip,
  barGroupLayout,
  barGroupHitAtX,
} from "../dist/index.js";

test("scale: baseline never above 0, max override pins the top, degenerate data still spans", () => {
  const s = computeScale([[3, 8, 5]], 3, null);
  assert.equal(s.lo, 0);
  assert.equal(s.hi, 8);
  assert.equal(computeScale([[3, 8]], 2, null, 100).hi, 100);
  const flat = computeScale([[0, 0]], 2, null);
  assert.ok(flat.hi > flat.lo, "flat data gets a non-zero span");
  assert.ok(computeScale([], 0, null).hi > 0, "no visible series still scales");
});

test("scale: zoom window only considers samples inside it", () => {
  const s = computeScale([[1, 100, 1, 1]], 4, [2, 3]);
  assert.equal(s.hi, 1, "the 100 outside the window does not set the scale");
});

test("y mapping round-trips and extrapolates above the plot during a drag", () => {
  const s = computeScale([[10]], 1, null);
  assert.ok(Math.abs(valueAtY(s, scaleY(s, 7)) - 7) < 1e-9);
  assert.ok(valueAtY(s, PLOT.top - 40) > s.hi, "dragging above the frame yields a value past the frozen max");
});

test("bar hit-test honors the sort permutation and slot geometry", () => {
  const values = [5, 50, 20];
  const desc = sortOrder(values, 1); // [1, 2, 0]
  assert.deepStrictEqual(desc, [1, 2, 0]);
  const hit = (x, order) => barGroupHitAtX(x, 3, order, 1)?.i ?? -1;
  // the bar drawn in slot 0 is original index 1
  assert.equal(hit(barX(0, 3), desc), 1);
  assert.equal(hit(barX(2, 3), desc), 0);
  // unsorted: the slot center maps to itself, and a slot edge does not spill over
  const id = sortOrder(values, 0);
  assert.equal(hit(barX(1, 3), id), 1);
  assert.equal(hit(PLOT.l - 1, id), -1, "left of the plot is a miss");
  assert.equal(hit(PLOT.r + 1, id), -1, "right of the plot is a miss");
});

test("sort is stable and ascending/descending by magnitude", () => {
  assert.deepStrictEqual(sortOrder([3, -9, 3, 1], 1), [1, 0, 2, 3]);
  assert.deepStrictEqual(sortOrder([3, -9, 3, 1], 2), [3, 0, 2, 1]);
});

test("hbar: row hit-test by y, drag keeps the row's sign and clamps to the track", () => {
  const order = [2, 0, 1];
  assert.equal(hbarRowAtY(HBAR.y0 + 1, 3, order), 2);
  assert.equal(hbarRowAtY(HBAR.y0 + HBAR.rowH * 2 + 5, 3, order), 1);
  assert.equal(hbarRowAtY(HBAR.y0 - 1, 3, order), -1);
  assert.equal(hbarRowAtY(HBAR.y0 + HBAR.rowH * 3, 3, order), -1);
  assert.equal(hbarValueAtX(HBAR.x + HBAR.w / 2, 10, true), -5, "negative row stays negative");
  assert.equal(hbarValueAtX(HBAR.x + HBAR.w * 2, 10, false), 10, "past the track clamps at max");
  assert.equal(hbarValueAtX(HBAR.x - 50, 10, false), 0, "before the track clamps at 0");
});

test("line/spark index hit-tests use their own x ranges", () => {
  const s = computeScale([[1, 2, 3, 4, 5]], 5, null);
  assert.equal(lineIndexAtX(s, lineX(s, 3), 5), 3);
  assert.equal(lineIndexAtX(s, -1000, 5), 0);
  assert.equal(lineIndexAtX(s, 1000, 5), 4);
  assert.equal(sparkIndexAtX(sparkX(7, 10), 10), 7);
  assert.equal(sparkIndexAtX(sparkX(9, 10) + 100, 10), 9);
});

test("pan keeps the window width and stops at both data edges", () => {
  assert.deepStrictEqual(panWindow(2, 4, +100, 10), [5, 9], "right edge: origin clamps, width kept");
  assert.deepStrictEqual(panWindow(2, 4, -100, 10), [0, 4], "left edge");
  assert.deepStrictEqual(panWindow(2, 4, 1, 10), [3, 7]);
});

test("wheel zoom: shrinks around the cursor, never exceeds the data, zooms out to null", () => {
  const z1 = wheelZoom(null, 100, 0.5, -1);
  assert.ok(z1 && z1[1] - z1[0] < 99, "zoomed in");
  assert.ok(z1 && Math.abs((z1[0] + z1[1]) / 2 - 49.5) < 1, "centered on the cursor");
  assert.equal(wheelZoom([2, 96], 100, 0.5, +1), null, "zooming out past the data resets");
  const partial = wheelZoom([10, 90], 100, 0.5, +1);
  assert.ok(partial && partial[1] - partial[0] > 80 && partial[1] <= 99, "zooming out grows the window within the data");
  const edge = wheelZoom([0, 10], 100, 0, -1);
  assert.ok(edge && edge[0] >= 0, "left edge respected");
  const tiny = wheelZoom([0, 2], 100, 0.5, -1);
  assert.ok(tiny && tiny[1] - tiny[0] >= 2, "window never below 2 samples");
});

test("stats and donut arcs come from the same (edited) values", () => {
  assert.deepStrictEqual(seriesStats([1, 2, 3]), { n: 3, min: 1, max: 3, mean: 2, sum: 6 });
  assert.equal(seriesStats([]).mean, 0);
  const d = donutRows([3, 1]);
  assert.ok(Math.abs(d.rows.reduce((a, r) => a + r.dash, 0) - d.C) < 1e-9, "slices cover the ring");
  assert.deepStrictEqual(d.rows.map((r) => r.pct), ["75", "25"]);
});

test("tooltip clamps inside the host on narrow screens", () => {
  assert.deepStrictEqual(clampTip(300, 20, 320), { left: 180, top: 0 });
  assert.deepStrictEqual(clampTip(10, 100, 600), { left: 18, top: 44 });
});

test("barGroupLayout: m=1 matches the classic centered bar; m>1 splits the group, still centered", () => {
  const g1 = barGroupLayout(6, 1);
  assert.equal(g1.bw, g1.group);
  assert.equal(g1.gap, 0);
  assert.ok(Math.abs(g1.x(2, 0) - (PLOT.l + g1.slot * 2.5)) < 1e-9, "m=1 centers on the slot center");
  const g3 = barGroupLayout(6, 3);
  assert.equal(g3.gap, 2);
  assert.ok(g3.bw * 3 + g3.gap * 2 <= g3.group + 1e-9, "bars plus gaps fit inside the group");
  assert.ok(g3.x(0, 0) < g3.x(0, 1) && g3.x(0, 1) < g3.x(0, 2), "series run left-to-right inside a group");
  assert.ok(Math.abs((g3.x(0, 0) + g3.x(0, 2)) / 2 - barX(0, 6)) < 1e-9, "the group stays centered");
  // The SVG fallback passes its own axis extent: same shape, shifted frame.
  const g = barGroupLayout(4, 2, 100, 300);
  assert.ok(Math.abs(g.slot - 50) < 1e-9);
  assert.ok(g.x(0, 0) > 100 && g.x(3, 1) < 300, "bars stay inside the given extent");
});

test("barGroupHitAtX: resolves (bar, series) under sort, nulls between groups and outside", () => {
  const order = sortOrder([5, 1, 3], 1); // |5| > |3| > |1| -> [0, 2, 1]
  const g2 = barGroupLayout(3, 2);
  assert.deepEqual(barGroupHitAtX(g2.x(0, 1), 3, order, 2), { i: 0, s: 1 });
  assert.equal(barGroupHitAtX(g2.x(0, 1) + 40, 3, order, 2), null, "past the group is null");
  assert.equal(barGroupHitAtX(PLOT.l - 4, 3, order, 2), null, "outside the plot is null");
});
