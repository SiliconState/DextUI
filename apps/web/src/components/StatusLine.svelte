<script lang="ts">
  // Status line, verbatim dext TUI idiom:
  //   ● ~/cwd | session │ model │ approval:ask │ Ctx [██████░░░░] 42% │ ↑12k ↓3k $0.04
  import type { SessionStore } from "@dextui/client";
  import type { ThinkingEffort } from "@dextui/protocol";
  import { app, toggleTheme, rePair, toggleSidebar, queueTotal, jumpToOldestPending, toggleNotify } from "../lib/state.svelte";
  import { crew, crewLive, crewDur, crewAge, openRun, shortRun } from "../lib/crew.svelte";
  import { selfEdit, cancelRestart } from "../lib/selfedit.svelte";
  import { fmtTokens, fmtElapsed, prettyPath } from "../lib/markdown";
  import { useSession } from "../lib/useSession.svelte";

  let { store, onToggleIndex }: { store: SessionStore; onToggleIndex?: () => void } = $props();

  const sess = useSession(() => store);
  const view = $derived(sess.view ?? store.state);
  const pendingTotal = $derived(queueTotal());

  let now = $state(Date.now());
  // Tier 0 — crew ticker: ids + counts + wall clock, never prose; only while ≥1 run is live.
  const liveRuns = $derived(crewLive());
  const ticker = $derived.by(() => {
    if (liveRuns.length === 0) return null;
    // Host order is attention order, so the first live run is the one to open.
    const top = liveRuns[0]!;
    const c = liveRuns.reduce((n, r) => ({ run: n.run + r.counts.run, done: n.done + r.counts.done, fail: n.fail + r.counts.fail, paused: n.paused + (r.escalation ? 1 : 0) }), { run: 0, done: 0, fail: 0, paused: 0 });
    return { top, c, more: liveRuns.length - 1 };
  });
  $effect(() => {
    if (view.working || liveRuns.length > 0) {
      const t = setInterval(() => {
        now = Date.now();
      }, 1000);
      return () => {
        clearInterval(t);
      };
    }
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
  <span class="st-green truncate">{view.cwd ? prettyPath(view.cwd, view.cwd) : "dextui"}</span>
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
  {#if ticker}
    <span class="sep">│</span>
    <button
      class={`act crew-tick ${ticker.top.status === "paused" ? "st-yellow" : "st-cyan"}`}
      data-agent-id="status.crew"
      data-state={ticker.top.state}
      title={`${ticker.top.task}${ticker.more ? ` (+${ticker.more} more live)` : ""}`}
      onclick={() => openRun(crew.openId || ticker.top.id)}
    >
      <span class="tick-full">crew {shortRun(ticker.top.id)}{ticker.more ? `+${ticker.more}` : ""}
        {#if ticker.c.paused}⚠{ticker.c.paused}{/if}{#if ticker.c.run} ●{ticker.c.run}{/if}{#if ticker.c.done} ✓{ticker.c.done}{/if}{#if ticker.c.fail} ✗{ticker.c.fail}{/if}
        · {crewDur(crewAge(ticker.top, now))}</span>
      <span class="tick-min">crew {ticker.c.paused ? `⚠${ticker.c.paused}` : `●${ticker.c.run}`}</span>
    </button>
  {/if}
  {#if selfEdit.build}
    <span class="sep">│</span>
    <span class="st-cyan" data-agent-id="status.ui.build" data-state="building" title={`UI build ${selfEdit.build.id}`}>⟳ ui:{selfEdit.build.step}</span>
  {:else if selfEdit.restartPending}
    <span class="sep">│</span>
    <button class="act st-yellow" data-agent-id="status.host.restart" data-state="pending" title={`restart queued${selfEdit.restartPending.reason ? `: ${selfEdit.restartPending.reason}` : ""} — click to cancel`} onclick={cancelRestart}>↻ restart when idle</button>
  {:else if selfEdit.restarting}
    <span class="sep">│</span>
    <span class="st-yellow" data-agent-id="status.host.restart" data-state="restarting">↻ host restarting</span>
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
  {#if view.retry}
    <span class="sep">│</span>
    <span class="st-yellow pulse" data-agent-id="status.retry" title={view.retry.reason}>retry #{view.retry.attempt} in {view.retry.wait_secs}s</span>
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
    {#if pendingTotal > 0}
      <button
        class="act warn queue-badge"
        data-agent-id="queue.badge"
        data-state="active"
        aria-label={`jump to oldest pending approval (${pendingTotal} total)`}
        onclick={jumpToOldestPending}
      >⚠ {pendingTotal}</button
      >
    {/if}
    <button class="act" data-agent-id="finder.open" onclick={() => (app.paletteOpen = true)} title="finder (⌘K)">⌘k</button>
    <button
      class="act"
      data-agent-id="notify.toggle"
      data-state={app.notify}
      onclick={toggleNotify}
      title="notify while the tab is hidden"
    >notify:{app.notify}</button
    >
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
  .crew-tick { white-space: nowrap; }
  .crew-tick .tick-min { display: none; }
  @media (max-width: 900px) {
    .crew-tick .tick-full { display: none; }
    .crew-tick .tick-min { display: inline; }
  }
</style>
