// Pure geometry + gesture math for the interactive chart renderer
// (apps/web Chart.svelte). No DOM, no state: the component wires pointer
// events to these functions, which makes every hit-test, scale, clamp and
// zoom step unit-testable in node — the bugs a review found in the first
// cut (hover hitting the wrong sorted bar, the axis rescaling under a
// dragged point, pan compressing at the edge) are all pinned here.

export const CHART_W = 560;
/** Shared plot frame for bar/line (px in viewBox units). */
export const PLOT = { top: 26, bottom: 190, l: 8, r: CHART_W - 64 } as const;
/** Horizontal-bar track: label column ends at 118, value column after the track. */
export const HBAR = { x: 124, w: CHART_W - 188, y0: 30, rowH: 26 } as const;
export const SPARK = { pad: 2, h: 48 } as const;

export interface Scale {
  /** Visible index window (fractional while zoomed/panned). */
  i0: number;
  i1: number;
  hi: number;
  lo: number;
  spanI: number;
}

/**
 * Y-scale for bar/line from the visible (possibly edited) series within the
 * zoom window. `max` pins the top; otherwise the data's own max. `lo` is
 * never above 0 so bars keep a baseline.
 */
export function computeScale(rows: number[][], n: number, zoom: [number, number] | null, max?: number, domain?: [number, number]): Scale {
  const i0 = zoom ? zoom[0] : 0;
  const i1 = zoom ? zoom[1] : n - 1;
  const vs: number[] = [];
  const a = Math.max(0, Math.floor(i0));
  const b = Math.min(n - 1, Math.ceil(i1));
  for (const r of rows.length ? rows : [[]]) {
    for (let i = a; i <= b; i++) {
      const v = r[i];
      if (v !== undefined) vs.push(v);
    }
  }
  let hi = max ?? (vs.length ? Math.max(1e-9, ...vs) : 1);
  let lo = vs.length ? Math.min(0, ...vs) : 0;
  if (domain) {
    // Fixed axis: comparable across renders (e.g. daily % moves pinned to ±3).
    lo = domain[0];
    hi = domain[1];
  } else if (max === undefined && lo < 0) {
    // Diverging data: symmetric, nice-rounded so 0 sits mid-plot and ticks are round.
    const a = niceCeil(Math.max(Math.abs(lo), Math.abs(hi)));
    lo = -a;
    hi = a;
  }
  if (hi <= lo) hi = lo + 1;
  return { i0, i1, hi, lo, spanI: Math.max(1e-6, i1 - i0) };
}

/** Smallest 1/2/2.5/5 × 10^k at or above |v| (0 → 1). */
export function niceCeil(v: number): number {
  const a = Math.abs(v);
  if (!(a > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(a)));
  const m = a / p;
  const s = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
  return Number((s * p).toPrecision(12));
}

/**
 * Round-number axis ticks covering [lo, hi] (about `count` of them, always
 * including 0 when it lies in range). Step is 1/2/2.5/5 × 10^k.
 */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / Math.max(1, count);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  const step = (m <= 1.5 ? 1 : m <= 3 ? 2 : m <= 7 ? 5 : 10) * p;
  const out: number[] = [];
  const t0 = Math.ceil(lo / step - 1e-9) * step;
  for (let t = t0; t <= hi + step * 1e-6; t += step) out.push(Number(t.toPrecision(12)));
  if (lo < 0 && hi > 0 && !out.some((t) => t === 0)) out.push(0);
  return out.sort((a, b) => a - b);
}

/** Horizontal-bar axis domain: symmetric around 0 when any value is negative. */
export function hbarDomain(values: number[], max?: number, domain?: [number, number]): [number, number] {
  if (domain) return domain;
  const neg = values.some((v) => v < 0);
  if (max !== undefined) return neg ? [-max, max] : [0, max];
  const a = niceCeil(hbarScaleMax(values));
  return neg ? [-a, a] : [0, a];
}

/** x of a value on the hbar track for a domain (clamped). */
export function hbarXAt(v: number, dom: [number, number]): number {
  const [lo, hi] = dom;
  return HBAR.x + (HBAR.w * (Math.max(lo, Math.min(hi, v)) - lo)) / (hi - lo);
}

/** Fill rect for a zero-anchored hbar: grows right for v>0, left for v<0. */
export function hbarTrack(v: number, dom: [number, number]): { x: number; w: number } {
  const z = hbarXAt(Math.max(dom[0], Math.min(dom[1], 0)), dom);
  const e = hbarXAt(v, dom);
  return { x: Math.min(z, e), w: Math.max(2, Math.abs(e - z)) };
}

/** Inverse of hbarXAt, clamped to the domain (a drag may cross zero). */
export function hbarValueAtDom(x: number, dom: [number, number]): number {
  const [lo, hi] = dom;
  const f = Math.max(0, Math.min(1, (x - HBAR.x) / HBAR.w));
  return lo + f * (hi - lo);
}

export function lineX(sc: Scale, i: number): number {
  return PLOT.l + ((PLOT.r - PLOT.l) * (i - sc.i0)) / sc.spanI;
}

export function scaleY(sc: Scale, v: number): number {
  return PLOT.bottom - ((PLOT.bottom - PLOT.top) * (v - sc.lo)) / (sc.hi - sc.lo);
}

/** Inverse of scaleY — extrapolates above the plot so a drag can exceed the current max. */
export function valueAtY(sc: Scale, y: number): number {
  return sc.lo + ((PLOT.bottom - y) * (sc.hi - sc.lo)) / (PLOT.bottom - PLOT.top);
}

/** Nearest sample index to an x in a line chart's window (clamped). */
export function lineIndexAtX(sc: Scale, x: number, n: number): number {
  const i = sc.i0 + ((x - PLOT.l) / (PLOT.r - PLOT.l)) * sc.spanI;
  return Math.max(0, Math.min(n - 1, Math.round(i)));
}

export function sparkX(i: number, n: number): number {
  return SPARK.pad + ((CHART_W - 2 * SPARK.pad) * i) / Math.max(1, n - 1);
}

export function sparkY(v: number, values: number[]): number {
  const lo = Math.min(...values);
  const span = Math.max(...values) - lo || 1;
  return 4 + (SPARK.h - 8) * (1 - (v - lo) / span);
}

export function sparkIndexAtX(x: number, n: number): number {
  const i = ((x - SPARK.pad) / (CHART_W - 2 * SPARK.pad)) * Math.max(1, n - 1);
  return Math.max(0, Math.min(n - 1, Math.round(i)));
}

/** Center x of the single-series bar at sorted position `p` (the m=1 group). */
export function barX(p: number, n: number): number {
  return barGroupLayout(n, 1).x(p, 0);
}

/** Grouped-bar geometry for m visible series: per-label bars share the width
 *  one bar would use. `l`/`r` default to the interactive plot frame; the SVG
 *  fallback passes its own axis extent so both renderers share one formula. */
export function barGroupLayout(
  n: number,
  m: number,
  l: number = PLOT.l,
  r: number = PLOT.r,
): { slot: number; bw: number; group: number; gap: number; x: (p: number, s: number) => number } {
  const slot = (r - l) / Math.max(1, n);
  const group = Math.min(44, slot * 0.62);
  const gap = m > 1 ? 2 : 0;
  const bw = m > 1 ? Math.max(3, (group - gap * (m - 1)) / m) : group;
  return {
    slot,
    bw,
    group,
    gap,
    x: (p, s) => l + slot * (p + 0.5) - group / 2 + s * (bw + gap) + bw / 2,
  };
}

/** Series bar under x (sort permutation honored). Null outside the plot or
 *  outside a label's group; a pixel in the 2px gap resolves to the bar on its
 *  right. */
export function barGroupHitAtX(x: number, n: number, order: number[], m: number): { i: number; s: number } | null {
  if (x < PLOT.l || x > PLOT.r) return null;
  const { slot, bw, group, gap } = barGroupLayout(n, m);
  const p = Math.min(n - 1, Math.max(0, Math.floor((x - PLOT.l) / slot)));
  const local = x - (PLOT.l + slot * (p + 0.5) - group / 2);
  if (local < -1 || local > group + 1) return null;
  const s = Math.floor((local + 1) / (bw + gap));
  if (s < 0 || s >= m) return null;
  return { i: order[p] ?? -1, s };
}

/** Bar colour: negatives always the warning colour (palette[4]); with several
 *  series a bar takes its series' colour, alone it takes the per-bar colour. */
export function barFill(palette: readonly string[], v: number, i: number, s: number, m: number, diverging = false): string {
  if (v < 0) return palette[4] ?? palette[0] ?? "";
  // Diverging single series: direction is the cue, so positives share one green.
  if (diverging && m <= 1) return palette[0] ?? "";
  return palette[(m > 1 ? s : i) % palette.length] ?? "";
}

/** Original index of the hbar row under y; -1 outside the rows. */
export function hbarRowAtY(y: number, n: number, order: number[], rowH: number = HBAR.rowH): number {
  const p = Math.floor((y - HBAR.y0) / rowH);
  if (p < 0 || p >= n) return -1;
  return order[p] ?? -1;
}

export function hbarScaleMax(values: number[], max?: number): number {
  return Math.max(1e-9, ...values.map(Math.abs), max ?? 0);
}

export function hbarWidth(v: number, hiAbs: number): number {
  return Math.max(2, (Math.abs(v) / hiAbs) * HBAR.w);
}

/** Value for a fill dragged to x; keeps the row's original sign, clamps at the track. */
export function hbarValueAtX(x: number, hiAbs: number, negative: boolean): number {
  const mag = Math.max(0, Math.min(1, (x - HBAR.x) / HBAR.w)) * hiAbs;
  return negative ? -mag : mag;
}

/** 0 = source order · 1 = value descending (a ranking) · 2 = ascending. Stable. */
export function sortOrder(values: number[], mode: 0 | 1 | 2): number[] {
  const o = values.map((_, i) => i);
  if (mode === 0) return o;
  const key = (i: number) => values[i] ?? 0;
  return o.sort((a, b) => (mode === 1 ? key(b) - key(a) : key(a) - key(b)) || a - b);
}

/** Pan by `di` samples: the window keeps its width and stops at the data edges. */
export function panWindow(i0: number, w: number, di: number, n: number): [number, number] {
  const maxA = Math.max(0, n - 1 - w);
  const a = Math.max(0, Math.min(maxA, i0 + di));
  return [a, a + w];
}

/** Wheel step around the cursor's fraction `fx` (0..1) of the current window; null = fully zoomed out. */
export function wheelZoom(zoom: [number, number] | null, n: number, fx: number, deltaY: number): [number, number] | null {
  const i0 = zoom ? zoom[0] : 0;
  const i1 = zoom ? zoom[1] : n - 1;
  const f = Math.max(0, Math.min(1, fx));
  const at = i0 + f * (i1 - i0);
  const k = deltaY > 0 ? 1.18 : 1 / 1.18;
  let w = (i1 - i0) * k;
  if (w >= n - 1) return null;
  w = Math.max(2, w);
  const a = Math.max(0, Math.min(n - 1 - w, at - f * w));
  return [a, a + w];
}

export function seriesStats(values: number[]): { n: number; min: number; max: number; mean: number; sum: number } {
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    n: values.length,
    min: values.length ? Math.min(...values) : 0,
    max: values.length ? Math.max(...values) : 0,
    mean: values.length ? sum / values.length : 0,
    sum,
  };
}

export interface DonutRow {
  i: number;
  dash: number;
  off: number;
  pct: string;
}

/** Arc lengths on a r=58 ring; slices are by |v| so mixed signs still sum to the full ring. */
export function donutRows(values: number[]): { C: number; rows: DonutRow[] } {
  const C = 2 * Math.PI * 58;
  const total = values.reduce((a, b) => a + Math.abs(b), 0) || 1;
  let acc = 0;
  const rows = values.map((v, i) => {
    const frac = Math.abs(v) / total;
    const row = { i, dash: frac * C, off: acc * C, pct: (frac * 100).toFixed(0) };
    acc += frac;
    return row;
  });
  return { C, rows };
}

/** Tooltip placement inside a host of width `hostW`: lifted above the cursor, never past the right edge. */
export function clampTip(x: number, y: number, hostW: number, tipW = 140, lift = 56): { left: number; top: number } {
  return { left: Math.max(0, Math.min(x + 8, hostW - tipW)), top: Math.max(0, y - lift) };
}
