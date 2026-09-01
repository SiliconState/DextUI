<script lang="ts">
  import type { SessionStore } from "@dextui/client";
  import { fmtTokens, fmtElapsed } from "../lib/markdown";

  let { store }: { store: SessionStore } = $props();

  let tick = $state(0);
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

  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => {
      clearInterval(t);
    };
  });

  // Prefer the provider-reported context window (tokens → ~4 chars/token); fall
  // back to a 200k-char heuristic when diagnostics haven't arrived yet.
  const ctxWindowChars = $derived(
    view.diagnostics?.context_window ? view.diagnostics.context_window * 4 : 200_000,
  );
  const ctxPct = $derived(Math.min(100, Math.round(((view.contextChars ?? 0) / ctxWindowChars) * 100)));
</script>

<div
  class="flex items-center gap-2 overflow-x-auto border-t border-line bg-panel px-4 py-1.5 text-xs text-dim"
  data-agent-id="status.hud"
  data-state={view.working ? "working" : "idle"}
>
  {#if view.model}
    <span class="chip" data-agent-id="status.model">{view.model}</span>
  {/if}
  {#if view.approvalProfile}
    <span class="chip" data-agent-id="status.profile">approvals: {view.approvalProfile}</span>
  {/if}
  {#if view.sessionUsage}
    <span class="chip" data-agent-id="status.usage" title={view.turnUsage ? `turn ↑${fmtTokens(view.turnUsage.input)} ↓${fmtTokens(view.turnUsage.output)}` : ""}>
      ↑{fmtTokens(view.sessionUsage.input)} ↓{fmtTokens(view.sessionUsage.output)}
      {#if view.sessionUsage.cost_usd > 0}
        · ${view.sessionUsage.cost_usd.toFixed(4)}
      {/if}
    </span>
  {/if}
  {#if view.contextChars}
    <span class="chip flex items-center gap-1.5" data-agent-id="status.ctx">
      {fmtTokens(view.contextChars)} ctx
      <span class="h-1 w-16 overflow-hidden rounded bg-line" data-agent-id="status.ctxbar">
        <span class="block h-full rounded bg-accent" style={`width:${ctxPct}%`}></span>
      </span>
    </span>
  {/if}
  {#if view.compacting}
    <span class="chip text-accent2">compacting…</span>
  {/if}
  {#if view.failed}
    <span class="chip text-err">turn failed</span>
  {/if}
  {#if view.working && view.turnStartedAt}
    <span class="ml-auto shrink-0 font-mono" data-agent-id="status.clock">{fmtElapsed(now - view.turnStartedAt)}</span>
  {:else}
    <span class="ml-auto hidden shrink-0 text-faint md:inline">a once · s always · d deny · ⌘K</span>
  {/if}
</div>

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    white-space: nowrap;
    border-radius: 9999px;
    border: 1px solid var(--color-line);
    background: var(--color-raised);
    padding: 2px 8px;
  }
</style>
