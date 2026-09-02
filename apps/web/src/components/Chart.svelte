<script lang="ts">
  // Interactive chart renderer — the web tier of packages/client/charts.ts
  // (the strict validator lives there; this owns everything the frozen SVG
  // could not do: hover, zoom/pan, drag-a-point editing with live stats,
  // click-sort, legend toggles, donut isolate, dataset cross-highlight).
  // All local: Svelte escapes every label, nothing leaves the browser, and
  // no interaction mutates the spec or round-trips to the host.
  import { fmt, CHART_COLORS, type ChartSpec } from "@dextui/client";
  import type { ChartLink } from "../lib/chartlink.svelte";

  let { spec, link }: { spec: ChartSpec; link?: ChartLink } = $props();

  const W = 560;
  // $derived: keeps svelte-check's state_referenced_locally heuristic quiet
  // and stays correct even if a block were ever re-parsed in place.
  const ds = $derived(spec.dataset ?? "");
  const seriesAll = $derived(spec.series ?? [{ name: spec.title ?? "", values: spec.values }]);
  const labels = $derived(spec.labels ?? spec.values.map((_, i) => `#${i + 1}`));
  const unit = $derived(spec.unit ?? "");
  const n = $derived(spec.values.length);
  const plot = { top: 26, bottom: 190, l: 8, r: W - 64 };

  // ---- interaction state
  let hidden = $state(new Set<number>()); // toggled-off series (line/legend)
  let edit = $state<Record<number, number[]>>({}); // dragged-point overrides
  let sortMode = $state(0); // 0 none · 1 desc · 2 asc (bar/hbar)
  let zoom = $state<[number, number] | null>(null); // line x-window
  let hoverI = $state(-1);
  let iso = $state(-1); // donut isolated slice
  let drag = $state<{ s: number; i: number; ax: "x" | "y" } | null>(null);
  let pan = $state<{ px: number; i0: number; i1: number } | null>(null);
  let brush = $state<{ a: number } | null>(null);
  let tip = $state({ x: 0, y: 0, on: false });

  const vals = (s: number): number[] => edit[s] ?? seriesAll[s]!.values;
  const visible = $derived(seriesAll.map((_, s) => s).filter((s) => !hidden.has(s)));
  const edited = $derived(Object.keys(edit).length > 0);
  const cursor = $derived(drag || pan || brush ? "grabbing" : "default");

  const setVal = (s: number, i: number, v: number) => {
    if (!Number.isFinite(v)) return;
    const arr = [...(edit[s] ?? seriesAll[s]!.values)];
    arr[i] = v;
    edit = { ...edit, [s]: arr };
  };

  // ---- scale (line/bar): y from visible+edited values in the zoom window
  const scl = $derived.by(() => {
    const i0 = zoom ? zoom[0] : 0;
    const i1 = zoom ? zoom[1] : n - 1;
    const vs: number[] = [];
    for (const s of visible.length ? visible : [0]) {
      for (let i = Math.max(0, Math.floor(i0)); i <= Math.min(n - 1, Math.ceil(i1)); i++) {
        const v = vals(s)[i];
        if (v !== undefined) vs.push(v);
      }
    }
    let hi = spec.max ?? Math.max(1e-9, ...vs);
    let lo = vs.length ? Math.min(0, ...vs) : 0;
    if (hi <= lo) hi = lo + 1;
    const spanI = Math.max(1e-6, i1 - i0);
    return {
      i0,
      i1,
      hi,
      lo,
      spanI,
      xi: (i: number) => plot.l + ((plot.r - plot.l) * (i - i0)) / spanI,
      yi: (v: number) => plot.bottom - ((plot.bottom - plot.top) * (v - lo)) / (hi - lo),
    };
  });

  // ---- sort permutation (bar/hbar)
  const order = $derived.by(() => {
    const o = Array.from({ length: n }, (_, i) => i);
    if (sortMode === 0 || spec.type === "donut" || spec.type === "spark" || spec.type === "line") return o;
    const key = (i: number) => Math.abs(vals(0)[i] ?? 0);
    o.sort((a, b) => (sortMode === 1 ? key(b) - key(a) : key(a) - key(b)));
    return o;
  });

  // ---- live stats over the primary visible series (edited values included)
  const stats = $derived.by(() => {
    const s = visible[0] ?? 0;
    const vs = vals(s);
    return {
      n,
      min: Math.min(...vs),
      max: Math.max(...vs),
      mean: vs.reduce((a, b) => a + b, 0) / vs.length,
      sum: vs.reduce((a, b) => a + b, 0),
    };
  });

  // ---- pointer plumbing
  let svgEl = $state<SVGSVGElement | null>(null);
  let moved = 0;

  const toSvg = (e: PointerEvent | WheelEvent) => {
    const r = svgEl?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * viewH) / r.height };
  };

  const idxAt = (x: number) => {
    const i = scl.i0 + ((x - plot.l) / (plot.r - plot.l)) * scl.spanI;
    return Math.max(0, Math.min(n - 1, Math.round(i)));
  };

  const onMove = (e: PointerEvent) => {
    const p = toSvg(e);
    if (drag) {
      moved++;
      if (drag.ax === "x") {
        // hbar: horizontal fill — value from x over the track
        const hiAbs = Math.max(1e-9, ...vals(0).map(Math.abs), spec.max ?? 0);
        setVal(drag.s, drag.i, Math.round(Math.max(0, ((p.x - hb.x) / hb.w) * hiAbs) * 100) / 100);
      } else {
        const raw = scl.lo + ((plot.bottom - p.y) * (scl.hi - scl.lo)) / (plot.bottom - plot.top);
        setVal(drag.s, drag.i, Math.round(raw * 100) / 100);
      }
    } else if (pan) {
      moved++;
      const r = svgEl?.getBoundingClientRect();
      const di = r ? ((pan.px - e.clientX) * (W / r.width) * scl.spanI) / (plot.r - plot.l) : 0;
      const w = pan.i1 - pan.i0;
      zoom = [Math.max(0, pan.i0 + di), Math.min(n - 1, Math.max(0, pan.i0 + di) + w)];
    } else if (brush) {
      moved++;
      link?.range(ds, brush.a, idxAt(p.x));
    }
  };
  const onUp = () => {
    drag = null;
    pan = null;
    brush = null;
  };

  const onHover = (e: PointerEvent) => {
    if (drag || pan || brush) return;
    const p = toSvg(e);
    hoverI = idxAt(p.x);
    const host = svgEl?.parentElement?.getBoundingClientRect();
    if (host) tip = { x: e.clientX - host.left, y: e.clientY - host.top, on: true };
  };

  const onWheel = (e: WheelEvent) => {
    if (spec.type !== "line") return;
    e.preventDefault();
    const r = svgEl?.getBoundingClientRect();
    if (!r) return;
    const fx = ((e.clientX - r.left) * (W / r.width) - plot.l) / (plot.r - plot.l); // 0..1 in window
    const i0 = zoom ? zoom[0] : 0;
    const i1 = zoom ? zoom[1] : n - 1;
    const at = i0 + fx * (i1 - i0);
    const k = e.deltaY > 0 ? 1.18 : 1 / 1.18;
    let w = (i1 - i0) * k;
    if (w >= n - 1) {
      zoom = null;
      return;
    }
    w = Math.max(2, w);
    let a = at - fx * w;
    a = Math.max(0, Math.min(n - 1 - w, a));
    zoom = [a, a + w];
  };

  const clickShape = (i: number) => {
    if (moved > 3) return; // it was a drag, not a click
    link?.pick(ds, i);
    if (spec.type === "bar" || spec.type === "hbar") sortMode = (sortMode + 1) % 3;
    if (spec.type === "donut") iso = iso === i ? -1 : i;
  };

  const dim = (i: number) => (link && ds && link.has(ds) && !link.active(ds, i) ? 0.16 : 1);

  // ---- geometry per type
  const viewH = $derived(
    spec.type === "spark"
      ? 48
      : spec.type === "donut"
        ? Math.max(180, 24 + n * 20)
        : spec.type === "hbar"
          ? 30 + n * 26 + 8
          : spec.type === "line"
            ? 254 // 224 plot + x labels + brush strip
            : 238);

  // hbar track geometry (label column ends at 118)
  const hb = { x: 124, w: W - 188 };

  // donut: slice arcs + legend percentages from current (edited) values
  const donut = $derived.by(() => {
    const C = 2 * Math.PI * 58;
    const total = vals(0).reduce((a, b) => a + Math.abs(b), 0) || 1;
    let acc = 0;
    const rows = vals(0).map((v, i) => {
      const frac = Math.abs(v) / total;
      const row = { i, dash: frac * C, off: acc * C, pct: (frac * 100).toFixed(0) };
      acc += frac;
      return row;
    });
    return { C, rows };
  });
</script>

<svelte:window onpointermove={onMove} onpointerup={onUp} />

<div class="chart-wrap" style:cursor={cursor}>
  {#if spec.title}<div class="chart-title">{spec.title}</div>{/if}

  <svg bind:this={svgEl} viewBox="0 0 {W} {viewH}" width="100%" style="display:block" role="img" aria-label={spec.title ?? spec.type}
    onpointermove={onHover} onpointerleave={() => { hoverI = -1; tip = { ...tip, on: false }; }} onwheel={onWheel}>

    {#if spec.type === "spark"}
      <polyline points={seriesAll[0]!.values.map((v, i) => `${(2 + ((W - 4) * i) / Math.max(1, n - 1)).toFixed(1)},${(4 + 40 * (1 - (v - Math.min(...vals(0))) / (Math.max(...vals(0)) - Math.min(...vals(0)) || 1))).toFixed(1)}`).join(" ")} fill="none" style="stroke:var(--green,#3fb950)" stroke-width="1.5" />
      <circle cx={2 + ((W - 4) * (n - 1)) / Math.max(1, n - 1)} cy={4 + 40 * (1 - (vals(0)[n - 1]! - Math.min(...vals(0))) / (Math.max(...vals(0)) - Math.min(...vals(0)) || 1))} r="2.5" style="fill:var(--green,#3fb950)" />

    {:else if spec.type === "donut"}
      {@const cx = 90}
      {@const cy = Math.max(100, viewH / 2)}
      {#each donut.rows as r2 (r2.i)}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
        <circle cx={cx} cy={cy} r="58" fill="none" stroke-width={iso === r2.i ? 32 : 26} stroke-dasharray="{r2.dash.toFixed(2)} {donut.C.toFixed(2)}" stroke-dashoffset={(-r2.off).toFixed(2)} transform="rotate(-90 {cx} {cy})" style="stroke:{CHART_COLORS[r2.i % 5]}; transition: stroke-width .15s ease, opacity .15s ease" opacity={iso < 0 || iso === r2.i ? 1 : 0.15} onpointerdown={() => { moved = 0; }} onclick={() => clickShape(r2.i)} style:cursor="pointer" />
      {/each}
      <text x={cx} y={cy - 4} text-anchor="middle" font-size="12" style="fill:var(--fg,#e6edf3)">{fmt(stats.sum)}{unit}</text>
      <text x={cx} y={cy + 12} text-anchor="middle" font-size="10" style="fill:var(--dim,#8b949e)">total</text>
      {#each donut.rows as r2, p (r2.i)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <g transform="translate(0,{p * 20})" style="transition: transform .18s ease" onclick={() => clickShape(r2.i)} style:cursor="pointer">
          <rect x="190" y="16" width="10" height="10" rx="2" style="fill:{CHART_COLORS[r2.i % 5]}" opacity={iso < 0 || iso === r2.i ? 1 : 0.3} />
          <text x="206" y="25" font-size="11" opacity={iso < 0 || iso === r2.i ? 1 : 0.35} style="fill:var(--fg,#e6edf3)">{(labels[r2.i] ?? `#${r2.i + 1}`).slice(0, 18)} · {r2.pct}%</text>
        </g>
      {/each}

    {:else if spec.type === "hbar"}
      {#each order as i, p (i)}
        {@const y = 30 + p * 26}
        {@const v = vals(0)[i] ?? 0}
        {@const w = Math.max(2, (Math.abs(v) / Math.max(1e-9, ...vals(0).map(Math.abs), spec.max ?? 0)) * hb.w)}
        <g transform="translate(0,{y})" style="transition: transform .18s ease">
          <text x="118" y="12" text-anchor="end" font-size="11" style="fill:var(--dim,#8b949e)">{(labels[i] ?? `#${i + 1}`).slice(0, 14)}</text>
          <rect x={hb.x} y="0" width={hb.w} height="14" rx="3" style="fill:var(--line,#2a2f37)" opacity="0.35" />
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <rect x={hb.x} y="0" width={w} height="14" rx="3" style="fill:{v < 0 ? CHART_COLORS[4] : CHART_COLORS[i % 5]}; transition: width .12s ease" opacity={dim(i)} onpointerdown={(e) => { e.stopPropagation(); moved = 0; drag = { s: 0, i, ax: "x" }; }} onclick={() => clickShape(i)} style:cursor="ew-resize" />
          <text x={hb.x + hb.w + 6} y="12" font-size="11" style="fill:var(--fg,#e6edf3)">{fmt(v)}{unit}</text>
        </g>
      {/each}

    {:else}
      <!-- shared axes: bar + line -->
      {#each [0, 1, 2, 3] as g (g)}
        {@const gy = plot.bottom - ((plot.bottom - plot.top) * g) / 3}
        <line x1={plot.l} y1={gy} x2={plot.r} y2={gy} style="stroke:var(--line,#2a2f37)" />
        <text x={plot.r + 4} y={gy + 3} font-size="10" style="fill:var(--dim,#8b949e)">{fmt(scl.lo + ((scl.hi - scl.lo) * g) / 3)}{unit}</text>
      {/each}
      {#if scl.lo < 0 && scl.hi > 0}
        <line x1={plot.l} y1={scl.yi(0)} x2={plot.r} y2={scl.yi(0)} style="stroke:var(--dim,#8b949e)" stroke-width="1.5" />
      {/if}

      {#if spec.type === "bar"}
        {@const slot = (plot.r - plot.l) / n}
        {@const bw = Math.min(44, slot * 0.62)}
        {#each order as i, p (i)}
          {@const x = plot.l + slot * (p + 0.5)}
          {@const v = vals(0)[i] ?? 0}
          {@const by = Math.min(scl.yi(0), scl.yi(v))}
          {@const bh = Math.max(2, Math.abs(scl.yi(0) - scl.yi(v)))}
          <g transform="translate({x},0)" style="transition: transform .18s ease">
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <rect x={-bw / 2} y={by} width={bw} height={bh} rx="2" style="fill:{v < 0 ? CHART_COLORS[4] : CHART_COLORS[i % 5]}; transition: y .06s linear, height .06s linear" opacity={hoverI === i ? 1 : dim(i)} onpointerdown={() => { moved = 0; drag = { s: 0, i, ax: "y" }; }} onclick={() => clickShape(i)} style:cursor="ns-resize" />
            {#if n <= 14}<text x="0" y={by - 4} text-anchor="middle" font-size="10" style="fill:var(--fg,#e6edf3)">{fmt(v)}{unit}</text>{/if}
          </g>
          <text x={x} y={plot.bottom + 16} text-anchor="middle" font-size="10" style="fill:var(--dim,#8b949e)">{(labels[i] ?? `#${i + 1}`).slice(0, 10)}</text>
        {/each}

      {:else}
        <!-- line: pan surface, series, crosshair, brush strip -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <rect x={plot.l} y={plot.top} width={plot.r - plot.l} height={plot.bottom - plot.top} fill="transparent" onpointerdown={(e) => { moved = 0; pan = { px: e.clientX, i0: scl.i0, i1: scl.i1 }; }} ondblclick={() => (zoom = null)} style="cursor:grab" />
        {#each visible as s (s)}
          {@const pts = seriesAll[s]!.values.map((_, i) => i).filter((i) => i >= scl.i0 - 0.5 && i <= scl.i1 + 0.5).map((i) => `${scl.xi(i).toFixed(1)},${scl.yi(vals(s)[i] ?? 0).toFixed(1)}`).join(" ")}
          <polyline points={pts} fill="none" style="stroke:{CHART_COLORS[s % 5]}" stroke-width="2" />
          {#if n <= 60}
            {#each seriesAll[s]!.values as _, i (i)}
              {#if i >= scl.i0 - 0.5 && i <= scl.i1 + 0.5}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <circle cx={scl.xi(i)} cy={scl.yi(vals(s)[i] ?? 0)} r="4" style="fill:{CHART_COLORS[s % 5]}; transition: cy .06s linear" opacity={hoverI === i ? 1 : dim(i) < 1 ? 0.35 : 0.9} onpointerdown={(e) => { e.stopPropagation(); moved = 0; drag = { s, i, ax: "y" }; }} style:cursor="ns-resize" />
              {/if}
            {/each}
          {/if}
        {/each}
        {#if hoverI >= 0 && hoverI >= scl.i0 - 0.5 && hoverI <= scl.i1 + 0.5 && !drag}
          <line x1={scl.xi(hoverI)} y1={plot.top} x2={scl.xi(hoverI)} y2={plot.bottom} style="stroke:var(--dim,#8b949e)" stroke-dasharray="3 3" opacity="0.7" />
        {/if}
        {#each [0, 1, 2, 3, 4] as t (t)}
          {@const i = Math.round(scl.i0 + ((scl.i1 - scl.i0) * t) / 4)}
          {#if i >= 0 && i < n}
            <text x={scl.xi(i)} y={plot.bottom + 16} text-anchor="middle" font-size="10" style="fill:var(--dim,#8b949e)">{(labels[i] ?? `#${i + 1}`).slice(0, 10)}</text>
          {/if}
        {/each}
        {#if link && ds}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <rect x={plot.l} y="238" width={plot.r - plot.l} height="12" rx="2" style="fill:var(--line,#2a2f37)" opacity="0.5" onpointerdown={(e) => { e.stopPropagation(); moved = 0; brush = { a: idxAt(toSvg(e).x) }; }} style:cursor="crosshair" />
          <text x={plot.l + 4} y="247" font-size="8" style="fill:var(--dim,#8b949e)">drag to brush → highlight siblings</text>
        {/if}
      {/if}
      {#if spec.y}<text x={W - 4} y="16" text-anchor="end" font-size="9" style="fill:var(--dim,#8b949e)">{spec.y}</text>{/if}
      {#if spec.x}<text x={W - 4} y={viewH - 4} text-anchor="end" font-size="9" style="fill:var(--dim,#8b949e)">{spec.x}</text>{/if}
    {/if}
  </svg>

  {#if tip.on && hoverI >= 0 && !drag && spec.type !== "donut"}
    <div class="chart-tip" style:left="{Math.min(tip.x, 380)}px" style:top="{Math.max(0, tip.y - 56)}px">
      <div class="chart-tip-l">{labels[hoverI] ?? `#${hoverI + 1}`}</div>
      {#each visible.length ? visible : [0] as s (s)}
        <div><i style="background:{CHART_COLORS[s % 5]}"></i>{seriesAll[s]!.name || `s${s + 1}`} <b>{fmt(vals(s)[hoverI] ?? 0)}{unit}</b></div>
      {/each}
    </div>
  {/if}

  {#if seriesAll.length > 1 && (spec.type === "line" || spec.type === "bar")}
    <div class="chart-chips">
      {#each seriesAll as sr, s (s)}
        <button class="chart-chip" class:off={hidden.has(s)} onclick={() => { const hs = new Set(hidden); hs.has(s) ? hs.delete(s) : hs.add(s); hidden = hs; }}>
          <i style="background:{CHART_COLORS[s % 5]}"></i>{sr.name || `s${s + 1}`}
        </button>
      {/each}
    </div>
  {/if}

  <div class="chart-foot">
    <span class="chart-stats">n {stats.n} · min {fmt(stats.min)} · max {fmt(stats.max)} · μ {fmt(stats.mean)} · Σ {fmt(stats.sum)}{unit}</span>
    <span class="chart-btns">
      {#if spec.type === "bar" || spec.type === "hbar"}<button class="chart-btn" onclick={() => (sortMode = (sortMode + 1) % 3)}>sort {["off", "desc", "asc"][sortMode]}</button>{/if}
      {#if edited}<button class="chart-btn" onclick={() => (edit = {})}>reset edits</button>{/if}
      {#if zoom}<button class="chart-btn" onclick={() => (zoom = null)}>reset zoom</button>{/if}
      {#if link?.has(ds)}<button class="chart-btn" onclick={() => link?.clear(ds)}>clear sel</button>{/if}
    </span>
    {#if edited}<span class="chart-badge">edited</span>{/if}
  </div>
  <div class="chart-hint">
    {spec.type === "line" ? "drag points to edit · drag bg to pan · wheel to zoom · dblclick resets"
      : spec.type === "bar" ? "drag bars to edit · click a bar to sort"
      : spec.type === "hbar" ? "drag fills to edit · click a row to sort"
      : spec.type === "donut" ? "click a slice to isolate"
      : "hover for values"}
  </div>
</div>

<style>
  .chart-wrap { position: relative; border: 1px solid var(--line); background: var(--bg1); padding: 8px 12px 6px; }
  .chart-title { font-size: 12px; font-weight: bold; color: var(--fg); margin-bottom: 4px; text-align: center; }
  .chart-tip { position: absolute; pointer-events: none; background: var(--bg3, #161b22); border: 1px solid var(--line); padding: 4px 8px; font-size: 11px; color: var(--fg); z-index: 5; min-width: 110px; }
  .chart-tip-l { color: var(--dim); margin-bottom: 2px; }
  .chart-tip i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
  .chart-tip b { float: right; margin-left: 10px; }
  .chart-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
  .chart-chip { background: none; border: 1px solid var(--line); color: var(--fg); font-size: 10px; padding: 1px 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
  .chart-chip i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; }
  .chart-chip.off { opacity: 0.35; text-decoration: line-through; }
  .chart-foot { display: flex; align-items: center; gap: 8px; margin-top: 4px; flex-wrap: wrap; }
  .chart-stats { font-size: 10px; color: var(--dim); }
  .chart-btns { display: inline-flex; gap: 4px; }
  .chart-btn { background: none; border: 1px solid var(--line); color: var(--dim); font-size: 10px; padding: 0 6px; cursor: pointer; }
  .chart-btn:hover { color: var(--fg); border-color: var(--dim); }
  .chart-badge { font-size: 10px; color: var(--yellow, #d29922); border: 1px solid var(--yellow, #d29922); padding: 0 4px; }
  .chart-hint { font-size: 9px; color: var(--dim); opacity: 0.7; margin-top: 2px; }
</style>
