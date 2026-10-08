<script lang="ts">
  // One responsive header. Identity/state/context stay put; secondary actions
  // move to overflow rather than adding rows or keeping a second status bar.
  import type { SessionStore } from "@dextui/client";
  import { app, openSettings, openSessionCtl, queueTotal, jumpToOldestPending } from "../lib/state.svelte";
  import { connectorFor, connectors, pushConnector, syncConnector } from "../lib/connectors.svelte";
  import { crewLive, openRun } from "../lib/crew.svelte";
  import { selfEdit, cancelRestart } from "../lib/selfedit.svelte";
  import { folders, foldersEnabled, movableSession, openFolderPicker, shortFolder } from "../lib/folders.svelte";
  import { fmtTokens, prettyPath } from "../lib/markdown";
  import { useSession } from "../lib/useSession.svelte";
  import { popoverPos } from "../lib/popover";
  import { useDialog } from "../lib/dialog.svelte";
  import { headerContext, headerModel, headerStatus, type HeaderTarget } from "../lib/session-header";

  let { store = null, onToggleIndex, onNavigate, indexOpen = false }: { store?: SessionStore | null; onToggleIndex: () => void; onNavigate?: (target: HeaderTarget) => void; indexOpen?: boolean } = $props();
  const sess = useSession(() => store);
  const view = $derived(sess.view ?? store?.state ?? null);
  const sessionId = $derived(view?.id);
  const status = $derived(headerStatus(view, app.phase));
  const context = $derived(headerContext(view));
  const title = $derived(app.sessions.find((session) => session.id === view?.id)?.title || view?.title || "Dext");
  const fullAuto = $derived(view?.approvalProfile === "always");
  const compactModel = $derived(headerModel(view?.model, view?.thinkingEffort));
  const chipLabel = $derived([view?.model, view?.thinkingEffort].filter(Boolean).join(" · ") || "Session controls");
  const pendingTotal = $derived(queueTotal());
  const liveRuns = $derived(crewLive());
  const folderName = $derived(view?.cwd ? app.conn?.home && (view.cwd === app.conn.home || view.cwd.startsWith(app.conn.home + "/")) ? shortFolder(view.cwd) : prettyPath(view.cwd) : "Choose a session");
  const workspace = $derived(view?.cwd?.replace(/\/$/, "").split("/").pop() || folderName);
  const connector = $derived(connectorFor(view?.cwd ?? ""));
  const canMove = $derived.by(() => { void app.runtimeRevision; return !!view && !!movableSession(view.id); });
  const canSync = $derived(!!connector && connector.status !== "syncing" && !view?.working && !view?.compacting && !connectors.pending);
  const operational = $derived(selfEdit.build ? `UI build · ${selfEdit.build.step}` : selfEdit.restartPending ? "Restart when idle" : selfEdit.restarting ? "Host restarting" : view?.backgroundCompaction ? view.backgroundCompaction.blocking ? "Waiting for compaction" : "Summarizing context" : liveRuns.some((run) => run.status === "paused") ? "Crew needs review" : "");
  const contextTitle = $derived(context.pct === undefined ? "Context usage not reported. Show context details" : `${view?.contextSource === "history" ? "Context after compaction: " : ""}Context used: ${context.pct}%. ${fmtTokens(context.used!)} / ${fmtTokens(context.window)} tokens${context.assumed ? " (window assumed)" : ""}. Show context details`);
  const contextTone = $derived(context.pct !== undefined && context.pct >= 90 ? "var(--red)" : context.pct !== undefined && context.pct >= 70 ? "var(--yellow)" : "var(--dim)");
  const ctxDlg = useDialog(() => app.contextOpen, () => document.querySelector<HTMLElement>('[data-agent-id="status.ctx"]'));
  let contextAnchor = $state<{ top: number; bottom: number; right: number } | null>(null);
  const contextPos = $derived.by(() => { void layoutRevision; return popoverPos(contextAnchor, 260); });
  function showContext(event: MouseEvent) {
    if (!view) return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    contextAnchor = { top: rect.top, bottom: rect.bottom, right: innerWidth - rect.right };
    app.statusDetailsOpen = false; app.sessionCtlOpen = false; app.settingsOpen = false; app.todosOpen = false;
    app.contextOpen = true;
  }
  function contextKey(event: KeyboardEvent) {
    ctxDlg.onKey(event);
    if (event.key === "Escape") { app.contextOpen = false; event.preventDefault(); }
    event.stopPropagation();
  }

  let wide = $state(matchMedia("(min-width: 1100px)").matches);
  const dlg = useDialog(() => app.statusDetailsOpen, () => document.querySelector<HTMLElement>('[data-agent-id="status.details"]'));
  let layoutRevision = $state(0);
  $effect(() => {
    if (!app.statusDetailsOpen && !app.contextOpen) return;
    const resize = () => { layoutRevision += 1; };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  });
  let detailsAnchor = $state<{ top: number; bottom: number; right: number } | null>(null);
  const detailsPos = $derived.by(() => {
    void layoutRevision;
    return popoverPos(detailsAnchor, 304);
  });
  $effect(() => {
    const media = matchMedia("(min-width: 1100px)");
    const change = () => { wide = media.matches; app.statusDetailsOpen = false; app.contextOpen = false; };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  });
  $effect(() => { void sessionId; void app.hostEpoch; app.statusDetailsOpen = false; app.contextOpen = false; });
  function chooseWorkspace() {
    if (!foldersEnabled()) { onToggleIndex(); return; }
    app.contextOpen = false;
    app.statusDetailsOpen = false;
    app.sessionCtlOpen = false;
    app.settingsOpen = false;
    app.todosOpen = false;
    openFolderPicker(view ? { intent: "move", session: view.id, browseWhileWorking: true } : {});
  }
  function openControls(event: MouseEvent) {
    if (!view) return;
    const trigger = event.currentTarget as HTMLElement;
    const rect = trigger.getBoundingClientRect();
    const target = trigger.closest('[data-agent-id="status.context.overlay"]') ? "status.ctx" : trigger.closest('[data-agent-id="status.details.overlay"]') ? "status.details" : trigger.dataset.agentId;
    openSessionCtl({ top: rect.top, bottom: rect.bottom, right: innerWidth - rect.right }, target ? `[data-agent-id="${target}"]` : undefined);
  }
  function settings(event: MouseEvent) {
    const trigger = event.currentTarget as HTMLElement;
    const rect = trigger.getBoundingClientRect();
    const target = trigger.closest('[data-agent-id="status.details.overlay"]') ? "status.details" : trigger.dataset.agentId;
    openSettings({ top: rect.top, bottom: rect.bottom, right: innerWidth - rect.right }, target ? `[data-agent-id="${target}"]` : undefined);
  }
  function openDetails(event: MouseEvent) {
    app.contextOpen = false;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    detailsAnchor = { top: rect.top, bottom: rect.bottom, right: innerWidth - rect.right };
    app.todosOpen = false;
    app.settingsOpen = false;
    app.sessionCtlOpen = false;
    app.statusDetailsOpen = true;
  }
  function finder() { app.statusDetailsOpen = false; app.paletteOpen = true; }
  function detailsKey(event: KeyboardEvent) {
    dlg.onKey(event);
    if (event.key === "Escape") { app.statusDetailsOpen = false; event.preventDefault(); }
    event.stopPropagation();
  }
</script>

{#snippet deviceActions()}
  <button class="action" data-agent-id="finder.open" onclick={finder}>Find<span class="shortcut"> ⌘K</span></button>
  <button class="action" data-agent-id="settings.open" onclick={settings} aria-haspopup="dialog" aria-expanded={app.settingsOpen}>Settings</button>
{/snippet}

<header class="session-header" data-agent-id="status.hud" data-state={status.label.toLowerCase()} inert={app.statusDetailsOpen || app.contextOpen}>
  <button class="navigation" data-agent-id="index.toggle" aria-label={`Toggle sessions${pendingTotal ? `, ${pendingTotal} decisions waiting` : ""}`} aria-expanded={indexOpen} onclick={onToggleIndex}><svg class="glyph" aria-hidden="true" viewBox="0 0 16 16"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" /></svg>{#if pendingTotal}<span class="attention" data-agent-id="queue.badge">{pendingTotal}</span>{/if}</button>
  <button class="identity" data-agent-id="status.workspace" aria-label={`${foldersEnabled() ? `Choose workspace for ${title}. Current folder: ${folderName}` : "Choose a session"}${fullAuto ? ". Full auto: actions without asking" : ""}`} aria-haspopup={foldersEnabled() ? "dialog" : undefined} aria-expanded={foldersEnabled() ? folders.open : indexOpen} onclick={chooseWorkspace}>
    <span class="compact-workspace" aria-hidden="true">Work</span>
    <span class="session-name" title={title}>{title}</span>
    <span class="subtitle" title={status.busy ? status.step : folderName}>
      <span class="subtitle-copy">{status.busy ? status.step : workspace}</span>
      {#if fullAuto}<span class="full-auto" data-agent-id="status.full-auto" aria-label="Full auto: actions without asking" title="Full auto: actions without asking"><svg aria-hidden="true" width="12" height="14" viewBox="0 0 16 18"><path d="M8 1 14 3v5c0 4-3 6-6 8-3-2-6-4-6-8V3Z" fill="none" stroke="currentColor" stroke-width="1.7" /></svg><span class="auto-label">Full auto</span></span>{/if}
    </span>
  </button>
  {#if view}
    <button class="model-chip" data-agent-id="status.model-chip" aria-label={`Model, effort and permissions. ${chipLabel}`} aria-haspopup="dialog" aria-expanded={app.sessionCtlOpen} title={chipLabel} onclick={openControls}>
      <span class="desktop-model">{chipLabel} ▾</span>
      <span class="compact-model" aria-hidden="true">
        <span class="model-name">
          <svg class="model-icon" viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5" /><path d="M6 1.5V4m4-2.5V4M6 12v2.5M10 12v2.5M1.5 6H4m-2.5 4H4m8-4h2.5M12 10h2.5" /></svg>
          <span class="model-label">{compactModel.model}</span><span class="narrow-model-label">{compactModel.shortModel}</span>
        </span>
        <span class="model-effort"><i style={`background:${compactModel.effortTone}`}></i><span class="effort-label">{compactModel.effort}</span><span class="narrow-effort-label">{compactModel.shortEffort}</span></span>
      </span>
    </button>
  {/if}
  {#if wide}{@render deviceActions()}{/if}
  <span class="header-space" aria-hidden="true"></span>
  <button class={`state-pill tone-${status.tone}`} data-agent-id="status.session-state" aria-label={`${status.label}. ${status.target === "approval" ? "Go to approval" : status.target === "error" ? "Go to error" : status.target === "progress" ? "Show progress" : "Show latest result"}`} onclick={() => onNavigate?.(status.target)}>
    <span class="pill-label" aria-live="polite">
      <i class:active={status.label === "Active"} aria-hidden="true"></i><span class="state-label" class:input-state={status.label === "Needs input"}>{status.label}</span>{#if status.label === "Needs input"}<span class="narrow-state-label" aria-hidden="true">Input</span>{/if}
    </span>
  </button>
  <button class="context-ring" data-agent-id="status.ctx" data-source={view?.contextSource ?? "request"} disabled={!view} aria-label={contextTitle} title={contextTitle} aria-haspopup="dialog" aria-expanded={app.contextOpen} onclick={showContext} style={`--context-color:${contextTone}`}>
    <span class="context-meter" aria-hidden="true">
      <svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="16" class="ring-track" /><circle cx="20" cy="20" r="16" class="ring-value" pathLength="100" stroke-dasharray={`${context.pct ?? 0} 100`} /></svg><span class="context-percent">{context.pct === undefined ? "—" : `${context.pct}%`}</span>
    </span>
  </button>
  <!-- Keep the meter outside the button: button descendants are presentational
       in accessibility APIs, which would otherwise erase the meter semantics. -->
  {#if context.pct !== undefined}<span class="sr-only context-accessible" role="meter" aria-label={`Context used: ${context.pct}%`} aria-valuenow={context.pct} aria-valuemin="0" aria-valuemax="100" aria-valuetext={`${context.pct}% used`}>{context.pct}% used</span>{/if}
  <button class="overflow" data-agent-id="status.details" aria-label={operational ? `More session actions. ${operational}` : "More session actions"} aria-haspopup="dialog" aria-expanded={app.statusDetailsOpen} onclick={openDetails}><svg class="glyph" aria-hidden="true" viewBox="0 0 16 16"><circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" /></svg>{#if operational}<span class="operation-dot" data-agent-id="status.operation" data-background-phase={view?.backgroundCompaction?.phase} title={operational}></span>{/if}</button>
  {#if status.busy}<progress class="header-progress" data-agent-id="status.progress" aria-label="Agent progress" value={status.progress?.current} max={status.progress?.total ?? 1}></progress>{/if}
</header>

{#if app.contextOpen}
  <div class="details-scrim" role="presentation" onclick={() => (app.contextOpen = false)}></div>
  <div class="context-menu compact-popover" style={contextPos} role="dialog" aria-modal="true" aria-label="Context usage" tabindex="-1" use:ctxDlg.ref onkeydown={contextKey} data-agent-id="status.context.overlay" onfocusin={(event) => { if (event.target instanceof HTMLElement) event.target.scrollIntoView({ block: "nearest" }); }}>
    <div class="menu-head"><h2>Context</h2><button class="action" data-dialog-initial data-agent-id="status.context.close" onclick={() => (app.contextOpen = false)}>Close</button></div>
    <p class="context-usage">{context.pct === undefined ? "Context usage not reported" : `Context: ${context.pct}% used`}</p>
    {#if context.used !== undefined}<p>{fmtTokens(context.used)} / {fmtTokens(context.window)} tokens{context.assumed ? " · limit assumed" : ""}</p>{/if}
    {#if context.pct !== undefined && context.pct >= 70}<p class="context-advice">Start a new chat for best results.</p>{/if}
    <button class="action context-controls" data-agent-id="status.context.controls" onclick={openControls}>Context controls and usage</button>
  </div>
{/if}

{#if app.statusDetailsOpen}
  <div class="details-scrim" role="presentation" onclick={() => (app.statusDetailsOpen = false)}></div>
  <div class="status-menu compact-popover" style={detailsPos} role="dialog" aria-modal="true" aria-label="Session details" tabindex="-1" use:dlg.ref onkeydown={detailsKey} data-agent-id="status.details.overlay" onfocusin={(event) => { if (event.target instanceof HTMLElement) event.target.scrollIntoView({ block: "nearest" }); }}>
    <div class="menu-head"><h2>Session details</h2><button class="action" data-dialog-initial data-agent-id="status.details.close" onclick={() => (app.statusDetailsOpen = false)}>Close</button></div>
    {#if status.busy}<p class="current-step" data-agent-id="status.step">{status.step}</p>{/if}
    {#if operational}<p class="operational" data-agent-id="status.operational">{operational}</p>{/if}
    {#if view?.retry}<p data-agent-id="status.retry">Retry #{view.retry.attempt} in {view.retry.wait_secs}s · {view.retry.reason}</p>{/if}
    {#if view?.backgroundCompaction}<p data-agent-id="status.background-compaction" data-phase={view.backgroundCompaction.phase}>{view.backgroundCompaction.blocking ? "Waiting for compaction" : "Summarizing context"} · {view.backgroundCompaction.reason}</p>{/if}
    <dl><div><dt>Workspace</dt><dd title={folderName}>{folderName}</dd></div><div><dt>Context</dt><dd>{context.used === undefined ? "Not reported" : `${fmtTokens(context.used)} / ${fmtTokens(context.window)} tokens${context.assumed ? " (window assumed)" : ""}`}</dd></div>{#if view}<div><dt>Model</dt><dd title={chipLabel}>{chipLabel}</dd></div>{/if}</dl>
    <div class="menu-actions">
      {#if pendingTotal}<button class="action" onclick={() => { app.statusDetailsOpen = false; jumpToOldestPending(); }}>{pendingTotal} decisions waiting</button>{/if}
      {#if view}<button class="action" onclick={openControls}>Model, permissions and usage</button>{/if}
      {#if !wide}{@render deviceActions()}{/if}
      {#if view && app.caps.includes("todos_read")}<button class="action" data-agent-id="status.todos" onclick={() => { app.statusDetailsOpen = false; app.todosReveal += 1; }}>Show todos</button>{/if}
      {#if foldersEnabled() && view}<button class="action" onclick={chooseWorkspace}>{canMove ? "Change workspace" : "Browse workspace"}</button>{/if}
      {#if connector}<button class="action" disabled={!canSync} onclick={() => syncConnector(connector.id)}>Pull workspace</button><button class="action" disabled={!canSync} onclick={() => pushConnector(connector.id)}>Push workspace</button>{/if}
      {#each liveRuns as run (run.id)}<button class="action" onclick={() => { app.statusDetailsOpen = false; openRun(run.id); }}>Crew · {run.task}</button>{/each}
      {#if selfEdit.restartPending}<button class="action" onclick={cancelRestart}>Cancel scheduled restart</button>{/if}
    </div>
  </div>
{/if}

<style>
  .session-header { background: var(--bg1); backdrop-filter: none; display: flex; gap: 8px; align-items: center; min-width: 0; height: 32px; padding: 2px 8px; position: relative; font: 12px/1.4 var(--mono); }
  .navigation, .overflow, .context-ring { flex: none; width: 28px; height: 28px; min-height: 0; text-align: center; position: relative; }
  .navigation, .overflow { display: inline-flex; align-items: center; justify-content: center; color: var(--dim); }
  .glyph { width: 16px; height: 16px; fill: currentColor; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; }
  .navigation .glyph { fill: none; }
  .overflow .glyph { stroke: none; }
  .identity { flex: 1; min-width: 0; height: 28px; min-height: 0; display: flex; align-items: center; gap: 10px; }
  .session-name { display: block; flex: 0 1 auto; min-width: 0; max-width: 65%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: inherit; font-weight: 500; }
  .subtitle { display: flex; flex: 0 1 auto; align-items: center; gap: 6px; min-width: 0; max-width: 100%; color: var(--dim); font-size: 11px; }
  .subtitle-copy { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .full-auto { flex: none; display: inline-flex; align-items: center; gap: 4px; color: var(--yellow); font-weight: 500; white-space: nowrap; }
  .state-pill { flex: none; min-height: 0; height: 28px; padding: 0 4px; display: flex; align-items: center; }
  .state-pill > span { border: 1px solid color-mix(in srgb, var(--state-color) 35%, var(--line)); background: color-mix(in srgb, var(--state-color) 9%, var(--bg1)); color: var(--state-color); padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 500; }
  .tone-blue { --state-color: var(--blue); } .tone-amber { --state-color: var(--yellow); } .tone-green { --state-color: var(--green); } .tone-red { --state-color: var(--red); } .tone-neutral { --state-color: var(--dim); }
  .compact-workspace, .compact-model, .narrow-model-label, .narrow-effort-label, .narrow-state-label { display: none; }
  .state-pill .pill-label { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
  .pill-label i { flex: none; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
  .pill-label i.active { animation: pulse 2s ease-in-out infinite; }
  @media (prefers-reduced-motion: reduce) { .pill-label i.active { animation: none; } }
  .context-menu { position: fixed; z-index: 37; width: min(260px, calc(100vw - 24px)); padding: 0 12px 8px; border: 1px solid var(--line); border-radius: 3px; background: var(--bg3); color: var(--dim); font: 13px/1.5 var(--sans); box-shadow: 0 8px 32px #0005; }
  .context-menu .menu-head { top: 0; min-height: 44px; }
  .context-menu .action { min-height: 44px; color: var(--cyan); }
  .context-usage { padding-top: 8px; color: var(--fg); }
  .context-advice { padding-block: 8px; color: var(--yellow); }
  .context-controls { width: 100%; margin-top: 8px; border-top: 1px solid var(--line); }
  .context-meter { display: block; }
  .context-accessible { flex: none; }
  .context-ring { margin-left: 6px; color: var(--context-color); }
  .context-ring svg { position: absolute; inset: 1px; width: 26px; height: 26px; }
  .context-ring circle { fill: none; stroke-width: 2; }
  .ring-track { stroke: var(--line); }
  .ring-value { stroke: currentColor; transform-origin: center; transform: rotate(-90deg); }
  .context-ring .context-percent { position: relative; font-size: 8px; font-variant-numeric: tabular-nums; }
  .context-ring:disabled { color: var(--dim); cursor: default; }
  .header-space { display: none; }
  .model-chip, .action { flex-shrink: 0; }
  .attention { position: absolute; top: 0; right: 0; min-width: 14px; height: 14px; color: var(--yellow); background: var(--bg2); border-radius: 7px; font-size: 9px; line-height: 14px; }
  .operation-dot { position: absolute; top: 4px; right: 2px; width: 4px; height: 4px; background: var(--yellow); border-radius: 50%; }
  .model-chip { padding-inline: 6px; height: 28px; min-height: 0; max-width: 24ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; color: var(--dim); font: inherit; }
  .action { min-height: 28px; padding: 4px 6px; color: var(--dim); font: inherit; }
  .header-progress { position: absolute; bottom: 0; inset-inline: 0; width: 100%; height: 2px; appearance: none; border: 0; background: var(--line); accent-color: var(--blue); }
  .header-progress::-webkit-progress-bar { background: var(--line); } .header-progress::-webkit-progress-value { background: var(--blue); } .header-progress::-moz-progress-bar { background: var(--blue); }
  .details-scrim { position: fixed; inset: 0; z-index: 36; background: color-mix(in srgb, var(--bg) 55%, transparent); }
  .status-menu { position: fixed; z-index: 37; width: min(19rem, calc(100vw - 24px)); overflow: auto; padding: 8px; border: 1px solid var(--line); border-radius: 3px; background: var(--bg3); box-shadow: 0 8px 32px #0005; font: 12px/1.5 var(--mono); }
  .menu-head { position: sticky; top: -8px; background: var(--bg3); z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 8px; border-bottom: 1px solid var(--line); }
  h2 { font-size: 12px; font-weight: 500; }
  dl { margin-block: 6px; }
  dl > div { display: grid; grid-template-columns: 5rem minmax(0, 1fr); gap: 8px; padding-block: 4px; }
  dt { color: var(--dim); } dd { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .operational { overflow-wrap: anywhere; min-width: 0; }
  .operational { color: var(--yellow); }
  .current-step { color: var(--dim); overflow-wrap: anywhere; }
  .menu-actions { display: grid; gap: 2px; border-top: 1px solid var(--line); padding-top: 4px; }
  .menu-actions .action { text-align: left; white-space: normal; overflow-wrap: anywhere; }
  @media (max-width: 1099px) { .shortcut { display: none; } }
  @media (max-width: 900px), (pointer: coarse), (hover: none) {
    /* Touch: 44px bar of 44px targets; no extra chrome above the transcript. */
    .session-header { height: 44px; padding-block: 0; }
    .session-header > button { height: 44px; min-height: 44px; }
    .navigation, .overflow, .context-ring { width: 44px; }
    .identity { gap: 6px; }
    .context-ring svg { inset: 3px; width: 38px; height: 38px; }
    .context-ring .context-percent { font-size: 10px; font-weight: 500; }
    .state-pill { padding-inline: 2px; }
    .attention { top: 5px; right: 4px; }
    .operation-dot { top: 10px; right: 10px; }
    .shortcut { display: none; }
  }
  @media (max-width: 900px) {
    .session-header { gap: 0; padding-inline: 0 2px; font: 12px/1.35 var(--sans); }
    .identity { flex: 0 1 112px; max-width: 112px; min-width: 44px; gap: 6px; padding-inline: 2px 6px; }
    .session-name { flex: 0 1 auto; max-width: none; font: inherit; }
    .desktop-model { display: none; }
    .compact-model { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .compact-model > span { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
    .model-name { min-width: 0; color: var(--fg); }
    .model-label, .narrow-model-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .model-icon { flex: none; width: 12px; height: 12px; fill: none; stroke: var(--dim); stroke-width: 1.3; stroke-linecap: round; }
    .compact-model i { width: 5px; height: 5px; border-radius: 50%; flex: none; }
    .model-chip { flex: 0 1 auto; padding-inline: 4px; min-width: 44px; max-width: 180px; font: inherit; }
    .model-effort { flex: none; color: var(--dim); }
    .header-space { display: block; flex: 1; min-width: 0; }
    .state-pill { min-width: 44px; justify-content: center; font: inherit; }
    .state-pill > span { font: inherit; }
    .subtitle { flex: none; }
    .subtitle-copy, .auto-label { display: none; }
    .full-auto svg { width: 13px; height: 15px; }
    .status-menu { font: 13px/1.4 var(--sans); padding: 0 12px 6px; }
    .menu-head { top: 0; min-height: 44px; }
    .menu-head h2 { font-size: 14px; font-weight: 600; }
    .menu-head .action { margin-right: -10px; color: var(--cyan); }
    .status-menu .action { min-height: 44px; padding: 6px 0; font-size: 14px; color: var(--fg); }
    .status-menu .action:disabled { color: var(--dim); }
    .menu-actions { gap: 0; }
    .menu-actions .action + .action { border-top: 1px solid color-mix(in srgb, var(--line) 70%, transparent); }
    dl > div { grid-template-columns: auto minmax(0, 1fr); gap: 12px; }
    dd { text-align: right; }
  }
  @media (max-width: 420px) {
    .identity { flex: none; width: 44px; max-width: 44px; min-width: 44px; gap: 2px; padding-inline: 0; }
    .identity .session-name { display: none; }
    .compact-workspace { display: block; font: inherit; }
    .full-auto svg { width: 10px; height: 12px; }
    .state-pill { padding: 0; }
    .state-pill .pill-label { padding-inline: 5px; gap: 4px; }
    .context-ring { margin-left: 5px; }
    .model-chip { padding-inline: 2px; }
    /* Keep the full label available to the live region and screen readers. */
    .state-label.input-state { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .narrow-state-label { display: inline; }
  }
  @media (max-width: 360px) {
    /* Keep one line and readable type. Full selections stay in the accessible
       name and menu; only display aliases shorten on the smallest phones. */
    .model-label, .effort-label { display: none; }
    .narrow-model-label, .narrow-effort-label, .narrow-state-label { display: inline; }
    .compact-model { gap: 5px; }
    .compact-model > span { gap: 3px; }
  }
</style>
