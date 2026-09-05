<script lang="ts">
  // Interactive chart renderer — the web tier of packages/client/charts.ts.
  // The strict validator lives there; the geometry/gesture math lives in
  // packages/client/chartmath.ts (unit-tested); this component only wires
  // pointer events to it and renders. All state is local: nothing round-trips
  // to the host, the spec is never mutated, and every label goes through
  // Svelte text interpolation (no {@html} on dynamic strings).
  //
  // Gestures use pointer capture on the <svg>, so no window listeners exist
  // while idle — N charts in a scrollback cost nothing until touched.
  import {
    fmt,
    CHART_COLORS,
    CHART_W as W,
    PLOT,
    HBAR,
    SPARK,
    computeScale,
    lineX,
    scaleY,
    valueAtY,
    lineIndexAtX,
    sparkX,
    sparkY,
    sparkIndexAtX,
    barLayout,
    barX,
    barIndexAtX,
    hbarRowAtY,
    hbarScaleMax,
    hbarWidth,
    hbarValueAtX,
    sortOrder,
    panWindow,
    wheelZoom,
    seriesStats,
    donutRows,
    clampTip,
    type ChartSpec,
    type Scale,
  } from "@dextui/client";
  import { ChartLink } from "../lib/chartlink.svelte";

  let { spec, link: linkProp }: { spec: ChartSpec; link?: ChartLink } = $props();

  // Selection link: shared per message when provided; a private one otherwise
  // so click-to-highlight still works on a lone chart. Charts without a
  // dataset id get a unique key so they never cross-talk.
  const uid = `#${Math.random().toString(36).slice(2, 8)}`;
  const localLink = new ChartLink();
  const link = $derived(linkProp ?? localLink);
  const ds = $derived(spec.dataset ?? uid);
  const linked = $derived(!!spec.dataset);

  const seriesAll = $derived(spec.series ?? [{ name: spec.title ?? "", values: spec.values }]);
  const labels = $derived(spec.labels ?? spec.values.map((_, i) => `#${i + 1}`));
  const unit = $derived(spec.unit ?? "");
  const n = $derived(spec.values.length);
  const type = $derived(spec.type);

  // ---- interaction state
  let hidden = $state(new Set<number>());
  let edit = $state<Record<number, number[]>>({});
  let sortMode = $state<0 | 1 | 2>(0);
  let zoom = $state<[number, number] | null>(null);
  let hoverI = $state(-1);
  let iso = $state(-1);
  let tip = $state({ x: 0, y: 0, on: false });
  let hostW = $state(560);
  let svgEl = $state<SVGSVGElement | null>(null);

  type Gesture =
    | { kind: "drag"; s: number; i: number; ax: "x" | "y"; sc: Scale; hiAbs: number; neg: boolean; moved: number }
    | { kind: "pan"; px: number; i0: number; w: number; moved: number }
    | { kind: "brush"; a: number; moved: number };
  let gesture = $state<Gesture | null>(null);

  const vals = (s: number): number[] => edit[s] ?? seriesAll[s]!.values;
  const visible = $derived(seriesAll.map((_, s) => s).filter((s) => !hidden.has(s)));
  const primary = $derived(visible[0] ?? 0);
  const edited = $derived(Object.keys(edit).length > 0);

  // Frozen for the duration of a drag so the axis does not rescale under the
  // cursor (the value may exceed the frozen max; the scale refits on release).
  const liveScale = $derived(computeScale((visible.length ? visible : [0]).map(vals), n, zoom, spec.max));
  const scl = $derived(gesture?.kind === "drag" ? gesture.sc : liveScale);
  const order = $derived(type === "bar" || type === "hbar" ? sortOrder(vals(0), sortMode) : vals(0).map((_, i) => i));
  const hiAbs = $derived(hbarScaleMax(vals(0), spec.max));
  const stats = $derived(seriesStats(vals(primary)));
  const donut = $derived(donutRows(vals(0)));
  const bars = $derived(barLayout(n));
  const showBrush = $derived(type === "line" && linked);
  const viewH = $derived(
    type === "spark" ? SPARK.h : type === "donut" ? Math.max(180, 24 + n * 20) : type === "hbar" ? HBAR.y0 + n * HBAR.rowH + 8 : PLOT.bottom + 48 + (showBrush ? 16 : 0),
  );
  const cursor = $derived(gesture ? (gesture.kind === "drag" ? (gesture.ax === "x" ? "ew-resize" : "ns-resize") : "grabbing") : "default");

  const setVal = (s: number, i: number, v: number) => {
    if (!Number.isFinite(v)) return;
    const arr = [...(edit[s] ?? seriesAll[s]!.values)];
    arr[i] = Math.round(v * 100) / 100;
    edit = { ...edit, [s]: arr };
  };

  const dim = (i: number) => (link.has(ds) && !link.active(ds, i) ? 0.16 : 1);

  // ---- pointer plumbing (viewBox coordinates)
  const toSvg = (e: PointerEvent | WheelEvent) => {
    const r = svgEl?.getBoundingClientRect();
    if (!r || !r.width) return { x: 0, y: 0 };
    return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * viewH) / r.height };
  };

  const hitIndex = (p: { x: number; y: number }): number => {
    if (type === "line") return lineIndexAtX(scl, p.x, n);
    if (type === "spark") return sparkIndexAtX(p.x, n);
    if (type === "bar") return barIndexAtX(p.x, n, order);
    if (type === "hbar") return hbarRowAtY(p.y, n, order);
    return -1;
  };

  const begin = (e: PointerEvent, g: Gesture) => {
    e.stopPropagation();
    gesture = g;
    hoverI = -1;
    tip = { ...tip, on: false };
    svgEl?.setPointerCapture(e.pointerId);
  };

  const startDrag = (e: PointerEvent, s: number, i: number, ax: "x" | "y") =>
    begin(e, { kind: "drag", s, i, ax, sc: liveScale, hiAbs, neg: (vals(s)[i] ?? 0) < 0, moved: 0 });

  const onPointerMove = (e: PointerEvent) => {
    const g = gesture;
    if (!g) {
      const p = toSvg(e);
      hoverI = hitIndex(p);
      const host = svgEl?.parentElement?.getBoundingClientRect();
      if (host) tip = { x: e.clientX - host.left, y: e.clientY - host.top, on: hoverI >= 0 };
      return;
    }
    g.moved++;
    const p = toSvg(e);
    if (g.kind === "drag") {
      if (g.ax === "x") setVal(g.s, g.i, hbarValueAtX(p.x, g.hiAbs, g.neg));
      else setVal(g.s, g.i, valueAtY(g.sc, p.y));
    } else if (g.kind === "pan") {
      const r = svgEl?.getBoundingClientRect();
      const di = r ? ((g.px - e.clientX) * (W / r.width) * scl.spanI) / (PLOT.r - PLOT.l) : 0;
      zoom = panWindow(g.i0, g.w, di, n);
    } else {
      link.range(ds, g.a, lineIndexAtX(scl, p.x, n));
    }
  };

  const onPointerUp = () => {
    const g = gesture;
    gesture = null;
    // A press without movement is a click: select (cross-highlight) that index.
    if (g && g.kind === "drag" && g.moved < 3) link.pick(ds, g.i);
  };

  const onLeave = () => {
    if (!gesture) {
      hoverI = -1;
      tip = { ...tip, on: false };
    }
  };

  // Svelte 5 marks only touchstart/touchmove passive, so preventDefault holds.
  const onWheel = (e: WheelEvent) => {
    if (type !== "line") return;
    e.preventDefault();
    const fx = (toSvg(e).x - PLOT.l) / (PLOT.r - PLOT.l);
    zoom = wheelZoom(zoom, n, fx, e.deltaY);
  };

  const cycleSort = () => (sortMode = ((sortMode + 1) % 3) as 0 | 1 | 2);
  const toggleSeries = (s: number) => {
    const hs = new Set(hidden);
    if (hs.has(s)) hs.delete(s);
    else hs.add(s);
    hidden = hs;
  };
  const tipPos = $derived(clampTip(tip.x, tip.y, hostW));
  const hint = $derived(
    type === "line"
      ? `drag points to edit · drag background to pan · wheel to zoom · dblclick resets${linked ? " · brush strip links siblings" : ""}`
      : type === "bar"
        ? "drag bars to edit · click a bar to highlight · sort via button or a label"
        : type === "hbar"
          ? "drag fills to edit · click a row to highlight · sort via button or a label"
          : type === "donut"
            ? "click a slice to isolate"
            : "hover for values",
  );
</script>

<div class="chart-wrap" style:cursor={cursor} bind:clientWidth={hostW} title={hint}>
  {#if spec.title}<div class="chart-title">{spec.title}</div>{/if}

  <svg bind:this={svgEl} viewBox="0 0 {W} {viewH}" width="100%" style="display:block; touch-action:none" role="img" aria-label={spec.title ?? type}
    onpointermove={onPointerMove} onpointerup={onPointerUp} onpointercancel={onPointerUp} onpointerleave={onLeave} onwheel={onWheel}>

    {#if type === "spark"}
      {@const sv = vals(0)}
      <polyline points={sv.map((v, i) => `${sparkX(i, n).toFixed(1)},${sparkY(v, sv).toFixed(1)}`).join(" ")} fill="none" style="stroke:var(--chart-1,#3fb950)" stroke-width="1.5" />
      <circle cx={sparkX(n - 1, n)} cy={sparkY(sv[n - 1] ?? 0, sv)} r="2.5" style="fill:var(--chart-1,#3fb950)" />
      {#if hoverI >= 0}<circle cx={sparkX(hoverI, n)} cy={sparkY(sv[hoverI] ?? 0, sv)} r="3.5" fill="none" style="stroke:var(--fg,#e6edf3)" />{/if}

    {:else if type === "donut"}
      {@const cx = 90}
      {@const cy = Math.max(100, viewH / 2)}
      {#each donut.rows as r2 (r2.i)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <circle cx={cx} cy={cy} r="58" fill="none" stroke-width={iso === r2.i ? 32 : 26} stroke-dasharray="{r2.dash.toFixed(2)} {donut.C.toFixed(2)}" stroke-dashoffset={(-r2.off).toFixed(2)} transform="rotate(-90 {cx} {cy})" style="stroke:{CHART_COLORS[r2.i % 5]}; cursor:pointer; transition: stroke-width .15s ease, opacity .15s ease" opacity={iso < 0 || iso === r2.i ? 1 : 0.15} onclick={() => (iso = iso === r2.i ? -1 : r2.i)} />
      {/each}
      <text x={cx} y={cy - 4} text-anchor="middle" font-size="12" style="fill:var(--fg,#e6edf3)">{fmt(iso >= 0 ? (vals(0)[iso] ?? 0) : stats.sum)}{unit}</text>
      <text x={cx} y={cy + 12} text-anchor="middle" font-size="10" style="fill:var(--dim,#8b949e)">{iso >= 0 ? (labels[iso] ?? "").slice(0, 14) : "total"}</text>
      {#each donut.rows as r2, p (r2.i)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <g transform="translate(0,{p * 20})" style="cursor:pointer" onclick={() => (iso = iso === r2.i ? -1 : r2.i)}>
          <rect x="190" y="16" width="10" height="10" rx="2" style="fill:{CHART_COLORS[r2.i % 5]}" opacity={iso < 0 || iso === r2.i ? 1 : 0.3} />
          <text x="206" y="25" font-size="11" opacity={iso < 0 || iso === r2.i ? 1 : 0.35} style="fill:var(--fg,#e6edf3)">{(labels[r2.i] ?? "").slice(0, 18)} · {r2.pct}% · {fmt(vals(0)[r2.i] ?? 0)}{unit}</text>
        </g>
      {/each}

    {:else if type === "hbar"}
      {#each order as i, p (i)}
        {@const v = vals(0)[i] ?? 0}
        <g transform="translate(0,{HBAR.y0 + p * HBAR.rowH})" style="transition: transform .18s ease">
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <text x="118" y="12" text-anchor="end" font-size="11" style="fill:var(--dim,#8b949e); cursor:pointer" onclick={cycleSort}>{(labels[i] ?? "").slice(0, 14)}</text>
          <rect x={HBAR.x} y="0" width={HBAR.w} height="14" rx="3" style="fill:var(--chart-grid,#2a2f37)" opacity="0.35" />
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <rect x={HBAR.x} y="0" width={hbarWidth(v, hiAbs)} height="14" rx="3" style="fill:{v < 0 ? CHART_COLORS[4] : CHART_COLORS[i % 5]}; cursor:ew-resize" opacity={hoverI === i ? 1 : dim(i)} onpointerdown={(e) => startDrag(e, 0, i, "x")} />
          <text x={HBAR.x + HBAR.w + 6} y="12" font-size="11" style="fill:var(--fg,#e6edf3)">{fmt(v)}{unit}</text>
        </g>
      {/each}

    {:else}
      {#each [0, 1, 2, 3] as g (g)}
        {@const gy = PLOT.bottom - ((PLOT.bottom - PLOT.top) * g) / 3}
        <line x1={PLOT.l} y1={gy} x2={PLOT.r} y2={gy} style="stroke:var(--chart-grid,#2a2f37)" opacity="0.55" />
        <text x={PLOT.r + 4} y={gy + 3} font-size="10" style="fill:var(--dim,#8b949e)">{fmt(scl.lo + ((scl.hi - scl.lo) * g) / 3)}{unit}</text>
      {/each}
      {#if scl.lo < 0 && scl.hi > 0}
        <line x1={PLOT.l} y1={scaleY(scl, 0)} x2={PLOT.r} y2={scaleY(scl, 0)} style="stroke:var(--dim,#8b949e)" stroke-width="1.5" />
      {/if}

      {#if type === "bar"}
        {#each order as i, p (i)}
          {@const x = barX(p, n)}
          {@const v = vals(0)[i] ?? 0}
          {@const y0 = scaleY(scl, 0)}
          {@const y1 = scaleY(scl, v)}
          {@const by = Math.max(0, Math.min(y0, y1))}
          {@const bh = Math.max(2, Math.abs(y0 - y1))}
          <g transform="translate({x},0)" style="transition: transform .18s ease">
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <rect x={-bars.bw / 2} y={by} width={bars.bw} height={bh} rx="2" style="fill:{v < 0 ? CHART_COLORS[4] : CHART_COLORS[i % 5]}; cursor:ns-resize" opacity={hoverI === i ? 1 : dim(i)} onpointerdown={(e) => startDrag(e, 0, i, "y")} />
          </g>
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <text x={x} y={PLOT.bottom + 16} text-anchor="middle" font-size="10" style="fill:var(--dim,#8b949e); cursor:pointer" onclick={cycleSort}>{(labels[i] ?? "").slice(0, 10)}</text>
        {/each}

      {:else}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <rect x={PLOT.l} y={PLOT.top} width={PLOT.r - PLOT.l} height={PLOT.bottom - PLOT.top} fill="transparent" style="cursor:grab" onpointerdown={(e) => begin(e, { kind: "pan", px: e.clientX, i0: scl.i0, w: scl.i1 - scl.i0, moved: 0 })} ondblclick={() => (zoom = null)} />
        {#each visible as s (s)}
          {@const sv = vals(s)}
          <polyline points={sv.map((v, i) => (i >= scl.i0 - 0.5 && i <= scl.i1 + 0.5 ? `${lineX(scl, i).toFixed(1)},${scaleY(scl, v).toFixed(1)}` : "")).filter(Boolean).join(" ")} fill="none" style="stroke:{CHART_COLORS[s % 5]}" stroke-width="2" />
          {#if n <= 60}
            {#each sv as v, i (i)}
              {#if i >= scl.i0 - 0.5 && i <= scl.i1 + 0.5}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <circle cx={lineX(scl, i)} cy={scaleY(scl, v)} r="4" style="fill:{CHART_COLORS[s % 5]}; cursor:ns-resize" opacity={hoverI === i ? 1 : dim(i) < 1 ? 0.35 : 0.9} onpointerdown={(e) => startDrag(e, s, i, "y")} />
              {/if}
            {/each}
          {/if}
        {/each}
        {#if hoverI >= 0 && !gesture}
          <line x1={lineX(scl, hoverI)} y1={PLOT.top} x2={lineX(scl, hoverI)} y2={PLOT.bottom} style="stroke:var(--dim,#8b949e)" stroke-dasharray="3 3" opacity="0.7" />
        {/if}
        {#each [0, 1, 2, 3, 4] as t (t)}
          {@const i = Math.round(scl.i0 + ((scl.i1 - scl.i0) * t) / 4)}
          {#if i >= 0 && i < n}
            <text x={lineX(scl, i)} y={PLOT.bottom + 16} text-anchor="middle" font-size="10" style="fill:var(--dim,#8b949e)">{(labels[i] ?? "").slice(0, 10)}</text>
          {/if}
        {/each}
        {#if showBrush}
          {@const sy = PLOT.bottom + 48}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <rect x={PLOT.l} y={sy} width={PLOT.r - PLOT.l} height="12" rx="2" style="fill:var(--chart-grid,#2a2f37); cursor:crosshair" opacity="0.5" onpointerdown={(e) => begin(e, { kind: "brush", a: lineIndexAtX(scl, toSvg(e).x, n), moved: 0 })} />
          {#if link.sel && link.sel.ds === ds}
            <rect x={lineX(scl, link.sel.lo)} y={sy} width={Math.max(2, lineX(scl, link.sel.hi) - lineX(scl, link.sel.lo))} height="12" rx="2" style="fill:var(--chart-2,#39c5cf); pointer-events:none" opacity="0.6" />
          {/if}
          <text x={PLOT.l + 4} y={sy + 9} font-size="8" class="brush-hint" style="fill:var(--dim,#8b949e); pointer-events:none">drag to brush → highlights siblings sharing "{spec.dataset}"</text>
        {/if}
      {/if}
      {#if spec.y}<text x={W - 4} y="16" text-anchor="end" font-size="9" style="fill:var(--dim,#8b949e)">{spec.y}</text>{/if}
      {#if spec.x}<text x={W - 4} y={PLOT.bottom + 30} text-anchor="end" font-size="9" style="fill:var(--dim,#8b949e)">{spec.x}</text>{/if}
    {/if}
  </svg>

  {#if tip.on && hoverI >= 0 && !gesture && type !== "donut"}
    <div class="chart-tip" style:left="{tipPos.left}px" style:top="{tipPos.top}px">
      <div class="chart-tip-l">{labels[hoverI] ?? `#${hoverI + 1}`}</div>
      {#each visible.length ? visible : [0] as s (s)}
        <div><i style="background:{CHART_COLORS[s % 5]}"></i>{seriesAll[s]!.name || `s${s + 1}`} <b>{fmt(vals(s)[hoverI] ?? 0)}{unit}</b></div>
      {/each}
    </div>
  {/if}

  {#if seriesAll.length > 1 && (type === "line" || type === "bar")}
    <div class="chart-chips">
      {#each seriesAll as sr, s (s)}
        <button class="chart-chip" class:off={hidden.has(s)} onclick={() => toggleSeries(s)}>
          <i style="background:{CHART_COLORS[s % 5]}"></i>{sr.name || `s${s + 1}`}
        </button>
      {/each}
    </div>
  {/if}

  <div class="chart-foot" class:dirty={edited || zoom !== null || sortMode !== 0 || link.has(ds) || iso >= 0}>
    <span class="chart-stats">n {stats.n} · min {fmt(stats.min)} · max {fmt(stats.max)} · μ {fmt(stats.mean)} · Σ {fmt(stats.sum)}{unit}</span>
    <span class="chart-btns">
      {#if type === "bar" || type === "hbar"}<button class="chart-btn" onclick={cycleSort}>sort {["off", "desc", "asc"][sortMode]}</button>{/if}
      {#if edited}<button class="chart-btn" onclick={() => (edit = {})}>reset edits</button>{/if}
      {#if zoom}<button class="chart-btn" onclick={() => (zoom = null)}>reset zoom</button>{/if}
      {#if link.has(ds)}<button class="chart-btn" onclick={() => link.clear(ds)}>clear highlight</button>{/if}
      {#if iso >= 0}<button class="chart-btn" onclick={() => (iso = -1)}>show all</button>{/if}
    </span>
    {#if edited}<span class="chart-badge">edited</span>{/if}
  </div>
</div>

<style>
  .chart-wrap { position: relative; padding: 2px 0 0; }
  .chart-title { font-size: 11px; color: var(--dim); margin-bottom: 2px; }
  .chart-tip { position: absolute; pointer-events: none; background: var(--bg3, #161b22); border: 1px solid var(--line); box-shadow: 0 2px 8px color-mix(in srgb, var(--bg) 35%, transparent); padding: 4px 8px; font-size: 11px; color: var(--fg); z-index: 5; min-width: 110px; }
  .chart-tip-l { color: var(--dim); margin-bottom: 2px; }
  .chart-tip i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
  .chart-tip b { float: right; margin-left: 10px; }
  .chart-chips { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 2px; }
  .chart-chip { background: none; border: none; color: var(--dim); font-size: 10px; padding: 0 2px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
  .chart-chip:hover { color: var(--fg); }
  .chart-chip i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; }
  .chart-chip.off { opacity: 0.4; }
  /* Controls stay out of the transcript's way until the chart is touched or
     carries state (edits/zoom/sort/selection); dirty keeps them visible. */
  .chart-foot { display: flex; align-items: baseline; gap: 8px; margin-top: 2px; flex-wrap: wrap; visibility: hidden; opacity: 0; transition: opacity .12s ease; }
  .chart-wrap:hover .chart-foot, .chart-foot:focus-within, .chart-foot.dirty { visibility: visible; opacity: 1; }
  .chart-stats { font-size: 10px; color: var(--dim); }
  .chart-btns { display: inline-flex; gap: 8px; flex-wrap: wrap; }
  .chart-btn { background: none; border: none; color: var(--dim); font-size: 10px; padding: 0; cursor: pointer; }
  .chart-btn:hover { color: var(--fg); text-decoration: underline; }
  .chart-badge { font-size: 10px; color: var(--yellow, #d29922); }
  .brush-hint { opacity: 0; transition: opacity .12s ease; }
  .chart-wrap:hover .brush-hint { opacity: 0.8; }
</style>
