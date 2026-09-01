<script lang="ts">
  import type { SessionStore } from "@dextui/client";
  import type { Block } from "@dextui/protocol";
  import BlockView from "./BlockView.svelte";
  import { fmtElapsed } from "../lib/markdown";

  let { store, onInspect }: { store: SessionStore; onInspect?: (b: Block) => void } = $props();

  let tick = $state(0);
  let container: HTMLDivElement | undefined = $state();
  let pinned = $state(true);
  let filter = $state<"all" | "text" | "tool" | "thinking" | "warn">("all");

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
    // Re-boxed per tick: see App.svelte note on Svelte 5 derived equality.
    return { ...store.state };
  });

  const counts = $derived.by(() => {
    let tool = 0;
    let thinking = 0;
    let warn = 0;
    for (const b of view.blocks) {
      if (b.kind === "tool") tool++;
      else if (b.kind === "thinking") thinking++;
      else if (b.kind === "marker" && (b.level === "warn" || b.level === "error")) warn++;
    }
    return { tool, thinking, warn };
  });

  const shown = $derived(
    // Copy each block: keyed each-items only re-render when their reference
    // changes, and the store mutates blocks in place (preview -> running -> ok).
    view.blocks
      .map((b) => ({ ...b }))
      .filter((b) => {
        if (filter === "all") return true;
        if (filter === "tool") return b.kind === "tool";
        if (filter === "text") return b.kind === "text" || b.kind === "user";
        if (filter === "thinking") return b.kind === "thinking";
        return b.kind === "marker" && (b.level === "warn" || b.level === "error");
      }),
  );

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
    void filter;
    if (pinned && container) container.scrollTop = container.scrollHeight;
  });

  function jump() {
    pinned = true;
    if (container) container.scrollTop = container.scrollHeight;
  }

  // Derived, not a plain const: chip counts must follow the live block list.
  const filters = $derived.by((): Array<{ id: typeof filter; label: string; n?: number }> => [
    { id: "all", label: "All", n: view.blocks.length },
    { id: "text", label: "Text" },
    { id: "tool", label: "Tools", n: counts.tool },
    { id: "thinking", label: "Thinking", n: counts.thinking },
    { id: "warn", label: "Flags", n: counts.warn },
  ]);
</script>

<div
  class="relative flex min-h-0 flex-1 flex-col"
  data-agent-id="transcript.root"
  data-state={view.pending.size > 0 ? "awaiting_approval" : view.working ? "working" : "idle"}
>
  {#if view.blocks.length > 0}
    <div class="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line bg-panel/60 px-3 py-1.5" data-agent-id="transcript.filters">
      {#each filters as f (f.id)}
        {#if f.id !== "thinking" || counts.thinking > 0}
          <button
            data-agent-id={`transcript.filter.${f.id}`}
            data-state={filter === f.id ? "active" : "idle"}
            onclick={() => (filter = f.id)}
            class={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
              filter === f.id ? "border-accent/50 bg-accent/15 text-ink" : "border-line text-dim hover:text-ink"
            }`}
          >
            {f.label}{#if f.n !== undefined && f.n > 0}&nbsp;<span class="opacity-60">{f.n}</span>{/if}
          </button>
        {/if}
      {/each}
      <span class="ml-auto shrink-0 pr-1 font-mono text-[10px] text-faint" data-agent-id="transcript.count">
        {view.blocks.length} block{view.blocks.length === 1 ? "" : "s"}
      </span>
    </div>
  {/if}

  <div bind:this={container} onscroll={onScroll} class="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
    {#if view.blocks.length === 0}
      <div class="mt-20 flex flex-col items-center gap-2 text-center" data-agent-id="transcript.empty">
        <span class="dext-gradient-text text-xl font-semibold tracking-tight">Fresh session</span>
        <p class="max-w-xs text-sm text-dim">Send a prompt below, or run a slash command with <code class="rounded bg-raised px-1 font-mono">/</code>.</p>
        <p class="text-xs text-faint">Journal events replay here on connect.</p>
      </div>
    {:else}
      {#each shown as block, i (i)}
        <BlockView {block} {onInspect} />
      {/each}
      {#if view.working}
        <p class="flex items-center gap-2 text-xs text-faint" data-agent-id="transcript.working">
          <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-accent"></span>
          working{view.compacting ? " · compacting context" : ""}{view.turnStartedAt ? ` · ${fmtElapsed(now - view.turnStartedAt)}` : ""}…
        </p>
      {/if}
    {/if}
  </div>

  {#if !pinned}
    <button
      data-agent-id="transcript.jump"
      onclick={jump}
      class="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-line bg-raised px-3 py-1 text-xs shadow-lg hover:border-accent/60"
    >
      ↓ jump to latest
    </button>
  {/if}
</div>
