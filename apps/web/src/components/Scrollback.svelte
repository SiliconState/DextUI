<script lang="ts">
  // Scrollback: one stream, like a terminal. No filter chips, no cards.
  // Web-native where it matters: scroll pinning + jump-to-latest.
  import type { SessionStore, ViewBlock } from "@dextui/client";
  import Block from "./Block.svelte";
  import PackGallery from "./PackGallery.svelte";
  import { app } from "../lib/state.svelte";
  import { fmtElapsed } from "../lib/markdown";
  import { useSession } from "../lib/useSession.svelte";

  let { store, onInspect }: { store: SessionStore; onInspect?: (b: ViewBlock) => void } = $props();

  let container: HTMLDivElement | undefined = $state();
  let pinned = $state(true);

  const sess = useSession(() => store);
  // Non-null while mounted: App only renders Scrollback with a store.
  const view = $derived(sess.view ?? store.state);

  let now = $state(Date.now());
  $effect(() => {
    if (!view.working) return;
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
    void view.blocks;
    void view.working;
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
          <p><span class="st-green">❯</span> <span class="dim">fresh session — type a request below{app.packs.length ? ", or pick a pack:" : "."}</span></p>
          {#if app.packs.length}
            <PackGallery compact />
          {/if}
          <p class="faint">journal events replay here on connect · / commands · ⌘k finder{app.packs.length ? " · g packs" : ""}</p>
        </div>
      {:else}
        {#each view.blocks as block (block.id)}
          <Block {block} {onInspect} sessionId={view.id} />
        {/each}
        {#if view.working}
          <p class="sb-working" data-agent-id="transcript.working" aria-live="polite">
            <span class="st-yellow pulse">●</span>
            <span class="dim">
              Working{view.compacting ? " · compacting" : ""}{view.turnStartedAt ? ` · ${fmtElapsed(now - view.turnStartedAt)}` : ""}
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
