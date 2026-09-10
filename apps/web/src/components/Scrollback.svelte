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
  // The canonical store stays flat/lossless; Bash remains standalone, while
  // compactable tool classes become lazy disclosures.
  const items = $derived(app.compactTools
    ? transcriptItems(visible)
    : visible.map((block): TranscriptItem => ({ kind: "block", id: block.id, block })));

  // Manual disclosure state is keyed by stable session + first-block IDs, so
  // streaming updates and session switches do not snap open rows shut. Clean
  // and running activity starts compact; failures open unless the user already
  // made a choice. No status transition ever auto-closes a disclosure.
  let disclosure = $state<Record<string, boolean>>({});
  let disclosureTouched = $state<Record<string, boolean>>({});
  let toolDisclosure = $state<Record<string, boolean>>({});
  let toolDisclosureTouched = $state<Record<string, boolean>>({});
  let windowSession = $state("");
  const sessionGeneration = $derived(app.sessions.find((s) => s.id === view.id)?.generation ?? 0);
  const keyOf = (item: TranscriptItem) => `${app.hostEpoch}:${view.id}:${sessionGeneration}:${item.kind}:${item.id}`;
  function itemOpen(item: TranscriptItem): boolean {
    return disclosure[keyOf(item)] ?? false;
  }
  function setItemOpen(item: TranscriptItem, open: boolean, user = true) {
    // Explicit disclosure buttons call this only for a user choice; keeping
    // state outside the derived grouping prevents stream updates snapping shut.
    if (user) {
      const key = keyOf(item);
      disclosure[key] = open;
      disclosureTouched[key] = true;
    }
  }
  const toolKey = (callId: string) => `${app.hostEpoch}:${view.id}:${sessionGeneration}:tool:${callId}`;
  function toolOpen(tool: Extract<ViewBlock, { kind: "tool" }>): boolean {
    return toolDisclosure[toolKey(tool.call_id)] ?? false;
  }
  function setToolOpen(tool: Extract<ViewBlock, { kind: "tool" }>, open: boolean, user = true) {
    if (!user) return;
    const key = toolKey(tool.call_id);
    toolDisclosure[key] = open;
    toolDisclosureTouched[key] = true;
  }
  // Keep the maps sparse: ordinary collapsed groups/calls need no entry. Only
  // user choices and automatic failure opens are stored. This avoids hundreds
  // of reactive writes in a long visible transcript while retaining the rule
  // that nothing ever auto-closes.
  $effect(() => {
    void items;
    let nextGroups: Record<string, boolean> | undefined;
    let nextTools: Record<string, boolean> | undefined;
    for (const item of items) {
      if (item.kind !== "activity") continue;
      const failed = item.tools.some((tool) => tool.status === "failed");
      const key = keyOf(item);
      if (failed && !disclosureTouched[key] && disclosure[key] !== true) {
        nextGroups ??= { ...disclosure };
        nextGroups[key] = true;
      }
      for (const tool of item.tools) {
        if (tool.status !== "failed") continue;
        const tKey = toolKey(tool.call_id);
        if (!toolDisclosureTouched[tKey] && toolDisclosure[tKey] !== true) {
          nextTools ??= { ...toolDisclosure };
          nextTools[tKey] = true;
        }
      }
    }
    if (nextGroups) disclosure = nextGroups;
    if (nextTools) toolDisclosure = nextTools;
  });
  const anyDetailsOpen = $derived(items.some((item) => item.kind !== "block" && itemOpen(item)));
  function collapseWork() {
    // Refold every remembered disclosure, including groups currently outside
    // the 300-block window; otherwise "show older" could resurrect an expanded
    // row after the user explicitly collapsed all work details.
    for (const key of Object.keys(disclosure)) {
      disclosure[key] = false;
      disclosureTouched[key] = true;
    }
    for (const key of Object.keys(toolDisclosure)) {
      toolDisclosure[key] = false;
      toolDisclosureTouched[key] = true;
    }
    // Untouched collapsed items have no sparse-map entry. Mark all currently
    // visible groups/calls as user-collapsed so failures do not auto-reopen.
    for (const item of items) {
      if (item.kind === "block") continue;
      const key = keyOf(item);
      disclosure[key] = false;
      disclosureTouched[key] = true;
      if (item.kind === "activity") {
        for (const tool of item.tools) {
          const tKey = toolKey(tool.call_id);
          toolDisclosure[tKey] = false;
          toolDisclosureTouched[tKey] = true;
        }
      }
    }
  }
  // Switching sessions starts at the newest slice again. Fold choices remain
  // keyed by session for this page lifetime, so switching away/back preserves
  // them too; a page refresh remounts and intentionally resets them.
  $effect(() => {
    const id = view.id;
    if (id === windowSession) return;
    windowSession = id;
    windowSize = WINDOW;
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
              open={itemOpen(item)}
              onToggle={(open, user) => setItemOpen(item, open, user)}
              getToolOpen={toolOpen}
              setToolOpen={setToolOpen}
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
