<script lang="ts">
  // Session index: a plain text list, like dext's own listings.
  // Status glyphs mirror the TUI: ● live · ● starting (pulse) · ○ cold · ● exited.
  import { app, activate, newSession } from "../lib/state.svelte";

  let { onPick }: { onPick?: () => void } = $props();

  let query = $state("");

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
    <button class="act accent" data-agent-id="session.new" onclick={newSession}>+ new</button>
  </div>
  <input
    bind:value={query}
    type="search"
    placeholder="filter…"
    class="idx-search"
    data-agent-id="session.search"
  />
  <div class="idx-list">
    {#each filtered as s (s.id)}
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
    {:else}
      <p class="idx-empty" data-agent-id="session.rail.empty">no matches</p>
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
  .idx-head .act {
    margin-left: auto;
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
  .idx-row {
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
