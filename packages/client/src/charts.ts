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
  "var(--green,#3fb950)",
  "var(--cyan,#39c5cf)",
  "var(--yellow,#d29922)",
  "var(--magenta,#bc8cff)",
  "var(--red,#f85149)",
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
    ...(series ? { series } : {}),
    ...(dataset !== undefined ? { dataset } : {}),
    ...(ax !== undefined ? { x: ax } : {}),
    ...(ay !== undefined ? { y: ay } : {}),
  };
}

function scaleMax(spec: ChartSpec): number {
  if (spec.max !== undefined) return spec.max;
  return Math.max(1e-9, ...spec.values.map((v) => Math.abs(v)));
}

function gridY(x0: number, x1: number, top: number, bottom: number, hi: number, lo: number, unit?: string): string {
  let out = "";
  for (let i = 0; i <= 3; i++) {
    const y = bottom - ((bottom - top) * i) / 3;
    const val = lo + ((hi - lo) * i) / 3;
    out += `<line x1="${x0}" y1="${y.toFixed(1)}" x2="${x1}" y2="${y.toFixed(1)}" style="stroke:var(--line,#2a2f37)" stroke-width="1"/>`;
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
      `<polyline points="${pts}" fill="none" style="stroke:var(--green,#3fb950)" stroke-width="1.5"/>` +
      `<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2.5" style="fill:var(--green,#3fb950)"/></svg>`
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
    const hi = scaleMax(spec);
    let rows = "";
    for (let i = 0; i < spec.values.length; i++) {
      const v = spec.values[i] ?? 0;
      const y = 30 + i * 26;
      const w = Math.max(2, (Math.abs(v) / hi) * trackW);
      const color = v < 0 ? CHART_COLORS[4] : CHART_COLORS[i % CHART_COLORS.length];
      rows += `<text x="${labelW}" y="${y + 12}" text-anchor="end" font-size="11" style="fill:var(--dim,#8b949e)">${esc((labels[i] ?? "").slice(0, 14))}</text>`;
      rows += `<rect x="${trackX}" y="${y}" width="${trackW}" height="14" rx="3" style="fill:var(--line,#2a2f37)" opacity="0.35"/>`;
      rows += `<rect x="${trackX}" y="${y}" width="${w.toFixed(1)}" height="14" rx="3" style="fill:${color}"/>`;
      rows += `<text x="${trackX + trackW + 6}" y="${y + 12}" font-size="11" style="fill:var(--fg,#e6edf3)">${esc(`${fmt(v)}${unit}`)}</text>`;
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
  const hi = Math.max(0, spec.max ?? Math.max(...spec.values));
  const lo = Math.min(0, ...spec.values);
  const span = hi - lo || 1;
  const py = (v: number) => bottom - ((bottom - top) * (v - lo)) / span;
  const px = (i: number) => axisL + ((axisR - axisL) * (i + 0.5)) / spec.values.length;
  const grid = gridY(axisL, axisR, top, bottom, hi, lo, unit);
  let body = "";
  if (spec.type === "bar") {
    const slot = (axisR - axisL) / spec.values.length;
    const bw = Math.min(44, slot * 0.62);
    for (let i = 0; i < spec.values.length; i++) {
      const v = spec.values[i] ?? 0;
      const y0 = py(0);
      const y1 = py(v);
      const by = Math.min(y0, y1);
      const bh = Math.max(2, Math.abs(y0 - y1));
      body +=
        `<rect x="${(px(i) - bw / 2).toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2"` +
        ` style="fill:${v < 0 ? CHART_COLORS[4] : CHART_COLORS[i % CHART_COLORS.length]}"><title>${esc(`${labels[i] ?? ""}: ${fmt(v)}${unit}`)}</title></rect>`;
      body += `<text x="${px(i).toFixed(1)}" y="${(by - 4).toFixed(1)}" text-anchor="middle" font-size="10" style="fill:var(--fg,#e6edf3)">${esc(`${fmt(v)}${unit}`)}</text>`;
    }
  } else {
    const pts = spec.values.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
    body += `<polyline points="${pts}" fill="none" style="stroke:var(--green,#3fb950)" stroke-width="2"/>`;
    for (let i = 0; i < spec.values.length; i++) {
      body +=
        `<circle cx="${px(i).toFixed(1)}" cy="${py(spec.values[i] ?? 0).toFixed(1)}" r="3" style="fill:var(--green,#3fb950)"><title>${esc(`${labels[i] ?? ""}: ${fmt(spec.values[i] ?? 0)}${unit}`)}</title></circle>`;
    }
  }
  let xLabels = "";
  for (let i = 0; i < spec.values.length; i++) {
    xLabels += `<text x="${px(i).toFixed(1)}" y="${bottom + 16}" text-anchor="middle" font-size="10" style="fill:var(--dim,#8b949e)">${esc((labels[i] ?? "").slice(0, 10))}</text>`;
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
