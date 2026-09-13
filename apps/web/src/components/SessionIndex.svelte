<script lang="ts">
  // Session index: a plain text list, like dext's own listings.
  // Status glyphs mirror the TUI: ● live · ● starting (pulse) · ○ cold · ● exited.
  import { app, activate, newSession, closeSession, wakeSession, requestSessionAction, prefillComposer, packStarter, packUnmet } from "../lib/state.svelte";
  import { packTitle } from "../lib/persona.svelte";
  import { titleCase } from "../lib/display";
  import SessionAction from "./SessionAction.svelte";
  import ActionQueue from "./ActionQueue.svelte";
  import CrewRail from "./CrewRail.svelte";

  let {
    onPick,
    onCollapse,
    onClose,
  }: { onPick?: () => void; onCollapse?: () => void; onClose?: () => void } = $props();

  let query = $state("");
  let menu = $state("");
  let packsOpen = $state(localStorage.getItem("dextui.railPacksOpen") === "1");
  const canManage = $derived(app.caps.includes("session_manage"));
  const hasPacks = $derived(app.caps.includes("packs") && app.packs.length > 0);
  const packShelves = $derived.by(() => {
    const by = new Map<string, typeof app.packs>();
    for (const p of app.packs) {
      const k = p.shelf ?? "other";
      if (!by.has(k)) by.set(k, []);
      by.get(k)!.push(p);
    }
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b));
  });

  function togglePacks() {
    packsOpen = !packsOpen;
    localStorage.setItem("dextui.railPacksOpen", packsOpen ? "1" : "0");
  }
  const disabled = $derived(app.phase !== "live" || app.sessionPending);

  const filtered = $derived(
    app.sessions.filter((s) => {
      const q = query.trim().toLowerCase();
      return !q || s.title.toLowerCase().includes(q) || s.id.toLowerCase().includes(q);
    }),
  );

  function glyph(status: string): string {
    if (status === "cold") return "○";
    return "●";
  }

  function pick(id: string) {
    activate(id);
    onPick?.();
  }
</script>

<div class="idx" data-agent-id="session.rail">
  <div class="idx-head">
    <span class="faint">Sessions</span>
    <span class="faint">{filtered.length}</span>
    <button class="act accent" data-agent-id="session.new" onclick={newSession} disabled={disabled}>+ New</button>
    {#if canManage}<button class="act" aria-label="Manage sessions" aria-expanded={menu === "all"} data-agent-id="sessions.manage" onclick={() => (menu = menu === "all" ? "" : "all")}>⋯</button>{/if}
    <button class="act rail-min" data-agent-id="sidebar.collapse" onclick={onCollapse} title="Minimize sessions (Ctrl/Cmd+B)">[‹]</button>
    <button class="act rail-close" data-agent-id="sidebar.close" onclick={onClose} title="Close sessions">[×]</button>
  </div>
  {#if menu === "all"}
    <div class="idx-actions">
      <button class="act err" disabled={disabled || !app.sessions.some((s) => s.status === "cold" || s.status === "exited")}
        data-agent-id="sessions.delete_cold" onclick={() => { menu = ""; requestSessionAction({ kind: "bulk", scope: "cold" }); }}>Delete closed</button>
      <button class="act err" disabled={disabled || !app.sessions.length}
        data-agent-id="sessions.delete_all" onclick={() => { menu = ""; requestSessionAction({ kind: "bulk", scope: "all" }); }}>Delete all</button>
    </div>
  {/if}
  {#if app.phase === "live" && !canManage}
    <p class="idx-note" data-agent-id="session.manage.unavailable">Rename/clear/delete hidden: this host doesn't advertise <code>session_manage</code> — restart it on current code</p>
  {/if}
  <SessionAction />
  <ActionQueue {onPick} />
  <CrewRail {onPick} />
  <input
    bind:value={query}
    type="search"
    placeholder="Filter…"
    class="idx-search"
    data-agent-id="session.search"
  />
  <div class="idx-list">
    {#each filtered as s (s.id)}
      <div class="idx-entry">
      <div class="idx-main">
      <button
        class="idx-row"
        class:active={s.id === app.activeId}
        data-agent-id={`session.${s.id}.open`}
        data-state={s.id === app.activeId ? "active" : "idle"}
        onclick={() => pick(s.id)}
      >
        <span class="idx-title">
          <span class="idx-cur">{s.id === app.activeId ? "❯" : " "}</span>
          <span class={`st-${s.status}`} class:pulse={s.status === "starting"}>{glyph(s.status)}</span>
          <span class="truncate">{s.title}</span>
          {#if s.pending_permissions + (s.pending_ui_requests ?? 0) > 0}
            <span class="st-warn" data-agent-id={`session.${s.id}.pending`}>!{s.pending_permissions + (s.pending_ui_requests ?? 0)}</span>
          {/if}
        </span>
        <span class="idx-sub">
          {s.model ?? s.agent.name} · {titleCase(s.status)}
        </span>
      </button>
      {#if canManage}
        <button class="act idx-more" aria-label={`Actions for ${s.title}`} aria-expanded={menu === s.id}
          data-agent-id={`session.${s.id}.actions`} onclick={() => (menu = menu === s.id ? "" : s.id)}>⋯</button>
      {/if}
      </div>
      {#if menu === s.id}
        <div class="idx-actions">
          <button class="act" disabled={disabled} data-agent-id={`session.${s.id}.rename`} onclick={() => requestSessionAction({ kind: "rename", id: s.id })}>Rename</button>
          {#if s.status === "cold"}
            <button class="act" disabled={disabled} data-agent-id={`session.${s.id}.wake`} onclick={() => wakeSession(s.id)}>Wake</button>
          {:else if s.status !== "exited"}
            <button class="act" disabled={disabled} title="Stop the agent; keep history for later" data-agent-id={`session.${s.id}.close`} onclick={() => closeSession(s.id)}>Close</button>
          {/if}
          <button class="act" disabled={disabled} data-agent-id={`session.${s.id}.clear`} onclick={() => requestSessionAction({ kind: "clear", id: s.id })}>Clear</button>
          <button class="act err" disabled={disabled} data-agent-id={`session.${s.id}.delete`} onclick={() => requestSessionAction({ kind: "delete", id: s.id })}>Delete</button>
        </div>
      {/if}
      </div>
    {:else}
      <p class="idx-empty" data-agent-id="session.rail.empty">{app.sessions.length ? "No matches" : "No sessions yet — start with + New."}</p>
    {/each}
  </div>
  {#if hasPacks}
    <div class="idx-packs" data-agent-id="rail.packs" data-state={packsOpen ? "open" : "closed"}>
      <button class="idx-packs-head" aria-expanded={packsOpen} data-agent-id="rail.packs.toggle" onclick={togglePacks}>
        <span class="faint">{packsOpen ? "▾" : "▸"}</span> <span class="st-magenta">Packs</span> <span class="faint">{app.packs.length}</span>
        <span class="faint idx-packs-g">g</span>
      </button>
      {#if packsOpen}
        <div class="idx-packs-list">
          {#each packShelves as [shelf, list] (shelf)}
            <div class="idx-shelf faint">{shelf}</div>
            {#each list as p (p.name)}
              {@const missing = packUnmet(p)}
              <div class="idx-pack">
                <button class="idx-pack-run" data-agent-id={`rail.packs.${p.name}.run`} title={missing.length ? `${p.description} — needs ${missing.join(", ")}` : p.description}
                  onclick={() => { prefillComposer(packStarter(p)); onPick?.(); }}>
                  <span class:st-cyan={!missing.length} class:faint={missing.length > 0}>{packTitle(p)}</span>
                  {#if missing.length}<span class="st-warn">!</span>{/if}
                </button>
                <button class="act idx-pack-edit" data-agent-id={`rail.packs.${p.name}.edit`} title={`Edit ${p.path}`}
                  onclick={() => { prefillComposer(`Edit the ${p.name} pack at ${p.path}: `); onPick?.(); }}>Edit</button>
              </div>
            {/each}
          {/each}
          <button class="act idx-pack-new" data-agent-id="rail.packs.new" onclick={() => { prefillComposer("/pack create "); onPick?.(); }}>+ new pack</button>
        </div>
      {/if}
    </div>
  {/if}
  <div class="idx-foot faint">⌘k Finder · a/s/d approve · image shares open for review</div>
</div>

<style>
  .idx {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .idx-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 8px 10px 4px;
    border-bottom: 1px solid var(--line);
  }
  .idx-head [data-agent-id="session.new"] {
    margin-left: auto;
  }
  .rail-close {
    display: none;
  }
  @media (max-width: 900px) {
    .rail-min {
      display: none;
    }
    .rail-close {
      display: inline;
    }
  }
  .idx-search {
    padding: 6px 10px;
    border-bottom: 1px solid var(--line);
    color: var(--fg);
  }
  .idx-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px 0;
  }
  .idx-main { display: flex; align-items: center; }
  .idx-more { flex-shrink: 0; padding: 8px; }
  .idx-actions { display: flex; flex-wrap: wrap; gap: 10px; padding: 8px 10px; background: var(--bg1); font-size: 11px; }
  .idx-note { padding: 6px 10px; border-bottom: 1px solid var(--line); font-size: 11px; color: var(--faint); overflow-wrap: anywhere; }
  .idx-note code { color: var(--dim); }
  button:focus-visible { outline: 1px solid var(--cyan); outline-offset: -1px; }
  .idx-row {
    min-width: 0;
    flex: 1;
    display: block;
    width: 100%;
    padding: 4px 10px;
    line-height: 1.4;
  }
  .idx-row:hover {
    background: var(--bg2);
  }
  .idx-row.active {
    background: var(--bg2);
  }
  .idx-title {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .idx-cur {
    color: var(--cyan);
    width: 12px;
    flex-shrink: 0;
  }
  .idx-sub {
    display: block;
    padding-left: 18px;
    color: var(--faint);
    font-size: 11px;
  }
  .truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .idx-empty {
    padding: 12px 10px;
    color: var(--faint);
  }
  .idx-foot {
    padding: 6px 10px;
    border-top: 1px solid var(--line);
    font-size: 11px;
  }
  .idx-packs { border-top: 1px solid var(--line); max-height: 40%; display: flex; flex-direction: column; min-height: 0; }
  .idx-packs-head { display: flex; gap: 6px; align-items: baseline; width: 100%; padding: 6px 10px; }
  .idx-packs-head:hover { background: var(--bg2); }
  .idx-packs-g { margin-left: auto; border: 1px solid var(--line); padding: 0 4px; font-size: 10px; }
  .idx-packs-list { overflow-y: auto; min-height: 0; padding: 2px 0 6px; }
  .idx-shelf { padding: 4px 10px 0; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
  .idx-pack { display: flex; align-items: baseline; }
  .idx-pack-run { flex: 1; min-width: 0; display: flex; gap: 6px; padding: 2px 10px 2px 18px; text-align: left; overflow: hidden; }
  .idx-pack-run:hover { background: var(--bg2); }
  .idx-pack-edit { visibility: hidden; padding: 2px 10px; font-size: 11px; }
  .idx-pack:hover .idx-pack-edit, .idx-pack:focus-within .idx-pack-edit { visibility: visible; }
  .idx-pack-new { padding: 4px 10px 0 18px; font-size: 11px; }
  .faint {
    color: var(--faint);
  }
  .st-live {
    color: var(--green);
  }
  .st-starting {
    color: var(--yellow);
  }
  .st-cold {
    color: var(--faint);
  }
  .st-exited {
    color: var(--red);
  }
  .st-warn {
    color: var(--yellow);
    margin-left: auto;
  }
</style>
