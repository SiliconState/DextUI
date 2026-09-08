<script lang="ts">
  // Status line, verbatim dext TUI idiom:
  //   ● ~/cwd | session │ model │ approval:ask │ Ctx ▮▮▮▮▯▯ 42% │ ↑12k ↓3k $0.04
// The context meter is a themed segmented component (Meter.svelte), not font glyphs.
import Meter from "./Meter.svelte";
  import type { SessionStore } from "@dextui/client";
  import { app, openSettings, openSessionCtl, toggleSidebar, queueTotal, jumpToOldestPending } from "../lib/state.svelte";
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

  // One chip for the session's runtime controls — model · effort · approval —
  // which live in a popover (SessionControls), so the bar reads as status,
  // not a toolbar. The chip stays glanceable: current model, ⌁ when locked;
  // plain text only when nothing is configurable at all.
  const hasSessionCtl = $derived(
    (app.caps.includes("model_select") && app.modelCatalog.length > 0) ||
      (app.caps.includes("effort_select") && app.effortOptions.length > 0) ||
      !!view.approvalProfile,
  );
  const chipLabel = $derived(
    [view.model || "Session", view.thinkingEffort].filter(Boolean).join(" · "),
  );
  const chipTitle = $derived(
    `Session — model: ${view.model ?? "—"} · effort: ${view.thinkingEffort ?? "medium"} · approval: ${view.approvalProfile ?? "—"}`,
  );

  function openSessionCtlAt(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openSessionCtl({ top: r.top, bottom: r.bottom, right: window.innerWidth - r.right });
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
  {#if hasSessionCtl}
    <span class="sep">│</span>
    <button
      class="act ctl-chip"
      data-agent-id="status.controls"
      data-state={app.sessionCtlOpen ? "open" : "closed"}
      aria-haspopup="dialog"
      aria-expanded={app.sessionCtlOpen}
      onclick={openSessionCtlAt}
      title={chipTitle}
    >{chipLabel}{#if view.modelLocked}<span class="faint lock" title="Model fixed for this session">⌁</span>{/if} <span class="faint" aria-hidden="true">▾</span></button>
  {:else if view.model}
    <span class="sep">│</span>
    <span class="st-cyan" data-agent-id="status.model">{view.model}</span>
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
      aria-haspopup="dialog"
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
  .ctl-chip {
    color: var(--cyan);
    max-width: 26ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 1;
  }
  .ctl-chip .lock {
    margin-left: 3px;
  }
  .ctl-chip[data-state="open"] {
    color: var(--fg);
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
    .ctl-chip {
      max-width: 16ch;
    }
  }
  .crew-tick { white-space: nowrap; }
  .crew-tick .tick-min { display: none; }
  @media (max-width: 900px) {
    .crew-tick .tick-full { display: none; }
    .crew-tick .tick-min { display: inline; }
  }
</style>
