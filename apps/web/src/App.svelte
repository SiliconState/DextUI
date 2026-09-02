<script lang="ts">
  import { app, start, connection, newSession, toggleSidebar } from "./lib/state.svelte";
  import type { Block } from "@dextui/protocol";
  import SessionIndex from "./components/SessionIndex.svelte";
  import Scrollback from "./components/Scrollback.svelte";
  import Approval from "./components/Approval.svelte";
  import Composer from "./components/Composer.svelte";
  import StatusLine from "./components/StatusLine.svelte";
  import Finder from "./components/Finder.svelte";
  import Toasts from "./components/Toasts.svelte";

  let tokenInput = $state("");
  let inspect: Block | null = $state(null);
  let indexOpen = $state(false);

  const activeStore = $derived.by(() => {
    const c = connection();
    if (!c || !app.activeId) return null;
    return c.session(app.activeId);
  });

  let tick = $state(0);
  $effect(() => {
    if (!activeStore) return;
    const unsub = activeStore.subscribe(() => {
      tick++;
    });
    return () => {
      unsub();
    };
  });

  const view = $derived.by(() => {
    void tick;
    // Re-boxed per tick: Svelte 5 deriveds skip propagation on reference equality.
    return activeStore ? { ...activeStore.state } : null;
  });
  const pendingList = $derived(view ? [...view.pending.values()] : []);

  function connectSubmit(e: SubmitEvent) {
    e.preventDefault();
    const t = tokenInput.trim();
    if (t) start(t);
  }

  function respond(requestId: string, choice: "once" | "always" | "deny") {
    const c = connection();
    if (c && app.activeId) c.respond(app.activeId, requestId, choice);
  }

  function toggleNavigation() {
    if (matchMedia("(max-width: 900px)").matches) indexOpen = !indexOpen;
    else toggleSidebar();
  }

  // Never carry an open off-canvas drawer across the desktop breakpoint.
  $effect(() => {
    const mobile = matchMedia("(max-width: 900px)");
    const onChange = () => {
      indexOpen = false;
    };
    mobile.addEventListener("change", onChange);
    return () => mobile.removeEventListener("change", onChange);
  });

  // Keyboard-first approvals: a=once, s=always, d=deny; Ctrl/Cmd+B toggles navigation.
  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (inspect) inspect = null;
        else if (indexOpen) indexOpen = false;
        return;
      }
      if (app.paletteOpen || inspect) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleNavigation();
        return;
      }
      // Modified combos belong to the browser/app (Ctrl+A select-all, Ctrl+S save…).
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const first = pendingList[0];
      if (!first) return;
      if (e.key === "a") respond(first.request_id, "once");
      else if (e.key === "s") respond(first.request_id, "always");
      else if (e.key === "d") respond(first.request_id, "deny");
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
          <p class="dim">pick a session from the index, or start one:</p>
          <p>
            <button class="act accent" data-agent-id="hero.new" onclick={newSession}>+ new session</button>
            <span class="faint"> · ⌘k finder</span>
          </p>
        </div>
      {/if}
    </main>

    <div class="composer">
      {#if activeStore}
        <Composer store={activeStore} />
      {/if}
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
          <span class={app.phase === "live" ? "st-green" : app.phase === "failed" ? "st-red" : "st-yellow pulse"}>●</span>
          <span class="dim">{app.phase}{app.phaseDetail ? ` · ${app.phaseDetail}` : ""}</span>
          <span class="faint sl-min-right">⌘k finder</span>
        </div>
      {/if}
    </div>
  </div>
{/if}

{#if inspect}
  <div class="insp" data-agent-id="drawer.block" data-state="open">
    <div class="insp-head">
      <span class="st-magenta">{inspect.kind}</span>
      <span class="dim">raw block</span>
      <span class="insp-acts">
        <button class="act" data-agent-id="drawer.block.close" onclick={() => (inspect = null)}>esc</button>
      </span>
    </div>
    <pre class="insp-body" data-agent-id="drawer.block.json">{JSON.stringify(inspect, null, 2)}</pre>
  </div>
{/if}

<Finder />
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
