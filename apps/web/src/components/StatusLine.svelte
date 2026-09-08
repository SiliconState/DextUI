<script lang="ts">
  // Status line, verbatim dext TUI idiom:
  //   ● ~/cwd | session │ model │ approval:ask │ Ctx ▮▮▮▮▯▯ 42% │ ↑12k ↓3k $0.04
// The context meter is a themed segmented component (Meter.svelte), not font glyphs.
import Meter from "./Meter.svelte";
  import type { SessionStore } from "@dextui/client";
  import type { ThinkingEffort } from "@dextui/protocol";
  import { app, openSettings, toggleSidebar, queueTotal, jumpToOldestPending } from "../lib/state.svelte";
  import { connectorFor, connectors, pushConnector, syncConnector } from "../lib/connectors.svelte";
  import { crew, crewLive, crewDur, crewAge, openRun, shortRun } from "../lib/crew.svelte";
  import { selfEdit, cancelRestart } from "../lib/selfedit.svelte";
  import { foldersEnabled, movableSession, openFolderPicker, shortFolder } from "../lib/folders.svelte";
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

  // Ctx: what the model saw on its last request (input + cache tokens from
  // usage_update — every provider reports it) over the model's window
  // (turn_diagnostics.context_window, else 200k). Same inputs as the TUI's
  // meter; the old chars-only source lit up for local models alone.
  const ctxWindow = $derived(view.diagnostics?.context_window || 200_000);
  const ctxUsed = $derived(view.contextTokens ?? (view.contextChars ? Math.ceil(view.contextChars / 4) : 0));
  const ctxPct = $derived(ctxUsed ? Math.min(100, Math.round((ctxUsed / ctxWindow) * 100)) : 0);
  const ctxClass = $derived(ctxPct >= 90 ? "st-red" : ctxPct >= 70 ? "st-yellow" : "st-cyan");
  const ctxTitle = $derived(`Context: ${fmtTokens(ctxUsed)} of ${fmtTokens(ctxWindow)} tokens on the last request${view.diagnostics?.context_window ? "" : " (window assumed)"}`);

  // Folder chip: click to move this session elsewhere (picker in "move"
  // intent, opening inside the current folder). Disabled mid-turn — the host
  // refuses then, and the agent's tool calls are resolving paths against it.
  const isReal = $derived(app.sessions.some((s) => s.id === view.id));
  const canMove = $derived(isReal && !!movableSession(view.id));
  // "Workspace · <folder>": the folder name is picker-relative when inside the
  // host root ("Clients/Acme Ltd", "Home"), else the user-anonymised path.
  // Sessions in different folders must not all read the same.
  const folderName = $derived.by(() => {
    if (!view.cwd) return "DextUI";
    const home = app.conn?.home ?? "";
    if (home && (view.cwd === home || view.cwd.startsWith(home + "/"))) return shortFolder(view.cwd);
    const p = prettyPath(view.cwd);
    return p === "workspace" ? "Workspace" : p;
  });
  const folderTitle = $derived(!foldersEnabled() ? view.cwd : view.working ? `${view.cwd}\nChange folder — available when the turn finishes` : `${view.cwd}\nChange folder (o)`);
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
  // With the bridge (steering.live), /effort is a runtime control dext applies
  // mid-turn, so the selector stays enabled while working.
  const liveEffort = $derived(app.caps.includes("steering.live"));
  const canSelectEffort = $derived(
    app.phase === "live" &&
      app.caps.includes("effort_select") &&
      view.status === "live" &&
      (liveEffort || !view.working) && app.effortOptions.length > 0,
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

  // Approval: what dext may do without asking. Redefined from a static yellow
  // badge into a live control consistent with model/effort — the graded
  // spectrum plus whatever the session actually holds (e.g. always/never). The
  // host defers /approval during a live turn, so it applies from the next turn.
  const APPROVAL_LABELS: Record<string, string> = {
    ask: "Ask each time",
    "auto-read": "Auto reads",
    "auto-write": "Auto edits",
    always: "Approve all",
    never: "Deny all",
  };
  const canSetApproval = $derived(
    app.phase === "live" && app.caps.includes("slash.approval") && view.status === "live",
  );
  const approvalOptions = $derived.by(() => {
    const base = ["ask", "auto-read", "auto-write"];
    const cur = view.approvalProfile;
    const list = cur && !base.includes(cur) ? [cur, ...base] : base;
    return list.map((v) => ({ value: v, label: APPROVAL_LABELS[v] ?? v }));
  });
  function selectApproval(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    if (v && v !== view.approvalProfile) app.conn?.slash(view.id, `/approval ${v}`);
  }

  function openSettingsAt(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openSettings({ top: r.top, bottom: r.bottom, right: window.innerWidth - r.right });
  }

  // Sessions inside a connected folder get a sync affordance: pull is
  // fast-forward/copy (never destroys local work); push commits everything
  // (git) or copies up (rclone). Disabled while a turn runs so the agent's
  // files never move underneath it.
  const connector = $derived(connectorFor(view.cwd));
  const canSync = $derived(!!connector && connector.status !== "syncing" && !view.working && !connectors.pending);
  function connAge(ms: number | undefined): string {
    if (!ms) return "never";
    const m = Math.floor((Date.now() - ms) / 60_000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
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
  {#if foldersEnabled() && isReal}
    <button class="act folder st-green truncate" data-agent-id="status.folder" data-state={canMove ? "ready" : "locked"} disabled={!canMove} title={folderTitle} aria-label="Change this session's folder" onclick={() => openFolderPicker({ intent: "move", session: view.id })}><span class="faint">Workspace</span> {folderName}</button>
  {:else}
    <span class="st-green truncate" title={view.cwd}><span class="faint">Workspace</span> {folderName}</span>
  {/if}
  {#if connector}
    <span class="conn" data-agent-id="status.connector" data-state={connector.status} title={`${connector.remote}\nLast sync: ${connAge(connector.last_sync)}${connector.error ? `\n${connector.error}` : ""}`}>
      <span class="faint">{connector.status === "syncing" ? "syncing…" : connector.status === "error" ? "sync failed" : `synced ${connAge(connector.last_sync)}`}</span>
      <button class="act" disabled={!canSync} data-agent-id="status.connector.pull" onclick={() => syncConnector(connector.id)} title="Pull the latest from the source">Pull</button>
      <button class="act" disabled={!canSync} data-agent-id="status.connector.push" onclick={() => pushConnector(connector.id)} title={connector.kind === "github" || connector.kind === "git" ? "Commit everything and push" : "Copy this folder up to the source"}>Push</button>
    </span>
  {/if}
  {#if view.title && view.title !== view.id}
    <span class="sep">|</span>
    <span class="dim truncate">{view.title}</span>
  {/if}
  {#if app.caps.includes("model_select") && app.modelCatalog.length > 0}
    <span class="sep">│</span>
    <label class="ctl" title={view.modelLocked ? "Model is fixed once this session has history. Start a new session to change it." : app.caps.includes("model_switch") ? "Model for the next turn; history is kept" : "Model for this session's first turn"}>
      <span class="faint">Model:</span>
      <select
        value={modelValue}
        onchange={selectModel}
        onfocus={() => app.conn?.authStatus()}
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
      <span class="faint">Effort:</span>
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
    {#if canSetApproval}
      <label class="ctl appr" title="What dext may do without asking — applies from the next turn">
        <span class="faint">Approval:</span>
        <select
          value={view.approvalProfile}
          onchange={selectApproval}
          data-agent-id="status.approval.select"
          data-state="ready"
        >
          {#each approvalOptions as opt (opt.value)}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </label>
    {:else}
      <span class="st-yellow" data-agent-id="status.profile" title="Approval profile — {view.approvalProfile}">Approval:{APPROVAL_LABELS[view.approvalProfile] ?? view.approvalProfile}</span>
    {/if}
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
      <span class="tick-full">Crew {shortRun(ticker.top.id)}{ticker.more ? `+${ticker.more}` : ""}
        {#if ticker.c.paused}⚠{ticker.c.paused}{/if}{#if ticker.c.run} ●{ticker.c.run}{/if}{#if ticker.c.done} ✓{ticker.c.done}{/if}{#if ticker.c.fail} ✗{ticker.c.fail}{/if}
        · {crewDur(crewAge(ticker.top, now))}</span>
      <span class="tick-min">Crew {ticker.c.paused ? `⚠${ticker.c.paused}` : `●${ticker.c.run}`}</span>
    </button>
  {/if}
  {#if selfEdit.build}
    <span class="sep">│</span>
    <span class="st-cyan" data-agent-id="status.ui.build" data-state="building" title={`UI build ${selfEdit.build.id}`}>⟳ UI:{selfEdit.build.step}</span>
  {:else if selfEdit.restartPending}
    <span class="sep">│</span>
    <button class="act st-yellow" data-agent-id="status.host.restart" data-state="pending" title={`Restart queued${selfEdit.restartPending.reason ? `: ${selfEdit.restartPending.reason}` : ""} — click to cancel`} onclick={cancelRestart}>↻ Restart when idle</button>
  {:else if selfEdit.restarting}
    <span class="sep">│</span>
    <span class="st-yellow" data-agent-id="status.host.restart" data-state="restarting">↻ Host restarting</span>
  {/if}
  {#if ctxUsed > 0}
    <span class="sep">│</span>
    <span data-agent-id="status.ctx" title={ctxTitle}>
      <span class="faint">Ctx</span>
      <span class={ctxClass} data-agent-id="status.ctxbar"><Meter pct={ctxPct} /></span>
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
    <span class="st-magenta">Compacting…</span>
  {/if}
  {#if view.retry}
    <span class="sep">│</span>
    <span class="st-yellow pulse" data-agent-id="status.retry" title={view.retry.reason}>Retry #{view.retry.attempt} in {view.retry.wait_secs}s</span>
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
    <button class="act" data-agent-id="finder.open" onclick={() => (app.paletteOpen = true)} title="Finder (⌘K)">⌘k</button>
    <button
      class="act settings-open"
      data-agent-id="settings.open"
      data-state={app.settingsOpen ? "open" : "closed"}
      aria-haspopup="menu"
      aria-expanded={app.settingsOpen}
      onclick={openSettingsAt}
      title="Settings — theme, notifications, sign out"
    >⚙</button>
  </span>
</div>

<style>
  .conn {
    display: inline-flex;
    gap: 4px;
    align-items: baseline;
    font-size: 0.9em;
  }
  .conn[data-state="error"] > .faint {
    color: var(--red);
  }
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
  /* Approval keeps its caution hue as a live control (was a static badge). */
  .ctl.appr select {
    color: var(--yellow);
  }
  .settings-open {
    font-size: 1.1em;
    line-height: 1;
  }
  .settings-open[data-state="open"] {
    color: var(--cyan);
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
