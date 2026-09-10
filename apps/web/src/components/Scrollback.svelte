<script lang="ts">
  // Scrollback: one stream, like a terminal. No filter chips, no cards.
  // Web-native where it matters: scroll pinning + jump-to-latest.
  import type { SessionStore, ViewBlock } from "@dextui/client";
  import Block from "./Block.svelte";
  import ActivityGroup from "./ActivityGroup.svelte";
  import WorkMeta from "./WorkMeta.svelte";
  import PackGallery from "./PackGallery.svelte";
  import { transcriptItems, type TranscriptItem } from "../lib/transcript-groups";
  import { app } from "../lib/state.svelte";
  import { fmtElapsed } from "../lib/markdown";
  import { useSession } from "../lib/useSession.svelte";

  let { store, onInspect }: { store: SessionStore; onInspect?: (b: ViewBlock) => void } = $props();

  let container: HTMLDivElement | undefined = $state();
  let pinned = $state(true);
  // Windowing: a long session renders only the newest slice; older blocks are
  // one click away. Keeps the DOM bounded in marathon sessions.
  const WINDOW = 300;
  const WINDOW_STEP = 300;
  let windowSize = $state(WINDOW);

  const sess = useSession(() => store);
  // Non-null while mounted: App only renders Scrollback with a store.
  const view = $derived(sess.view ?? store.state);
  const hidden = $derived(Math.max(0, view.blocks.length - windowSize));
  const visible = $derived(view.blocks.slice(-windowSize));
  // Presentation grouping runs only over the already-bounded visible window.
  // The canonical store stays flat/lossless; Bash and other rich tools remain
  // standalone blocks, while structural reads/edits become lazy disclosures.
  const items = $derived(app.compactTools
    ? transcriptItems(visible)
    : visible.map((block): TranscriptItem => ({ kind: "block", id: block.id, block })));

  // Manual disclosure state is keyed by stable first-block IDs, so streaming
  // updates and regrouping do not snap open rows shut. Untouched running/failed
  // activity defaults open; completed clean activity defaults folded.
  let disclosure = $state<Record<string, boolean>>({});
  const keyOf = (item: TranscriptItem) => `${item.kind}:${item.id}`;
  function defaultOpen(item: TranscriptItem): boolean {
    return item.kind === "activity" && item.tools.some((t) => t.status === "running" || t.status === "preview" || t.status === "failed");
  }
  function itemOpen(item: TranscriptItem): boolean {
    const key = keyOf(item);
    return key in disclosure ? disclosure[key]! : defaultOpen(item);
  }
  function setItemOpen(item: TranscriptItem, open: boolean, user = true) {
    // Explicit disclosure buttons call this only for a user choice; keeping
    // state outside the derived grouping prevents stream updates snapping shut.
    if (user) disclosure[keyOf(item)] = open;
  }
  const anyDetailsOpen = $derived(items.some((item) => item.kind !== "block" && itemOpen(item)));
  function collapseWork() {
    for (const item of items) if (item.kind !== "block") disclosure[keyOf(item)] = false;
  }
  // Switching sessions starts at the newest slice again.
  $effect(() => {
    void view.id;
    windowSize = WINDOW;
    disclosure = {};
  });

  let now = $state(Date.now());
  $effect(() => {
    if (!view.working && !view.compacting) return;
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
    void view.compacting;
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
  data-state={view.pending.size > 0 ? "awaiting_approval" : view.compacting ? "compacting" : view.working ? "working" : "idle"}
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
        {#if hidden > 0}
          <button class="sb-older" data-agent-id="transcript.older" onclick={() => (windowSize += WINDOW_STEP)}>
            ↑ show {Math.min(hidden, WINDOW_STEP)} older{hidden > WINDOW_STEP ? ` of ${hidden}` : ""}
          </button>
        {/if}
        {#if anyDetailsOpen}
          <button class="work-collapse" data-agent-id="transcript.collapse-work" onclick={collapseWork}>Collapse work details</button>
        {/if}
        {#each items as item (keyOf(item))}
          {#if item.kind === "activity"}
            <ActivityGroup
              id={item.id}
              tools={item.tools}
              activity={item.activity}
              caption={item.caption}
              progress={item.progress}
              open={itemOpen(item)}
              onToggle={(open, user) => setItemOpen(item, open, user)}
              {onInspect}
              sessionId={view.id}
            />
          {:else if item.kind === "meta"}
            <WorkMeta id={item.id} blocks={item.blocks} open={itemOpen(item)} onToggle={(open, user) => setItemOpen(item, open, user)} />
          {:else}
            <Block block={item.block} {onInspect} sessionId={view.id} />
          {/if}
        {/each}
        {#if view.compacting || view.working}
          <p class="sb-working" data-agent-id="transcript.working" aria-live="polite">
            <span class={view.compacting ? "st-magenta pulse" : "st-yellow pulse"}>●</span>
            <span class="dim">
              {view.compacting ? "Compacting context" : "Working"}{view.turnStartedAt ? ` · ${fmtElapsed(now - view.turnStartedAt)}` : ""}
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
  .work-collapse {
    align-self: flex-end;
    border: 0;
    background: transparent;
    color: var(--faint);
    font-size: 11px;
    padding: 1px 0;
  }
  .work-collapse:hover { color: var(--fg); }
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
  .sb-older {
    align-self: center;
    padding: 2px 12px;
    margin-block: 2px 4px;
    border: 1px dashed var(--line);
    background: transparent;
    color: var(--dim);
    font-size: 11px;
  }
  .sb-older:hover {
    color: var(--fg);
    border-color: var(--dim);
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
  .st-magenta {
    color: var(--magenta);
  }
  .dim {
    color: var(--dim);
  }
  .faint {
    color: var(--faint);
  }
</style>
