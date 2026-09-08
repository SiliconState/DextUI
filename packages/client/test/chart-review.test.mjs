import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { barTrack, computeScale, hbarTrack, hbarXAt, hbarRowAtY, HBAR, PLOT, niceTicks, parseChartSpec, renderChartSVG } from "../dist/index.js";

test("fixed domains require two finite numbers with a finite positive span; sort is validated", () => {
  for (const domain of [[null, 3], [false, 3], ["-3", 3], [[], 3], [3, 3], [3, -3], [-1e308, 1e308], [0], [0, 1, 2]]) {
    assert.equal(parseChartSpec(JSON.stringify({ type: "hbar", values: [1], domain })), null, JSON.stringify(domain));
  }
  assert.equal(parseChartSpec(JSON.stringify({ values: [1], sort: "descending" })), null);
  assert.deepEqual(parseChartSpec(JSON.stringify({ values: [1], domain: [-3, 3], sort: "desc" })).domain, [-3, 3]);
});

test("ticks terminate for adjacent huge floats and subnormal domains", async () => {
  const url = new URL("../dist/chartmath.js", import.meta.url).href;
  const worker = new Worker(`const { parentPort } = require('node:worker_threads'); import(${JSON.stringify(url)}).then(m => parentPort.postMessage([[1e16, 1e16 + 2], [0, Number.MIN_VALUE], [-3, 3], [0, 1e-300]].map(([lo, hi]) => m.niceTicks(lo, hi))));`, { eval: true });
  try {
    const values = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("tick iteration stalled")), 2000);
      worker.once("message", v => { clearTimeout(timer); resolve(v); });
      worker.once("error", e => { clearTimeout(timer); reject(e); });
    });
    for (const ticks of values) {
      assert.ok(ticks.length > 0 && ticks.length <= 251);
      assert.ok(ticks.every(Number.isFinite));
      assert.equal(new Set(ticks).size, ticks.length);
    }
  } finally { await worker.terminate(); }
  assert.deepEqual(niceTicks(-3, 3), [-3, -2, -1, 0, 1, 2, 3]);
});

test("bar baseline and outliers stay in the plot for domains excluding zero", () => {
  for (const domain of [[10, 20], [-20, -10], [-3, 3]]) {
    const sc = computeScale([[0]], 1, null, undefined, domain);
    for (const v of [-100, -20, -15, -10, 0, 10, 15, 20, 100]) {
      const tr = barTrack(v, sc);
      assert.ok(tr.y >= PLOT.top && tr.y + tr.h <= PLOT.bottom + 1e-9, `${domain} ${v}`);
      assert.equal(tr.clipped, v < domain[0] ? -1 : v > domain[1] ? 1 : 0);
    }
  }
  assert.equal(barTrack(0, computeScale([[1]], 1, null)).h, 0, "zero must not invent a positive bar");
});

test("horizontal zero and near-zero bars are honest, bounded and compact hit tests match rows", () => {
  assert.equal(hbarTrack(0, [-3, 3]).w, 0);
  const small = hbarTrack(-0.001, [-3, 3]);
  assert.ok(small.w < 2);
  assert.ok(Math.abs(small.x + small.w - hbarXAt(0, [-3, 3])) < 1e-8);
  for (const dom of [[10, 20], [-20, -10], [-3, 3]]) {
    for (const v of [-100, 0, 100]) {
      const tr = hbarTrack(v, dom);
      assert.ok(tr.x >= HBAR.x && tr.x + tr.w <= HBAR.x + HBAR.w + 1e-9);
    }
  }
  assert.equal(hbarRowAtY(HBAR.y0 + 21, 3, [2, 0, 1], 20), 0);
});

test("standalone SVG honors sorted fixed domains and marks genuine outliers", () => {
  for (const type of ["bar", "hbar"]) {
    const svg = renderChartSVG({ type, labels: ["negative", "outlier", "middle"], values: [-5, 200, 25], domain: [-25, 100], sort: "desc", unit: "%" });
    assert.ok(svg.indexOf(">outlier<") < svg.indexOf(">middle<"));
    assert.ok(svg.indexOf(">middle<") < svg.indexOf(">negative<"));
    assert.match(svg, /[▴▸]200%/);
    assert.doesNotMatch(svg, /NaN|Infinity/);
  }
  const svg = renderChartSVG({ type: "bar", values: [5, 15, 30], domain: [10, 20] });
  for (const m of svg.matchAll(/<rect [^>]*y="([\d.]+)"[^>]*height="([\d.]+)"/g)) {
    assert.ok(+m[1] >= PLOT.top && +m[1] + +m[2] <= PLOT.bottom + 0.1);
  }
  assert.match(renderChartSVG({ type: "line", values: [-10, 0, 10], domain: [-3, 3] }), /overflow="hidden"/);
});
