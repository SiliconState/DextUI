<script lang="ts">
  // Status line, verbatim dext TUI idiom:
  //   ● ~/cwd | session │ model │ approval:ask │ Ctx [██████░░░░] 42% │ ↑12k ↓3k $0.04
  import type { SessionStore } from "@dextui/client";
  import { app, toggleTheme, rePair } from "../lib/state.svelte";
  import { fmtTokens, fmtElapsed } from "../lib/markdown";

  let { store, onToggleIndex }: { store: SessionStore; onToggleIndex?: () => void } = $props();

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

  const ctxWindow = $derived(
    view.diagnostics?.context_window ? view.diagnostics.context_window * 4 : 200_000,
  );
  const ctxPct = $derived(
    view.contextChars ? Math.min(100, Math.round((view.contextChars / ctxWindow) * 100)) : 0,
  );
  const ctxBar = $derived("█".repeat(Math.round(ctxPct / 10)) + "░".repeat(10 - Math.round(ctxPct / 10)));
  const ctxClass = $derived(ctxPct >= 90 ? "st-red" : ctxPct >= 70 ? "st-yellow" : "st-cyan");

  const dotClass = $derived(
    app.phase === "live"
      ? view.working
        ? "st-yellow pulse"
        : "st-green"
      : app.phase === "failed"
        ? "st-red"
        : app.phase === "reconnecting" || app.phase === "connecting" || app.phase === "authing"
          ? "st-yellow pulse"
          : "st-faint",
  );
</script>

<div class="sl" data-agent-id="status.hud" data-state={view.working ? "working" : "idle"}>
  {#if onToggleIndex}
    <button class="act idx-toggle" data-agent-id="index.toggle" onclick={onToggleIndex}>[≡]</button>
  {/if}
  <span class={`dot ${dotClass}`} data-agent-id="status.phase" data-state={app.phase}>●</span>
  <span class="st-green truncate">{view.cwd || "dextui"}</span>
  {#if view.title && view.title !== view.id}
    <span class="sep">|</span>
    <span class="dim truncate">{view.title}</span>
  {/if}
  {#if view.model}
    <span class="sep">│</span>
    <span class="st-cyan" data-agent-id="status.model">{view.model}</span>
  {/if}
  {#if view.approvalProfile}
    <span class="sep">│</span>
    <span class="st-yellow" data-agent-id="status.profile">approval:{view.approvalProfile}</span>
  {/if}
  {#if view.contextChars}
    <span class="sep">│</span>
    <span data-agent-id="status.ctx">
      <span class="faint">Ctx</span>
      <span class={ctxClass} data-agent-id="status.ctxbar">[{ctxBar}]</span>
      <span class={ctxClass}>{ctxPct}%</span>
    </span>
  {/if}
  {#if view.sessionUsage}
    <span class="sep">│</span>
    <span class="dim" data-agent-id="status.usage">
      ↑{fmtTokens(view.sessionUsage.input)} ↓{fmtTokens(view.sessionUsage.output)}{#if view.sessionUsage.cost_usd > 0}
        {" "}${view.sessionUsage.cost_usd.toFixed(4)}{/if}
    </span>
  {/if}
  {#if view.compacting}
    <span class="sep">│</span>
    <span class="st-magenta">compacting…</span>
  {/if}
  {#if view.failed}
    <span class="sep">│</span>
    <span class="st-red">✗ turn failed</span>
  {/if}
  {#if view.working && view.turnStartedAt}
    <span class="sep">│</span>
    <span class="st-yellow" data-agent-id="status.clock">{fmtElapsed(now - view.turnStartedAt)}</span>
  {/if}
  <span class="sl-right">
    <button class="act" data-agent-id="finder.open" onclick={() => (app.paletteOpen = true)} title="finder (⌘K)">⌘k</button>
    <button class="act" data-agent-id="theme.toggle" onclick={toggleTheme} title="cycle theme: dark → light → system">
      theme:{app.theme}
    </button>
    <button class="act" data-agent-id="pair.reset" onclick={rePair} title="clear token and re-pair">re-pair</button>
  </span>
</div>

<style>
  .sl {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 3px 10px;
    overflow-x: auto;
    white-space: nowrap;
    font-size: 12px;
  }
  .dot {
    flex-shrink: 0;
  }
  .sep {
    color: var(--faint);
    flex-shrink: 0;
  }
  .truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    max-width: 220px;
  }
  .faint {
    color: var(--faint);
  }
  .dim {
    color: var(--dim);
  }
  .st-green {
    color: var(--green);
  }
  .st-cyan {
    color: var(--cyan);
  }
  .st-yellow {
    color: var(--yellow);
  }
  .st-red {
    color: var(--red);
  }
  .st-magenta {
    color: var(--magenta);
  }
  .st-faint {
    color: var(--faint);
  }
  .sl-right {
    margin-left: auto;
    display: flex;
    gap: 10px;
    flex-shrink: 0;
    color: var(--faint);
  }
  .idx-toggle {
    display: none;
  }
  @media (max-width: 820px) {
    .idx-toggle {
      display: inline;
    }
    .truncate {
      max-width: 90px;
    }
  }
</style>
