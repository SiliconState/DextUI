// Zero-dependency chart renderer for agent output. A model emits a ```chart
// fenced block containing a JSON spec; this turns it into a theme-aware SVG
// string (CSS variables, so dark/light follow the app automatically).
//
// Security model matches the markdown engine: every dynamic string is
// XML-escaped and every number is validated/coerced before it touches the
// output, so the SVG is safe to hand to the DOM as generated markup.
// Anything that fails validation returns `null` from parseChartSpec and the
// caller falls back to rendering the fence as a plain code block.

export type ChartType = "bar" | "hbar" | "line" | "spark" | "donut";

import { barFill, barGroupLayout, barTrack, computeScale, hbarDomain, hbarTrack, hbarXAt, niceTicks, sortOrder } from "./chartmath.js";

export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartSpec {
  type: ChartType;
  title?: string;
  labels?: string[];
  values: number[];
  unit?: string;
  /** Scale override (bar/hbar/line). Defaults to the data's own max. */
  max?: number;
  /** Fixed axis [lo, hi] (bar/hbar/line): pins the scale so charts compare across renders.
   *  Bar outliers clip at the edge and carry their real value in the label;
   *  line segments clip to the plot, with real values available on hover. */
  domain?: [number, number];
  /** Initial bar/hbar order: "desc" ranks by value, "asc" the reverse; default source order. */
  sort?: "desc" | "asc";
  /** Named series. When present, this list IS the data (entry 0 mirrors
   *  `values`); every entry must match `values` length. */
  series?: ChartSeries[];
  /** Shared id: charts in one message with the same dataset cross-highlight. */
  dataset?: string;
  /** Axis captions. */
  x?: string;
  y?: string;
}

/** Dense series (line/spark) may carry more points than categorical types. */
const MAX_POINTS_DENSE = 180;
const MAX_POINTS = 31;
const MAX_SERIES = 8;
export const CHART_COLORS = [
  "var(--chart-1,#3fb950)",
  "var(--chart-2,#39c5cf)",
  "var(--chart-3,#d29922)",
  "var(--chart-4,#bc8cff)",
  "var(--chart-5,#f85149)",
];

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

export function fmt(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toLocaleString("en-US");
  return String(Number(n.toFixed(2)));
}

/** Strict parse: `null` for anything that is not a renderable spec. */
export function parseChartSpec(json: string): ChartSpec | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const type = o.type === "hbar" || o.type === "line" || o.type === "spark" || o.type === "donut" ? o.type : "bar";
  const dense = type === "line" || type === "spark";
  const cap = dense ? MAX_POINTS_DENSE : MAX_POINTS;
  // Capture once — TS narrowing of `o.series` doesn't survive the hasSeries const.
  const rawSeries = o.series;
  const hasSeries = Array.isArray(rawSeries) && rawSeries.length > 0;
  const firstSeries = hasSeries ? (rawSeries[0] as { values?: unknown } | undefined) : undefined;
  // Pure-series authoring: no top-level values → series[0] is the primary.
  const rawPrimary = hasSeries && !Array.isArray(o.values) ? firstSeries?.values : o.values;
  if (!Array.isArray(rawPrimary) || rawPrimary.length === 0 || rawPrimary.length > cap) return null;
  const values: number[] = [];
  for (const v of rawPrimary) {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return null;
    values.push(n);
  }
  const labels =
    Array.isArray(o.labels)
      ? o.labels.slice(0, values.length).map((l) => (typeof l === "string" ? l : ""))
      : undefined;
  const title = typeof o.title === "string" ? o.title.slice(0, 120) : undefined;
  const unit = typeof o.unit === "string" ? o.unit.slice(0, 12) : undefined;
  let max: number | undefined;
  if (o.max !== undefined) {
    const m = Number(o.max);
    if (!Number.isFinite(m) || m <= 0) return null;
    max = m;
  }
  let domain: [number, number] | undefined;
  if (o.domain !== undefined) {
    if (!Array.isArray(o.domain) || o.domain.length !== 2) return null;
    const [lo, hi] = o.domain;
    if (typeof lo !== "number" || typeof hi !== "number" || !Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo || !Number.isFinite(hi - lo)) return null;
    domain = [lo, hi];
  }
  if (o.sort !== undefined && o.sort !== "desc" && o.sort !== "asc") return null;
  const sort = o.sort;
  let series: ChartSeries[] | undefined;
  if (hasSeries) {
    if (rawSeries.length > MAX_SERIES) return null;
    series = [];
    for (const s of rawSeries) {
      if (!s || typeof s !== "object" || Array.isArray(s)) return null;
      const so = s as Record<string, unknown>;
      if (!Array.isArray(so.values) || so.values.length !== values.length) return null;
      const sv: number[] = [];
      for (const v of so.values) {
        const n = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(n)) return null;
        sv.push(n);
      }
      series.push({ name: typeof so.name === "string" ? so.name.slice(0, 32) : "", values: sv });
    }
    // The renderer trusts that series[0] mirrors `values`.
    series[0] = { name: series[0]?.name ?? "", values: values.slice() };
  }
  const dataset = typeof o.dataset === "string" ? o.dataset.slice(0, 32) : undefined;
  const ax = typeof o.x === "string" ? o.x.slice(0, 24) : undefined;
  const ay = typeof o.y === "string" ? o.y.slice(0, 24) : undefined;
  return {
    type,
    title,
    labels,
    values,
    unit,
    ...(max !== undefined ? { max } : {}),
    ...(domain !== undefined ? { domain } : {}),
    ...(sort !== undefined ? { sort } : {}),
    ...(series ? { series } : {}),
    ...(dataset !== undefined ? { dataset } : {}),
    ...(ax !== undefined ? { x: ax } : {}),
    ...(ay !== undefined ? { y: ay } : {}),
  };
}

function gridY(x0: number, x1: number, top: number, bottom: number, hi: number, lo: number, unit?: string): string {
  let out = "";
  for (const val of niceTicks(lo, hi)) {
    const y = bottom - ((bottom - top) * (val - lo)) / (hi - lo);
    out += `<line x1="${x0}" y1="${y.toFixed(1)}" x2="${x1}" y2="${y.toFixed(1)}" style="stroke:var(--chart-grid,#2a2f37)" stroke-width="1"/>`;
    out += `<text x="${x1 + 4}" y="${(y + 3).toFixed(1)}" font-size="10" style="fill:var(--dim,#8b949e)">${esc(`${fmt(val)}${unit ?? ""}`)}</text>`;
  }
  return out;
}

function legend(spec: ChartSpec, colors: string[], cx0: number): string {
  const labels = spec.labels ?? spec.values.map((_, i) => `#${i + 1}`);
  const total = spec.values.reduce((a, b) => a + Math.abs(b), 0) || 1;
  let y = 24;
  let out = "";
  for (let i = 0; i < spec.values.length; i++) {
    const pct = ((Math.abs(spec.values[i] ?? 0) / total) * 100).toFixed(0);
    out += `<rect x="${cx0}" y="${y - 8}" width="10" height="10" rx="2" style="fill:${colors[i % colors.length]}"/>`;
    out += `<text x="${cx0 + 16}" y="${y}" font-size="11" style="fill:var(--fg,#e6edf3)">${esc((labels[i] ?? "").slice(0, 18))} · ${pct}%</text>`;
    y += 20;
  }
  return out;
}

function titleTag(spec: ChartSpec, w: number): string {
  return spec.title
    ? `<text x="${w / 2}" y="14" text-anchor="middle" font-size="12" font-weight="bold" style="fill:var(--fg,#e6edf3)">${esc(spec.title)}</text>`
    : "";
}

/** Render the spec as a standalone `<svg>` string (theme-aware via CSS vars). */
export function renderChartSVG(spec: ChartSpec): string {
  const W = 560;
  const unit = spec.unit ?? "";
  const labels = spec.labels ?? spec.values.map((_, i) => `#${i + 1}`);
  const order = sortOrder(spec.values, spec.type === "line" ? 0 : spec.sort === "desc" ? 1 : spec.sort === "asc" ? 2 : 0);

  if (spec.type === "spark") {
    const H = 48;
    const hi = Math.max(...spec.values, 0);
    const lo = Math.min(...spec.values, 0);
    const span = hi - lo || 1;
    const px = (i: number) => 2 + ((W - 4) * i) / Math.max(1, spec.values.length - 1);
    const py = (v: number) => 4 + (H - 8) * (1 - (v - lo) / span);
    const pts = spec.values.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
    const lastX = px(spec.values.length - 1);
    const lastY = py(spec.values[spec.values.length - 1] ?? 0);
    return (
      `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block" role="img" aria-label="${esc(spec.title ?? "sparkline")}">` +
      `<polyline points="${pts}" fill="none" style="stroke:var(--chart-1,#3fb950)" stroke-width="1.5"/>` +
      `<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2.5" style="fill:var(--chart-1,#3fb950)"/></svg>`
    );
  }

  if (spec.type === "donut") {
    const H = Math.max(180, 24 + spec.values.length * 20);
    const cx = 90;
    const cy = Math.max(100, H / 2);
    const r = 58;
    const C = 2 * Math.PI * r;
    const total = spec.values.reduce((a, b) => a + Math.abs(b), 0) || 1;
    let acc = 0;
    let slices = "";
    for (let i = 0; i < spec.values.length; i++) {
      const frac = Math.abs(spec.values[i] ?? 0) / total;
      if (frac <= 0) continue;
      slices +=
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke-width="26"` +
        ` style="stroke:${CHART_COLORS[i % CHART_COLORS.length]}"` +
        ` stroke-dasharray="${(frac * C).toFixed(2)} ${C.toFixed(2)}"` +
        ` stroke-dashoffset="${(-acc * C).toFixed(2)}"` +
        ` transform="rotate(-90 ${cx} ${cy})"/>`;
      acc += frac;
    }
    const legendX = 190;
    return (
      `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block" role="img" aria-label="${esc(spec.title ?? "donut chart")}">` +
      titleTag(spec, W) +
      slices +
      legend(spec, CHART_COLORS, legendX) +
      `</svg>`
    );
  }

  if (spec.type === "hbar") {
    const H = 30 + spec.values.length * 26 + 8;
    const labelW = 118;
    const trackX = labelW + 6;
    const trackW = W - trackX - 64;
    const dom = hbarDomain(spec.values, spec.max, spec.domain);
    const diverging = dom[0] < 0 && dom[1] > 0;
    let rows = "";
    for (const t of niceTicks(...dom)) {
      const x = hbarXAt(t, dom);
      rows += `<line x1="${x}" x2="${x}" y1="26" y2="${H - 8}" style="stroke:var(--chart-grid,#2a2f37)"/><text x="${x}" y="22" text-anchor="middle" font-size="9" style="fill:var(--dim,#8b949e)">${esc(`${fmt(t)}${unit}`)}</text>`;
    }
    for (const [p, i] of order.entries()) {
      const v = spec.values[i] ?? 0;
      const y = 30 + p * 26;
      const tr = hbarTrack(v, dom);
      const clipped = v < dom[0] || v > dom[1];
      const text = `${clipped ? (v > dom[1] ? "▸" : "◂") : ""}${fmt(v)}${unit}`;
      const end = hbarXAt(v, dom);
      const outside = v >= 0 ? end + 5 + text.length * 6.6 <= W - 4 : end - 5 - text.length * 6.6 >= trackX;
      const lx = v >= 0 ? outside ? end + 5 : W - 4 : outside ? end - 5 : end + 5;
      const anchor = v >= 0 ? outside ? "start" : "end" : outside ? "end" : "start";
      const color = barFill(CHART_COLORS, v, i, 0, 1, diverging);
      rows += `<text x="${labelW}" y="${y + 12}" text-anchor="end" font-size="11" style="fill:var(--dim,#8b949e)">${esc((labels[i] ?? "").slice(0, 14))}</text>`;
      rows += `<rect x="${trackX}" y="${y}" width="${trackW}" height="14" rx="3" style="fill:var(--chart-grid,#2a2f37)" opacity="0.35"/>`;
      rows += `<rect x="${tr.x.toFixed(1)}" y="${y}" width="${tr.w.toFixed(1)}" height="14" rx="3" style="fill:${color}"/>`;
      rows += `<text x="${lx}" y="${y + 12}" text-anchor="${anchor}" font-size="11" font-weight="${clipped ? "bold" : "normal"}" style="fill:var(--fg,#e6edf3)">${esc(text)}</text>`;
    }
    return (
      `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block" role="img" aria-label="${esc(spec.title ?? "bar chart")}">` +
      titleTag(spec, W) +
      rows +
      `</svg>`
    );
  }

  // bar (vertical) and line share axes
  const top = 26;
  const bottom = 190;
  const axisL = 8;
  const axisR = W - 64; // room for y labels
  const H = bottom + 34;
  const scale = computeScale(spec.series?.map((s) => s.values) ?? [spec.values], spec.values.length, null, spec.max, spec.domain);
  const { hi, lo } = scale;
  const span = hi - lo || 1;
  const py = (v: number) => bottom - ((bottom - top) * (v - lo)) / span;
  const px = (i: number) => axisL + ((axisR - axisL) * (i + 0.5)) / spec.values.length;
  const grid = gridY(axisL, axisR, top, bottom, hi, lo, unit);
  let body = "";
  if (spec.type === "bar") {
    // Grouped bars: with named series each label gets one bar per series
    // (color = series); a lone series keeps the classic per-bar coloring.
    // Geometry and fill come from chartmath so this fallback and the
    // interactive chart cannot drift apart.
    const rowsArr = spec.series?.length ? spec.series.map((s) => s.values) : [spec.values];
    const m = rowsArr.length;
    const geo = barGroupLayout(spec.values.length, m, axisL, axisR);
    for (const [p, i] of order.entries()) {
      for (let s = 0; s < m; s++) {
        const v = rowsArr[s]?.[i] ?? 0;
        const tr = barTrack(v, scale);
        const by = tr.y;
        const bh = tr.h;
        const bx = geo.x(p, s) - geo.bw / 2;
        const name = spec.series?.[s]?.name || `s${s + 1}`;
        const tipTxt = m > 1 ? `${labels[i] ?? ""} · ${name}: ${fmt(v)}${unit}` : `${labels[i] ?? ""}: ${fmt(v)}${unit}`;
        body +=
          `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${geo.bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2"` +
          ` style="fill:${barFill(CHART_COLORS, v, i, s, m, lo < 0)}"><title>${esc(tipTxt)}</title></rect>`;
        if (tr.clipped || m === 1) {
          const ly = tr.end + (tr.clipped < 0 || (!tr.clipped && v < 0) ? 11 : -4);
          body += `<text x="${geo.x(p, s).toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="10" font-weight="${tr.clipped ? "bold" : "normal"}" style="fill:var(--fg,#e6edf3)">${esc(`${tr.clipped ? tr.clipped > 0 ? "▴" : "▾" : ""}${fmt(v)}${unit}`)}</text>`;
        }
      }
    }
    if (m > 1) {
      // Legend: right-aligned swatches on the row above the plot, capped to
      // what fits so many series never run off the left edge.
      const LEGEND_W = 78;
      const names = (spec.series ?? []).slice(0, Math.max(1, Math.floor((axisR - axisL) / LEGEND_W)));
      names.forEach((sr, s) => {
        const lx = axisR - names.length * LEGEND_W + s * LEGEND_W;
        const ly = top - 8;
        body +=
          `<rect x="${lx.toFixed(1)}" y="${(ly - 8).toFixed(1)}" width="9" height="9" rx="2" style="fill:${CHART_COLORS[s % CHART_COLORS.length]}"/>` +
          `<text x="${(lx + 13).toFixed(1)}" y="${ly.toFixed(1)}" font-size="10" style="fill:var(--fg,#e6edf3)">${esc((sr.name || `s${s + 1}`).slice(0, 9))}</text>`;
      });
    }
  } else {
    // Clip actual segments rather than flattening outliers at the boundary.
    body += `<svg x="${axisL}" y="${top}" width="${axisR - axisL}" height="${bottom - top}" viewBox="${axisL} ${top} ${axisR - axisL} ${bottom - top}" overflow="hidden">`;
    const pts = spec.values.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
    body += `<polyline points="${pts}" fill="none" style="stroke:var(--chart-1,#3fb950)" stroke-width="2"/>`;
    for (let i = 0; i < spec.values.length; i++) {
      body +=
        `<circle cx="${px(i).toFixed(1)}" cy="${py(spec.values[i] ?? 0).toFixed(1)}" r="3" style="fill:var(--chart-1,#3fb950)"><title>${esc(`${labels[i] ?? ""}: ${fmt(spec.values[i] ?? 0)}${unit}`)}</title></circle>`;
    }
  }
  if (spec.type === "line") body += `</svg>`;
  let xLabels = "";
  for (const [p, i] of order.entries()) {
    xLabels += `<text x="${px(p).toFixed(1)}" y="${bottom + 16}" text-anchor="middle" font-size="10" style="fill:var(--dim,#8b949e)">${esc((labels[i] ?? "").slice(0, 10))}</text>`;
  }
  return (
    `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block" role="img" aria-label="${esc(spec.title ?? `${spec.type} chart`)}">` +
    titleTag(spec, W) +
    grid +
    body +
    xLabels +
    `</svg>`
  );
}
