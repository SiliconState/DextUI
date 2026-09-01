<script lang="ts">
  import { app, activate, newSession } from "../lib/state.svelte";

  let { variant = "rail" }: { variant?: "rail" | "chips" } = $props();

  let query = $state("");

  const statusDot: Record<string, string> = {
    live: "bg-ok",
    starting: "bg-warn animate-pulse",
    cold: "bg-faint",
    exited: "bg-err",
  };

  const filtered = $derived(
    app.sessions.filter((s) => {
      const q = query.trim().toLowerCase();
      return !q || s.title.toLowerCase().includes(q) || s.id.toLowerCase().includes(q);
    }),
  );
</script>

{#if variant === "rail"}
  <div class="flex h-full flex-col" data-agent-id="session.rail">
    <div class="space-y-2 p-3">
      <button
        data-agent-id="session.new"
        onclick={newSession}
        class="w-full rounded-xl bg-accent/15 px-3 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/25"
      >
        + New session
      </button>
      <input
        bind:value={query}
        type="search"
        placeholder="Search sessions…"
        class="w-full rounded-lg border border-line bg-raised px-2.5 py-1.5 text-xs outline-none focus:border-accent"
        data-agent-id="session.search"
      />
    </div>
    <div class="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
      <p class="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-faint" data-agent-id="session.rail.count">
        {filtered.length} session{filtered.length === 1 ? "" : "s"}
      </p>
      {#each filtered as s (s.id)}
        <button
          data-agent-id={`session.${s.id}.open`}
          data-state={s.id === app.activeId ? "active" : "inactive"}
          onclick={() => activate(s.id)}
          class={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${
            s.id === app.activeId ? "border-accent/50 bg-raised" : "border-transparent hover:bg-raised/60"
          }`}
        >
          <span class="flex items-center gap-2">
            <span class={`h-2 w-2 shrink-0 rounded-full ${statusDot[s.status] ?? "bg-faint"}`}></span>
            <span class="flex-1 truncate text-sm">{s.title}</span>
            {#if s.pending_permissions > 0}
              <span class="shrink-0 rounded bg-warn/20 px-1.5 text-xs text-warn" data-agent-id={`session.${s.id}.pending`}>
                {s.pending_permissions}
              </span>
            {/if}
          </span>
          <span class="mt-0.5 flex gap-2 pl-4 text-xs text-faint">
            <span class="truncate">{s.model ?? s.agent.name}</span>
            <span class="shrink-0">{s.status}</span>
          </span>
        </button>
      {:else}
        <p class="px-2 py-4 text-center text-xs text-faint" data-agent-id="session.rail.empty">No matches.</p>
      {/each}
    </div>
    <div class="border-t border-line px-3 py-2 text-[11px] text-faint">
      <span class="font-mono">⌘K</span> command palette
    </div>
  </div>
{:else}
  <div class="flex gap-2 overflow-x-auto p-2" data-agent-id="session.chips">
    {#each app.sessions as s (s.id)}
      <button
        data-agent-id={`session.${s.id}.open`}
        onclick={() => activate(s.id)}
        class={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs ${
          s.id === app.activeId ? "border-accent/60 bg-raised" : "border-line bg-panel"
        }`}
      >
        <span class={`h-1.5 w-1.5 rounded-full ${statusDot[s.status] ?? "bg-faint"}`}></span>
        <span class="max-w-40 truncate">{s.title}</span>
        {#if s.pending_permissions > 0}
          <span class="rounded bg-warn/20 px-1 text-warn">{s.pending_permissions}</span>
        {/if}
      </button>
    {/each}
    <button
      data-agent-id="session.new"
      onclick={newSession}
      class="shrink-0 rounded-full border border-line bg-panel px-3 py-1.5 text-xs text-accent"
    >
      + New
    </button>
  </div>
{/if}
