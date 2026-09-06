<script lang="ts">
  // Tier 1 — crews section in the index rail, directly beneath the queue.
  // Global (runs outlive sessions), attention-sorted by the host, 3 visible +
  // "n more", unmounts when empty. Observation only: the one decision
  // (escalation) also lives in the queue as a row — this list never badges.
  import { crew, crewEnabled, crewDur, crewAge, crewIdle, openRun, shortRun, toggleCrewRail, GLYPH } from "../lib/crew.svelte";
  import type { CrewRun } from "../lib/crew.svelte";

  let { onPick }: { onPick?: () => void } = $props();

  const CAP = 3;
  const enabled = $derived(crewEnabled() && crew.runs.length > 0);
  const visible = $derived(crew.railAll ? crew.runs : crew.runs.slice(0, CAP));
  const hidden = $derived(crew.runs.length - visible.length + crew.omitted);
  const live = $derived(crew.runs.filter((r) => r.status !== "completed" && r.state !== "stopped" && r.status !== "failed").length);

  let now = $state(Date.now());
  $effect(() => {
    if (live === 0) return;
    const t = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => {
      clearInterval(t);
    };
  });

  function meta(r: CrewRun): string {
    const c = r.counts;
    if (r.status === "paused") return `Awaiting answer · ${crewDur(crewIdle(r, now))}`;
    if (r.status === "running" || r.status === "pending") return `${c.done}/${c.total} · ${crewDur(crewAge(r, now))}`;
    if (r.state === "stopped") return `Stopped · ${c.done}/${c.total}`;
    if (r.status === "failed") return `${c.fail} failed · ${c.done}/${c.total}`;
    return `${c.done}/${c.total} · ${crewDur(r.duration_ms)}`;
  }

  function go(id: string) {
    openRun(id);
    onPick?.();
  }
</script>

{#if enabled}
  <section class="crews" data-agent-id="crew.rail" data-state={crew.railOpen ? "expanded" : "collapsed"} aria-label="Crew runs">
    <button class="crews-head" data-agent-id="crew.rail.toggle" aria-expanded={crew.railOpen} onclick={toggleCrewRail}>
      <span class="faint">{crew.railOpen ? "▾" : "▸"}</span>
      <span class="dim">Crews</span>
      <span class="faint">{crew.runs.length + crew.omitted}</span>
    </button>
    {#if crew.railOpen}
      <div class="crews-list">
        {#each visible as r (r.id)}
          <button
            class={`crew-row st-${r.state}`}
            data-agent-id={`crew.rail.${r.id}`}
            data-state={r.state}
            title={r.task}
            onclick={() => go(r.id)}
          >
            <span class={`glyph ${r.state === "running" ? "pulse" : ""}`}>{GLYPH[r.state]}</span>
            <span class="lbl truncate"><span class="id">{shortRun(r.id)}</span> · {r.task || r.mode}</span>
            <span class="dim meta">{meta(r)}</span>
          </button>
        {/each}
        {#if hidden > 0 || crew.railAll}
          <button class="crew-more faint" data-agent-id="crew.rail.more" data-state={crew.railAll ? "expanded" : "collapsed"} onclick={() => (crew.railAll = !crew.railAll)}>
            {crew.railAll ? "▴ Fewer" : `▾ ${hidden} more`}{crew.omitted > 0 && crew.railAll ? ` · ${crew.omitted} not listed by host` : ""}
          </button>
        {/if}
      </div>
    {/if}
  </section>
{/if}

<style>
  .crews {
    border-bottom: 1px solid var(--line);
  }
  .crews-head {
    width: 100%;
    display: flex;
    gap: 6px;
    padding: 6px 10px 4px;
    align-items: baseline;
  }
  .crews-head:hover {
    background: var(--bg2);
  }
  .crews-list {
    max-height: 30dvh;
    overflow-y: auto;
    padding-bottom: 4px;
  }
  .crew-row {
    display: flex;
    gap: 6px;
    width: 100%;
    min-width: 0;
    padding: 2px 10px;
    align-items: baseline;
    text-align: left;
  }
  .crew-row:hover {
    background: var(--bg2);
  }
  .glyph {
    flex-shrink: 0;
    width: 1ch;
  }
  .lbl {
    flex: 1;
    min-width: 0;
    color: var(--fg);
  }
  .id {
    color: var(--dim);
  }
  .meta {
    flex-shrink: 0;
    font-size: 11px;
  }
  .crew-more {
    padding: 2px 10px 2px 26px;
    width: 100%;
    text-align: left;
  }
  .crew-more:hover {
    background: var(--bg2);
  }
  .truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Semantic, never literal: one class per state, both themes via the same vars. */
  .st-pending .glyph { color: var(--faint); }
  .st-running .glyph { color: var(--cyan); }
  .st-completed .glyph { color: var(--green); }
  .st-failed .glyph { color: var(--red); }
  .st-paused .glyph { color: var(--yellow); }
  .st-stopped .glyph, .st-stopped .lbl { color: var(--dim); }
  .dim { color: var(--dim); }
  .faint { color: var(--faint); }
</style>
