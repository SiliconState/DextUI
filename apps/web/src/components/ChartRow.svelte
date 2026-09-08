<script lang="ts">
  // Measured chart row — the dynamic half of the markdown tape layout.
  //
  // Given consecutive charts, this row measures the real space it may use:
  // the tape container's width minus whatever table cards sit to its left on
  // the same flex line. If that space fits two legible charts, they sit side
  // by side and share it; otherwise the row wraps below the tables and the
  // charts pair up across the full width. No fixed pixel assumptions — every
  // decision comes from ResizeObserver measurements, so it reacts to pane,
  // font, and table changes alike.
  import Chart from "./Chart.svelte";
  import { ChartLink } from "../lib/chartlink.svelte";
  import type { ChartSpec } from "@dextui/client";

  let { charts, link = undefined }: { charts: { spec: ChartSpec }[]; link?: ChartLink } = $props();

  const MIN = 340; // narrowest chart that still reads
  const GAP = 24; // column gap (matches .md-tape's 1.5rem gutter)

  let host = $state<HTMLElement | null>(null);
  let rowW = $state(0); // px width this row may use (0 until first measure)
  let full = $state(true); // wrapped to its own full-width line below the tables

  const k = $derived(charts.length);
  const per = $derived(Math.min(k, 2)); // charts per line
  const fits = $derived(rowW >= per * MIN + (per - 1) * GAP);
  const cellW = $derived(fits ? Math.floor((rowW - (per - 1) * GAP) / per) : rowW);

  $effect(() => {
    if (!host) return;
    const parent = host.parentElement;
    if (!parent) return;
    const measure = () => {
      const cw = parent.clientWidth;
      if (!cw) return;
      let used = 0;
      for (const el of [...parent.children]) {
        if (el === host) break; // only siblings ahead of us on the line
        used += el.getBoundingClientRect().width + GAP;
      }
      const avail = cw - used;
      if (avail >= per * MIN + (per - 1) * GAP) {
        rowW = avail; // share the line with the tables
        full = false;
      } else {
        rowW = cw; // wrap below; across the full width (pairs land side by side here)
        full = true;
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    for (const el of [...parent.children]) if (el !== host) ro.observe(el);
    return () => ro.disconnect();
  });
</script>

<div class="crow" bind:this={host} style:width={full || !rowW ? "100%" : `${rowW}px`}>
  {#each charts as ch, i (i)}
    <div class="crow__cell" data-agent-id="markdown.chart" style:width={k > 1 && fits ? `${cellW}px` : "100%"}>
      <Chart spec={ch.spec} {link} compact />
    </div>
  {/each}
</div>

<style>
  .crow {
    display: flex;
    flex-wrap: wrap;
    gap: 12px 24px;
    align-items: flex-start;
    flex: 0 0 auto; /* width is set from measurements, never grown/shrunk by flex */
    min-width: 0;
  }
  .crow__cell {
    min-width: 0;
  }
</style>
