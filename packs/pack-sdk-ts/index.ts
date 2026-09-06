// pack-sdk-ts — the TypeScript side of DextUI's consumer packs.
//
// A pack ships `ui/panel.ts`; `packs/scripts/build-panel.mjs` bundles it into
// `ui/panel.html` (palette shell + this bundle + a `window.__PACK_DATA__`
// placeholder). The pack's Rust runtime writes a per-run copy into the
// session folder with live data injected, and DextUI renders it inline in a
// sandboxed frame. Zero dependencies, zero network: everything renders from
// the baked JSON.
export interface BarItem {
  label: string;
  cents: number;
}

/** Escape text for HTML text nodes (attribute-safe too). */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** "$1,234.56" from integer cents — the TS twin of the Rust Money::fmt. */
export function money(cents: number, symbol = "$"): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100).toString();
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${symbol}${grouped}.${String(abs % 100).padStart(2, "0")}`;
}

/** Minimal DOM builder: el("div", { class: "x" }, children...). */
export function el(tag: string, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) node.append(c);
  return node;
}

/** Inline SVG horizontal bars, palette-aware, labelled. */
export function bars(items: BarItem[], symbol: string, max = 12): SVGSVGElement {
  const shown = items.slice(0, max);
  const peak = Math.max(1, ...shown.map((i) => i.cents));
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  const rowH = 24;
  const labelW = 130;
  const valueW = 90;
  const width = 560;
  const barW = width - labelW - valueW - 16;
  svg.setAttribute("viewBox", `0 0 ${width} ${shown.length * rowH + 4}`);
  svg.setAttribute("class", "bars");
  shown.forEach((item, i) => {
    const y = i * rowH + 2;
    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", "0");
    label.setAttribute("y", String(y + rowH / 2 + 4));
    label.setAttribute("class", "bar-label");
    label.textContent = item.label.length > 18 ? item.label.slice(0, 17) + "…" : item.label;
    svg.append(label);
    const track = document.createElementNS(NS, "rect");
    track.setAttribute("x", String(labelW));
    track.setAttribute("y", String(y + 3));
    track.setAttribute("width", String(barW));
    track.setAttribute("height", String(rowH - 8));
    track.setAttribute("class", "bar-track");
    svg.append(track);
    const bar = document.createElementNS(NS, "rect");
    bar.setAttribute("x", String(labelW));
    bar.setAttribute("y", String(y + 3));
    bar.setAttribute("width", String(Math.max(2, (item.cents / peak) * barW)));
    bar.setAttribute("height", String(rowH - 8));
    bar.setAttribute("class", "bar-fill");
    svg.append(bar);
    const value = document.createElementNS(NS, "text");
    value.setAttribute("x", String(labelW + barW + 8));
    value.setAttribute("y", String(y + rowH / 2 + 4));
    value.setAttribute("class", "bar-value");
    value.textContent = money(item.cents, symbol);
    svg.append(value);
  });
  return svg;
}

export type Row = (string | number)[];

/** Sortable plain table (text nodes only). */
export function table(headers: string[], rows: Row[], numericCols: number[] = []): HTMLTableElement {
  const t = el("table") as HTMLTableElement;
  const thead = el("thead");
  const hr = el("tr");
  headers.forEach((h, i) => hr.append(el("th", numericCols.includes(i) ? { class: "num" } : {}, h)));
  thead.append(hr);
  t.append(thead);
  const tbody = el("tbody") as HTMLTableSectionElement;
  for (const r of rows) {
    const tr = el("tr");
    r.forEach((c, i) => tr.append(el("td", numericCols.includes(i) ? { class: "num" } : {}, String(c))));
    tbody.append(tr);
  }
  t.append(tbody);
  let sortCol = -1;
  let dir = 1;
  thead.addEventListener("click", (ev) => {
    const th = (ev.target as HTMLElement).closest("th");
    if (!th) return;
    const col = Array.from(hr.children).indexOf(th);
    dir = sortCol === col ? -dir : 1;
    sortCol = col;
    const numeric = numericCols.includes(col);
    const sorted = Array.from(tbody.rows).sort((a, b) => {
      const x = a.cells[col]?.textContent ?? "";
      const y = b.cells[col]?.textContent ?? "";
      return (numeric ? (parseFloat(x.replace(/[^\d.-]/g, "")) || 0) - (parseFloat(y.replace(/[^\d.-]/g, "")) || 0) : x.localeCompare(y)) * dir;
    });
    for (const row of sorted) tbody.append(row);
  });
  return t;
}

export function h2(text: string): HTMLElement {
  return el("h2", {}, text);
}

export function muted(text: string): HTMLElement {
  return el("p", { class: "muted" }, text);
}

/** Panel contract: render into the host element from the baked data. */
export function definePanel(render: (host: HTMLElement, data: any) => void): void {
  const boot = () => {
    const host = document.getElementById("app");
    if (!host) return;
    try {
      render(host, (window as any).__PACK_DATA__ ?? {});
    } catch (err) {
      host.replaceChildren(el("p", { class: "err" }, `panel failed to render: ${err instanceof Error ? err.message : String(err)}`));
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
}
