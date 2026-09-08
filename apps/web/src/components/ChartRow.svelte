<script lang="ts">
  // Measured chart row — the dynamic half of the markdown tape layout.
  //
  // Given consecutive charts, this row measures the real space it may use:
  // whatever is left on the tape's last flex line beside the table cards. If
  // that space fits two legible charts, they sit side by side and share it;
  // otherwise the row wraps below the tables and the charts pair up across
  // the full width. No fixed pixel assumptions — gutters and thresholds both
  // come from measured layout, so it reacts to pane, font, and table changes
  // alike.
  import Chart from "./Chart.svelte";
  import { ChartLink } from "../lib/chartlink.svelte";
  import type { ChartSpec } from "@dextui/client";

  let { charts, link = undefined }: { charts: { spec: ChartSpec }[]; link?: ChartLink } = $props();

  const MIN = 340; // narrowest chart that still reads

  let host = $state<HTMLElement | null>(null);
  let rowW = $state(0); // px width this row may use (0 until first measure)
  let full = $state(true); // wrapped to its own full-width line below the tables
  let gap = $state(24); // measured tape column gap (1.5rem at the default root size)

  const k = $derived(charts.length);
  const per = $derived(Math.min(k, 2)); // charts per line
  const need = $derived(per * MIN + (per - 1) * gap);
  const fits = $derived(rowW >= need);
  const cellW = $derived(fits ? Math.floor((rowW - (per - 1) * gap) / per) : rowW);

  $effect(() => {
    if (!host) return;
    const parent = host.parentElement;
    if (!parent) return;
    const measure = () => {
      const cw = parent.clientWidth;
      if (!cw) return;
      const g = parseFloat(getComputedStyle(parent).columnGap) || 24;
      const needNow = per * MIN + (per - 1) * g;
      gap = g;
      // Cards before us on the tape's LAST flex line: items on one line share
      // their top (align-items: flex-start) and later DOM order can never sit
      // on an earlier line, so the deepest top marks the last line and its
      // widest right edge is what we must fit beside. Measuring per line —
      // not summing every predecessor — keeps a wrapped table stack honest.
      let any = false;
      let lastTop = 0;
      let lastRight = 0;
      for (const el of parent.children) {
        if (el === host) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (!any || r.top > lastTop + 1) {
          any = true;
          lastTop = r.top;
          lastRight = r.right;
        } else if (r.top > lastTop - 1) {
          lastRight = Math.max(lastRight, r.right);
        }
      }
      const left = parent.getBoundingClientRect().left;
      const avail = cw - (any ? lastRight - left : 0);
      if (avail >= needNow) {
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
    // The tape's card set is fixed once a run renders (later content appends
    // as new runs with their own tape), so this snapshot is complete; sibling
    // resizes (font swap, stream growth) re-trigger measure above.
    for (const el of [...parent.children]) if (el !== host) ro.observe(el);
    return () => ro.disconnect();
  });
</script>

<div class="crow" bind:this={host} style:width={full || !rowW ? "100%" : `${rowW}px`} style:column-gap={`${gap}px`}>
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
    gap: 1rem 24px; /* row gap matches the tape; the column gap is measured and set inline */
    align-items: flex-start;
    flex: 0 0 auto; /* width is set from measurements, never grown/shrunk by flex */
    min-width: 0;
  }
  .crow__cell {
    min-width: 0;
  }
</style>
