<script lang="ts">
  // Status line, verbatim dext TUI idiom:
  //   ● ~/cwd | session │ model │ approval:ask │ Ctx [██████░░░░] 42% │ ↑12k ↓3k $0.04
  import type { SessionStore } from "@dextui/client";
  import type { ThinkingEffort } from "@dextui/protocol";
  import { app, toggleTheme, rePair, toggleSidebar } from "../lib/state.svelte";
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

  const modelValue = $derived(view.provider && view.model ? `${view.provider}\u001f${view.model}` : "");
  const canSelectModel = $derived(
    app.phase === "live" &&
      app.caps.includes("model_select") &&
      view.status === "live" &&
      !view.working && !view.modelLocked && app.modelCatalog.length > 0,
  );
  const canSelectEffort = $derived(
    app.phase === "live" &&
      app.caps.includes("effort_select") &&
      view.status === "live" &&
      !view.working && app.effortOptions.length > 0,
  );

  function selectModel(e: Event) {
    const raw = (e.currentTarget as HTMLSelectElement).value;
    const split = raw.indexOf("\u001f");
    if (split < 1) return;
    const provider = raw.slice(0, split);
    const model = raw.slice(split + 1);
    app.conn?.configureSession(view.id, { provider, model });
  }

  function selectEffort(e: Event) {
    const thinking_effort = (e.currentTarget as HTMLSelectElement).value as ThinkingEffort;
    app.conn?.configureSession(view.id, { thinking_effort });
  }
</script>

<div class="sl" data-agent-id="status.hud" data-state={view.working ? "working" : "idle"}>
  {#if onToggleIndex}
    <button class="act idx-toggle" data-agent-id="index.toggle" onclick={onToggleIndex}>[≡]</button>
  {/if}
  {#if app.sidebarCollapsed}
    <button class="act rail-restore" data-agent-id="sidebar.restore" onclick={toggleSidebar} title="Show sessions (Ctrl/Cmd+B)">[› sessions]</button>
  {/if}
  <span class={`dot ${dotClass}`} data-agent-id="status.phase" data-state={app.phase}>●</span>
  <span class="st-green truncate">{view.cwd || "dextui"}</span>
  {#if view.title && view.title !== view.id}
    <span class="sep">|</span>
    <span class="dim truncate">{view.title}</span>
  {/if}
  {#if app.caps.includes("model_select") && app.modelCatalog.length > 0}
    <span class="sep">│</span>
    <label class="ctl" title={view.modelLocked ? "Model is fixed once this session has history. Start a new session to change it." : "Model for this session's first turn"}>
      <span class="faint">model:</span>
      <select
        value={modelValue}
        onchange={selectModel}
        disabled={!canSelectModel}
        data-agent-id="status.model.select"
        data-state={view.modelLocked ? "locked" : canSelectModel ? "ready" : "disabled"}
      >
        {#each app.modelCatalog as group (group.provider)}
          <optgroup label={group.label ? `${group.label} (${group.provider})` : group.provider}>
            {#each group.models as model (model)}
              <option value={`${group.provider}\u001f${model}`}>{model}</option>
            {/each}
          </optgroup>
        {/each}
      </select>
      {#if view.modelLocked}<span class="faint">⌁</span>{/if}
    </label>
  {:else if view.model}
    <span class="sep">│</span>
    <span class="st-cyan" data-agent-id="status.model">{view.model}</span>
  {/if}
  {#if app.caps.includes("effort_select") && app.effortOptions.length > 0}
    <span class="sep">│</span>
    <label class="ctl" title="Reasoning effort for the next turn">
      <span class="faint">effort:</span>
      <select
        value={view.thinkingEffort ?? "medium"}
        onchange={selectEffort}
        disabled={!canSelectEffort}
        data-agent-id="status.effort.select"
        data-state={canSelectEffort ? "ready" : "disabled"}
      >
        {#each app.effortOptions as effort (effort)}
          <option value={effort}>{effort}</option>
        {/each}
      </select>
    </label>
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
  .ctl {
    display: inline-flex;
    align-items: baseline;
    gap: 2px;
    flex-shrink: 0;
  }
  .ctl select {
    appearance: auto;
    border: 0;
    background: transparent;
    color: var(--cyan);
    font: inherit;
    padding: 0;
    max-width: 20ch;
    cursor: pointer;
  }
  .ctl select:disabled {
    color: var(--dim);
    cursor: default;
    opacity: 1;
  }
  .ctl option,
  .ctl optgroup {
    background: var(--bg1);
    color: var(--fg);
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
  .rail-restore {
    color: var(--cyan);
  }
  @media (max-width: 900px) {
    .idx-toggle {
      display: inline;
    }
    .rail-restore {
      display: none;
    }
    .truncate {
      max-width: 90px;
    }
  }
</style>
