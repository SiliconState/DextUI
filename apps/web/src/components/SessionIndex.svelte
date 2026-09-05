<script lang="ts">
  // Session index: a plain text list, like dext's own listings.
  // Status glyphs mirror the TUI: ● live · ● starting (pulse) · ○ cold · ● exited.
  import { app, activate, newSession, closeSession, wakeSession, requestSessionAction } from "../lib/state.svelte";
  import SessionAction from "./SessionAction.svelte";
  import ActionQueue from "./ActionQueue.svelte";

  let {
    onPick,
    onCollapse,
    onClose,
  }: { onPick?: () => void; onCollapse?: () => void; onClose?: () => void } = $props();

  let query = $state("");
  let menu = $state("");
  const canManage = $derived(app.caps.includes("session_manage"));
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
    <span class="faint">sessions</span>
    <span class="faint">{filtered.length}</span>
    <button class="act accent" data-agent-id="session.new" onclick={newSession} disabled={disabled}>+ new</button>
    {#if canManage}<button class="act" aria-label="Manage sessions" aria-expanded={menu === "all"} data-agent-id="sessions.manage" onclick={() => (menu = menu === "all" ? "" : "all")}>⋯</button>{/if}
    <button class="act rail-min" data-agent-id="sidebar.collapse" onclick={onCollapse} title="Minimize sessions (Ctrl/Cmd+B)">[‹]</button>
    <button class="act rail-close" data-agent-id="sidebar.close" onclick={onClose} title="Close sessions">[×]</button>
  </div>
  {#if menu === "all"}
    <div class="idx-actions">
      <button class="act err" disabled={disabled || !app.sessions.some((s) => s.status === "cold" || s.status === "exited")}
        data-agent-id="sessions.delete_cold" onclick={() => { menu = ""; requestSessionAction({ kind: "bulk", scope: "cold" }); }}>delete closed</button>
      <button class="act err" disabled={disabled || !app.sessions.length}
        data-agent-id="sessions.delete_all" onclick={() => { menu = ""; requestSessionAction({ kind: "bulk", scope: "all" }); }}>delete all</button>
    </div>
  {/if}
  <SessionAction />
  <ActionQueue {onPick} />
  <input
    bind:value={query}
    type="search"
    placeholder="filter…"
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
          {#if s.pending_permissions > 0}
            <span class="st-warn" data-agent-id={`session.${s.id}.pending`}>!{s.pending_permissions}</span>
          {/if}
        </span>
        <span class="idx-sub">
          {s.model ?? s.agent.name} · {s.status}
        </span>
      </button>
      {#if canManage}
        <button class="act idx-more" aria-label={`Actions for ${s.title}`} aria-expanded={menu === s.id}
          data-agent-id={`session.${s.id}.actions`} onclick={() => (menu = menu === s.id ? "" : s.id)}>⋯</button>
      {/if}
      </div>
      {#if menu === s.id}
        <div class="idx-actions">
          <button class="act" disabled={disabled} data-agent-id={`session.${s.id}.rename`} onclick={() => requestSessionAction({ kind: "rename", id: s.id })}>rename</button>
          {#if s.status === "cold"}
            <button class="act" disabled={disabled} data-agent-id={`session.${s.id}.wake`} onclick={() => wakeSession(s.id)}>wake</button>
          {:else if s.status !== "exited"}
            <button class="act" disabled={disabled} title="Stop the agent; keep history for later" data-agent-id={`session.${s.id}.close`} onclick={() => closeSession(s.id)}>close</button>
          {/if}
          <button class="act" disabled={disabled} data-agent-id={`session.${s.id}.clear`} onclick={() => requestSessionAction({ kind: "clear", id: s.id })}>clear</button>
          <button class="act err" disabled={disabled} data-agent-id={`session.${s.id}.delete`} onclick={() => requestSessionAction({ kind: "delete", id: s.id })}>delete</button>
        </div>
      {/if}
      </div>
    {:else}
      <p class="idx-empty" data-agent-id="session.rail.empty">{app.sessions.length ? "no matches" : "No sessions yet — start with + new."}</p>
    {/each}
  </div>
  <div class="idx-foot faint">⌘k finder · a/s/d approve</div>
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
