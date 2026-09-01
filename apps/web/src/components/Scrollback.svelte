<script lang="ts">
  // Scrollback: one stream, like a terminal. No filter chips, no cards.
  // Web-native where it matters: scroll pinning + jump-to-latest.
  import type { SessionStore } from "@dextui/client";
  import type { Block as BlockT } from "@dextui/protocol";
  import Block from "./Block.svelte";
  import { fmtElapsed } from "../lib/markdown";

  let { store, onInspect }: { store: SessionStore; onInspect?: (b: BlockT) => void } = $props();

  let tick = $state(0);
  let container: HTMLDivElement | undefined = $state();
  let pinned = $state(true);

  $effect(() => {
    const unsub = store.subscribe(() => {
      tick++;
    });
    return () => {
      unsub();
    };
  });

  const view = $derived.by(() => {
    void tick;
    // Re-boxed per tick: Svelte 5 deriveds skip propagation on reference equality.
    return { ...store.state };
  });

  // Copy each block: keyed each-items only re-render when their reference
  // changes, and the store mutates blocks in place (preview -> running -> ok).
  const shown = $derived(view.blocks.map((b) => ({ ...b })));

  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => {
      clearInterval(t);
    };
  });

  function onScroll() {
    if (!container) return;
    pinned = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  }

  $effect(() => {
    void tick;
    if (pinned && container) container.scrollTop = container.scrollHeight;
  });

  function jump() {
    pinned = true;
    if (container) container.scrollTop = container.scrollHeight;
  }
</script>

<div
  class="sb-wrap"
  data-agent-id="transcript.root"
  data-state={view.pending.size > 0 ? "awaiting_approval" : view.working ? "working" : "idle"}
>
  <div bind:this={container} onscroll={onScroll} class="sb">
    <div class="sb-axis content-axis">
      {#if view.blocks.length === 0}
        <div class="sb-empty" data-agent-id="transcript.empty">
          <p><span class="st-green">❯</span> <span class="dim">fresh session — type a request below.</span></p>
          <p class="faint">journal events replay here on connect · / commands · ⌘k finder</p>
        </div>
      {:else}
        {#each shown as block, i (i)}
          <Block {block} {onInspect} />
        {/each}
        {#if view.working}
          <p class="sb-working" data-agent-id="transcript.working">
            <span class="st-yellow pulse">●</span>
            <span class="dim">
              working{view.compacting ? " · compacting" : ""}{view.turnStartedAt ? ` · ${fmtElapsed(now - view.turnStartedAt)}` : ""}
            </span>
          </p>
        {/if}
      {/if}
    </div>
  </div>

  {#if !pinned}
    <button class="sb-jump" data-agent-id="transcript.jump" onclick={jump}>↓ latest</button>
  {/if}
</div>

<style>
  .sb-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .sb {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-block: clamp(0.65rem, 1.6vh, 1.25rem) clamp(1rem, 2.5vh, 2rem);
    scrollbar-gutter: stable;
  }
  .sb-axis {
    min-height: 100%;
    display: flex;
    flex-direction: column;
    gap: clamp(6px, 0.8vh, 11px);
  }
  .sb-empty {
    margin-block: auto;
    padding-block: min(18vh, 10rem);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .sb-working {
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  .sb-jump {
    position: absolute;
    bottom: 8px;
    right: 16px;
    padding: 2px 10px;
    border: 1px solid var(--line);
    background: var(--bg1);
    color: var(--dim);
  }
  .sb-jump:hover {
    color: var(--fg);
    border-color: var(--dim);
  }
  .st-green {
    color: var(--green);
  }
  .st-yellow {
    color: var(--yellow);
  }
  .dim {
    color: var(--dim);
  }
  .faint {
    color: var(--faint);
  }
</style>
