<script lang="ts">
  // Segmented meter — the block-bar look ("█░") rendered as real DOM segments
  // with theme colors. Font glyphs (█ vs ░) sit on different baselines and
  // heights, which made in-progress bars look taller than finished ones; DOM
  // segments are pixel-identical in every state and follow the theme vars.
  let {
    pct = 0,
    segments = 10,
    tone = "auto",
  }: { pct?: number; segments?: number; tone?: "auto" | "green" } = $props();

  const filled = $derived(
    Math.max(
      0,
      Math.min(segments, Math.round((Math.min(100, Math.max(0, pct)) / 100) * segments)),
    ),
  );
  const toneClass = $derived(
    tone === "green"
      ? "green"
      : pct >= 90
        ? "red"
        : pct >= 70
          ? "yellow"
          : "cyan",
  );
</script>

<span
  class={`meter {toneClass}`}
  role="meter"
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={Math.round(pct)}
  aria-label={`${Math.round(pct)}%`}
>
  {#each Array(segments) as _, i (i)}
    <i class:full={i < filled}></i>
  {/each}
</span>

<style>
  .meter {
    display: inline-flex;
    gap: 1px;
    height: 8px;
    vertical-align: -1px;
  }
  .meter i {
    width: 4px;
    border-radius: 1px;
    background: color-mix(in srgb, currentColor 16%, transparent);
  }
  .meter i.full {
    background: currentColor;
  }
  .meter.cyan {
    color: var(--cyan);
  }
  .meter.green {
    color: var(--green);
  }
  .meter.yellow {
    color: var(--yellow);
  }
  .meter.red {
    color: var(--red);
  }
</style>
