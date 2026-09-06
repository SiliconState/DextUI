<script lang="ts">
  import {
    app,
    start,
    connection,
    activate,
    newSession,
    toggleSidebar,
    queue,
    queueTotal,
    respondGlobal,
    stepSession,
    jumpToOldestPending,
    toggleNotify,
    requestSessionAction,
  } from "./lib/state.svelte";
  import { useSession } from "./lib/useSession.svelte";
  import { useDialog } from "./lib/dialog.svelte";
  import type { ViewBlock } from "@dextui/client";
  import SessionIndex from "./components/SessionIndex.svelte";
  import Scrollback from "./components/Scrollback.svelte";
  import Approval from "./components/Approval.svelte";
  import Composer from "./components/Composer.svelte";
  import StatusLine from "./components/StatusLine.svelte";
  import Finder from "./components/Finder.svelte";
  import Toasts from "./components/Toasts.svelte";
  import Todos from "./components/Todos.svelte";
  import Shortcuts from "./components/Shortcuts.svelte";
  import PackGallery from "./components/PackGallery.svelte";
  // Extensions register at import time (fences, panels, commands, slash, flow nodes).
  import { activePanels } from "./ext";
  import CrewRun from "./components/CrewRun.svelte";
  import PackSheet from "./components/PackSheet.svelte";
  import FolderPicker from "./components/FolderPicker.svelte";
  import { folders, closeFolderPicker } from "./lib/folders.svelte";
  import { crew, closeRun, crewLive, openRun } from "./lib/crew.svelte";
  import { packSheet, closePackSheet, closePackPanel } from "./lib/packsheet.svelte";

  let tokenInput = $state("");
  let inspect: ViewBlock | null = $state(null);
  let indexOpen = $state(false);

  const activeStore = $derived.by(() => {
    void app.hostEpoch; // stores are re-created after a host restart
    const c = connection();
    if (!c || !app.activeId) return null;
    return c.session(app.activeId);
  });

  const sess = useSession(() => activeStore);
  const view = $derived(sess.view);
  const pendingList = $derived(view ? [...view.pending.values()] : []);
  const pendingTotal = $derived(queueTotal());

  // Overlay dialogs: focus trap + focus restore for the block inspector and
  // the raw events drawer.
  const dlgBlock = useDialog(() => !!inspect);
  const dlgEvents = useDialog(() => app.eventsOpen && !!view);
  const dlgGallery = useDialog(() => app.galleryOpen);
  // Crew run sheet: same overlay contract; Esc closes it before the gallery.
  const dlgCrew = useDialog(() => !!crew.openId);
  const crewLiveCount = $derived(crewLive().length);
  const crewLiveTop = $derived(crewLive()[0]);

  function connectSubmit(e: SubmitEvent) {
    e.preventDefault();
    const t = tokenInput.trim();
    if (t) start(t);
  }

  function toggleNavigation() {
    if (matchMedia("(max-width: 900px)").matches) indexOpen = !indexOpen;
    else toggleSidebar();
  }

  $effect(() => {
    if (app.sessionAction && matchMedia("(max-width: 900px)").matches) indexOpen = true;
  });
  $effect(() => {
    void app.hostEpoch;
    inspect = null; // never retain raw transcript content after purge/clear
  });

  // Never carry an open off-canvas drawer across the desktop breakpoint.
  $effect(() => {
    const mobile = matchMedia("(max-width: 900px)");
    const onChange = () => {
      indexOpen = false;
    };
    mobile.addEventListener("change", onChange);
    return () => mobile.removeEventListener("change", onChange);
  });

  // The document title doubles as the hidden-tab queue badge; the hidden-tab
  // 100 ms view flush in useSession keeps it tracking while backgrounded.
  $effect(() => {
    const n = queueTotal();
    const meta = app.sessions.find((s) => s.id === app.activeId);
    const title = meta?.title || (view ? view.title : "");
    const base = title ? `dext · ${title}` : "dext";
    document.title = n > 0 ? `(${n}) ${base}` : base;
  });

  // Keyboard-first approvals: a/s/d approve the globally oldest pending
  // request across ALL sessions. Ctrl/Cmd+B rail · N new · [ ] prev/next ·
  // C interrupt · ? shortcuts · any printable key starts a session (hero).
  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      if (app.sessionAction) {
        if (e.key === "Escape" && !app.sessionPending) app.sessionAction = null;
        return;
      }
      dlgBlock.onKey(e);
      dlgEvents.onKey(e);
      dlgGallery.onKey(e);
      dlgCrew.onKey(e);
      if (e.key === "Escape") {
        if (inspect) inspect = null;
        else if (folders.open) closeFolderPicker();
        else if (packSheet.panelOpen) closePackPanel();
        else if (packSheet.open) closePackSheet();
        else if (crew.openId) closeRun();
        else if (app.galleryOpen) app.galleryOpen = false;
        else if (app.eventsOpen) app.eventsOpen = false;
        else if (app.shortcutsOpen) app.shortcutsOpen = false;
        else if (indexOpen) indexOpen = false;
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleNavigation();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newSession();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "[" || e.key === "]")) {
        e.preventDefault();
        stepSession(e.key === "[" ? -1 : 1);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
        // Copy wins whenever something is selected; otherwise stop the turn.
        const target = e.target;
        const selected = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
          ? target.selectionStart !== target.selectionEnd
          : !!window.getSelection()?.toString();
        if (!selected && app.activeId && view?.working) {
          e.preventDefault();
          connection()?.interrupt(app.activeId);
        }
        return;
      }
      // The run sheet owns its keys (j/k/x/a…) so the global a/s/d and
      // hero-typing handlers below never see them while it is open.
      if (app.paletteOpen || app.shortcutsOpen || inspect || app.eventsOpen || app.galleryOpen || packSheet.open || crew.openId || folders.open) return;
      const editing = e.target instanceof HTMLElement && (e.target.matches("input, textarea") || e.target.isContentEditable);
      if (!editing && app.activeId && (e.ctrlKey || e.metaKey) && e.key === "Backspace") {
        e.preventDefault();
        requestSessionAction({ kind: "delete", id: app.activeId });
        return;
      }
      if (!editing && app.activeId && e.key === "F2") {
        e.preventDefault();
        requestSessionAction({ kind: "rename", id: app.activeId });
        return;
      }
      // Modified combos belong to the browser/app (Ctrl+A select-all, Ctrl+S save…).
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "?") {
        e.preventDefault();
        app.shortcutsOpen = true;
        return;
      }
      // Pack gallery from any session; a printable key, so only outside inputs.
      if (e.key === "g" && app.caps.includes("packs") && app.packs.length > 0) {
        e.preventDefault();
        app.galleryOpen = true;
        return;
      }
      // Approvals: a/s/d act on the globally oldest pending request, whether
      // or not a session is active. With only count-only rows, jump there
      // instead of ever responding blind.
      const choice =
        e.key === "a" ? "once" : e.key === "s" ? "always" : e.key === "d" ? "deny" : null;
      if (choice) {
        const target = queue.entries[0];
        if (target) {
          // Activate first so the full card (diff + note) is visible, then act.
          if (target.sessionId !== app.activeId) activate(target.sessionId);
          respondGlobal(target.sessionId, target.pending.request_id, choice);
          return;
        }
        const count = queue.counts[0];
        if (count) {
          activate(count.id);
          return;
        }
      }
      // Hero typing: a printable key with no active session spawns one, seeded
      // with everything typed while it is being created (Composer consumes the
      // stash on mount). Only while the host can actually open a session.
      if (!app.activeId && app.phase === "live" && e.key.length === 1 && e.key.trim()) {
        app.pendingDraft += e.key;
        newSession();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

{#if app.needsToken}
  <div class="pair" data-state="connect" data-agent-id="app.root">
    <form onsubmit={connectSubmit} class="pair-box" data-agent-id="connect.form">
      <p class="pair-title"><span class="st-green">dext</span><span class="blink st-green">▊</span> <span class="dim">web console</span></p>
      <p class="dim">pair with the agent host — paste the token printed by <span class="st-cyan">agentlinkd</span></p>
      <p class="faint">(mock host default: dev-token)</p>
      {#if app.lastError}
        <p class="st-red" data-agent-id="connect.error">✗ {app.lastError}</p>
      {/if}
      <div class="pair-row">
        <span class="st-green">❯</span>
        <input
          bind:value={tokenInput}
          type="password"
          autocomplete="off"
          placeholder="pairing token"
          data-agent-id="connect.token"
        />
        <button type="submit" class="act accent" data-agent-id="connect.submit">[⏎] connect</button>
      </div>
    </form>
  </div>
{:else}
  <div class="shell" class:rail-collapsed={app.sidebarCollapsed} data-state={app.phase} data-agent-id="app.root">
    <aside class="index" data-state={indexOpen ? "open" : "closed"} data-agent-id="session.rail.wrap">
      <SessionIndex onPick={() => (indexOpen = false)} onCollapse={toggleSidebar} onClose={() => (indexOpen = false)} />
    </aside>
    {#if indexOpen}
      <div class="index-scrim" onclick={() => (indexOpen = false)} onkeydown={() => {}} role="presentation"></div>
    {/if}

    <main class="main">
      {#if app.lastError && app.phase !== "failed"}
        <div class="errbar" data-agent-id="banner.error">
          <span class="st-red">✗ {app.lastError}</span>
          <button class="act" data-agent-id="banner.error.dismiss" onclick={() => (app.lastError = "")}>dismiss</button>
        </div>
      {/if}

      {#if activeStore}
        <Scrollback store={activeStore} onInspect={(b) => (inspect = b)} />
        {#if pendingList.length > 0}
          <div class="appr-dock" data-agent-id="approval.dock" data-state="awaiting_approval">
            <div class="appr-axis content-axis">
              {#each pendingList as p (p.request_id)}
                <Approval pending={p} sessionId={app.activeId} />
              {/each}
            </div>
          </div>
        {/if}
      {:else}
        <div class="hero content-axis" data-state="no_session" data-agent-id="hero">
          <p><span class="st-green">dext</span><span class="blink st-green">▊</span> <span class="dim">web console</span></p>
          {#if app.phase === "live" && app.packs.length > 0}
            <PackGallery />
            <p class="faint">or type anything to start a plain session · ⌘k finder</p>
          {:else}
            <p class="dim">pick a session from the index, or start one:</p>
            <p>
              <button class="act accent" data-agent-id="hero.new" onclick={newSession}>+ new session</button>
              <span class="faint"> · ⌘k finder</span>
            </p>
          {/if}
        </div>
      {/if}
    </main>

    <div class="composer">
      {#if activeStore}
        <Composer store={activeStore} />
      {/if}
    </div>

    <div class="todos-row">
      {#if activeStore}
        <Todos store={activeStore} />
      {/if}
      <!-- extension panels (apps/web/src/ext/*): shown for the active session, gated by each panel's when() -->
      {#each activePanels() as p (p.id)}
        <section class="ext-panel" data-agent-id={`ext.panel.${p.id}`}>
          <p.component store={activeStore} />
        </section>
      {/each}
    </div>

    <div class="statusline">
      {#if activeStore}
        <StatusLine store={activeStore} onToggleIndex={toggleNavigation} />
      {:else}
        <div class="sl-min" data-agent-id="status.phase" data-state={app.phase}>
          <button class="act idx-toggle" data-agent-id="index.toggle" onclick={toggleNavigation}>[≡]</button>
          {#if app.sidebarCollapsed}
            <button class="act rail-restore-min" data-agent-id="sidebar.restore" onclick={toggleSidebar}>[› sessions]</button>
          {/if}
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
          {#if crewLiveTop}
            <button class="act st-cyan" data-agent-id="status.crew" data-state={crewLiveTop.state} onclick={() => openRun(crewLiveTop.id)}>crew {crewLiveTop.status === "paused" ? "⚠" : "●"}{crewLiveCount}</button>
          {/if}
          <span class={app.phase === "live" ? "st-green" : app.phase === "failed" ? "st-red" : "st-yellow pulse"}>●</span>
          <span class="dim">{app.phase}{app.phaseDetail ? ` · ${app.phaseDetail}` : ""}</span>
          <button
            class="act"
            data-agent-id="notify.toggle"
            data-state={app.notify}
            onclick={toggleNotify}
            title="notify while the tab is hidden"
          >notify:{app.notify}</button
          >
          <span class="faint sl-min-right">⌘k finder</span>
        </div>
      {/if}
    </div>
  </div>
{/if}

{#if inspect}
  <div
    class="insp"
    role="dialog"
    aria-modal="true"
    aria-label="block inspector"
    tabindex="-1"
    use:dlgBlock.ref
    data-agent-id="drawer.block"
    data-state="open"
  >
    <div class="insp-head">
      <span class="st-magenta">{inspect.kind}</span>
      <span class="dim">raw block</span>
      <span class="insp-acts">
        <button class="act" data-agent-id="drawer.block.close" onclick={() => (inspect = null)}>esc</button>
      </span>
    </div>
    <pre class="insp-body" data-agent-id="drawer.block.json">{JSON.stringify(inspect, null, 2)}</pre>
  </div>
{:else if app.eventsOpen && view}
  <div
    class="insp"
    role="dialog"
    aria-modal="true"
    aria-label="raw events"
    tabindex="-1"
    use:dlgEvents.ref
    data-agent-id="drawer.events"
    data-state="open"
  >
    <div class="insp-head">
      <span class="st-magenta">events</span>
      <span class="dim">last {view.recent.length} envelopes · seq {view.lastSeq}</span>
      <span class="insp-acts">
        <button class="act" data-agent-id="drawer.events.close" onclick={() => (app.eventsOpen = false)}>esc</button>
      </span>
    </div>
    <pre class="insp-body" data-agent-id="drawer.events.json">{view.recent.map((e) => JSON.stringify(e)).join("\n")}</pre>
  </div>
{/if}

{#if crew.openId}
  <div class="insp-scrim" data-agent-id="crew.overlay.scrim" onclick={closeRun} onkeydown={() => {}} role="presentation"></div>
  <div class="insp gallery-overlay crew-overlay" use:dlgCrew.ref data-agent-id="crew.overlay" data-state="open">
    <CrewRun />
  </div>
{/if}

<PackSheet />
<FolderPicker />

{#if app.galleryOpen}
  <div class="insp-scrim" data-agent-id="packs.overlay.scrim" onclick={() => (app.galleryOpen = false)} onkeydown={() => {}} role="presentation"></div>
  <div
    class="insp gallery-overlay"
    role="dialog"
    aria-modal="true"
    aria-label="packs"
    tabindex="-1"
    use:dlgGallery.ref
    data-agent-id="packs.overlay"
    data-state="open"
  >
    <div class="insp-head">
      <span class="st-magenta">packs</span>
      <span class="dim">pick one to prefill the composer</span>
      <span class="insp-acts">
        <button class="act" data-agent-id="packs.overlay.close" onclick={() => (app.galleryOpen = false)}>esc</button>
      </span>
    </div>
    <div class="insp-body gallery-body">
      <PackGallery onPick={() => (app.galleryOpen = false)} />
    </div>
  </div>
{/if}

<Finder />
<Shortcuts />
<Toasts />

<style>
  .pair {
    display: flex;
    height: 100%;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .pair-box {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: min(520px, 100%);
    border: 1px solid var(--line);
    background: var(--bg1);
    padding: 18px 20px;
  }
  .pair-title {
    font-weight: bold;
    margin-bottom: 4px;
  }
  .pair-row {
    display: flex;
    gap: 8px;
    align-items: baseline;
    margin-top: 8px;
    border-top: 1px solid var(--line);
    padding-top: 10px;
  }
  .pair-row input {
    flex: 1;
  }
  .errbar {
    display: flex;
    gap: 10px;
    align-items: baseline;
    padding: 3px 14px;
    border-bottom: 1px solid var(--line);
    background: color-mix(in srgb, var(--red) 6%, transparent);
  }
  .hero {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-start;
    justify-content: center;
  }
  .appr-dock {
    flex-shrink: 0;
    max-height: min(42dvh, 26rem);
    overflow-y: auto;
    overscroll-behavior: contain;
    border-top: 1px solid var(--line);
    padding-block: 6px;
    scrollbar-gutter: stable;
  }
  .appr-axis {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sl-min {
    display: flex;
    gap: 8px;
    align-items: baseline;
    padding: 3px 10px;
    font-size: 12px;
  }
  .sl-min-right {
    margin-left: auto;
  }
  .rail-restore-min {
    color: var(--cyan);
  }
  .idx-toggle {
    display: none;
  }
  @media (max-width: 900px) {
    .idx-toggle {
      display: inline;
    }
    .rail-restore-min {
      display: none;
    }
  }
  .insp {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 35;
    width: min(30rem, 92vw);
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--line);
    background: var(--bg1);
    box-shadow: -8px 0 40px rgba(0, 0, 0, 0.4);
  }
  .insp-head {
    display: flex;
    gap: 10px;
    align-items: baseline;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
  }
  .insp-acts {
    margin-left: auto;
  }
  .insp-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 10px 12px;
    white-space: pre-wrap;
    color: var(--dim);
    font-size: 12px;
  }
  .insp-scrim {
    position: fixed;
    inset: 0;
    z-index: 34;
    background: color-mix(in srgb, var(--bg) 55%, transparent);
  }
  .gallery-overlay {
    width: min(56rem, 96vw);
  }
  .gallery-body {
    white-space: normal;
    color: var(--fg);
    font-size: 13px;
  }
  .st-green {
    color: var(--green);
  }
  .st-cyan {
    color: var(--cyan);
  }
  .st-red {
    color: var(--red);
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
