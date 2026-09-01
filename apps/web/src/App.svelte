<script lang="ts">
  import { app, start, connection, newSession, toggleTheme, copyText } from "./lib/state.svelte";
  import type { Block } from "@dextui/protocol";
  import SessionRail from "./components/SessionRail.svelte";
  import Transcript from "./components/Transcript.svelte";
  import PermissionCard from "./components/PermissionCard.svelte";
  import Composer from "./components/Composer.svelte";
  import StatusFooter from "./components/StatusFooter.svelte";
  import Toasts from "./components/Toasts.svelte";
  import CommandPalette from "./components/CommandPalette.svelte";

  let tokenInput = $state("");
  let inspect: Block | null = $state(null);

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
    // Shallow copy per tick: Svelte 5 deriveds skip propagation when the value
    // is reference-equal, so the mutated-in-place store state must be re-boxed.
    return activeStore ? { ...activeStore.state } : null;
  });
  const pendingList = $derived(view ? [...view.pending.values()] : []);
  const activeMeta = $derived(app.sessions.find((s) => s.id === app.activeId) ?? null);

  const phaseClass: Record<string, string> = {
    connecting: "border-line text-faint",
    authing: "border-warn/40 text-warn",
    live: "border-ok/40 text-ok",
    reconnecting: "border-warn/40 text-warn",
    closed: "border-line text-faint",
    failed: "border-err/40 text-err",
  };
  const phaseDot: Record<string, string> = {
    connecting: "bg-faint animate-pulse",
    authing: "bg-warn animate-pulse",
    live: "bg-ok",
    reconnecting: "bg-warn animate-pulse",
    closed: "bg-faint",
    failed: "bg-err",
  };

  function connectSubmit(e: SubmitEvent) {
    e.preventDefault();
    const t = tokenInput.trim();
    if (t) start(t);
  }

  function respond(requestId: string, choice: "once" | "always" | "deny") {
    const c = connection();
    if (c && app.activeId) c.respond(app.activeId, requestId, choice);
  }

  // Keyboard-first approvals on desktop: a=once, s=always, d=deny; esc closes overlays.
  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (inspect) inspect = null;
        return;
      }
      if (app.paletteOpen) return;
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

<div class="flex h-full flex-col" data-state={app.phase} data-agent-id="app.root">
  {#if app.needsToken}
    <div class="flex flex-1 items-center justify-center p-6">
      <form
        onsubmit={connectSubmit}
        class="w-full max-w-sm space-y-4 rounded-2xl border border-line bg-panel p-6 shadow-2xl"
        data-state="connect"
        data-agent-id="connect.form"
      >
        <div class="space-y-1">
          <div class="flex items-center gap-2">
            <img src="/icon.svg" class="h-7 w-7" alt="" />
            <h1 class="dext-gradient-text text-xl font-semibold tracking-tight">DextUI</h1>
          </div>
          <p class="text-sm text-dim">
            Pair with the agent host. Paste the token printed by
            <code class="rounded bg-raised px-1 font-mono text-xs">agentlinkd</code> — the mock host defaults to
            <code class="rounded bg-raised px-1 font-mono text-xs">dev-token</code>.
          </p>
        </div>
        {#if app.lastError}
          <p class="rounded-lg border border-err/30 bg-err/10 px-3 py-2 text-sm text-err" data-agent-id="connect.error">{app.lastError}</p>
        {/if}
        <input
          bind:value={tokenInput}
          type="password"
          autocomplete="off"
          placeholder="pairing token"
          class="w-full rounded-xl border border-line bg-raised px-3 py-2 text-sm focus:border-accent focus:outline-none"
          data-agent-id="connect.token"
        />
        <button
          type="submit"
          class="w-full rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-bg hover:opacity-90"
          data-agent-id="connect.submit"
        >
          Connect
        </button>
      </form>
    </div>
  {:else}
    <header class="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 md:gap-3 md:px-4" data-agent-id="app.header">
      <div class="flex items-center gap-2">
        <img src="/icon.svg" class="h-5 w-5" alt="" />
        <span class="dext-gradient-text font-semibold tracking-tight">DextUI</span>
      </div>
      <span
        class={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${phaseClass[app.phase] ?? ""}`}
        data-agent-id="status.phase"
        data-state={app.phase}
      >
        <span class={`h-1.5 w-1.5 rounded-full ${phaseDot[app.phase] ?? "bg-faint"}`}></span>
        {app.phase}{app.phaseDetail ? ` · ${app.phaseDetail}` : ""}
      </span>
      {#if activeMeta}
        <span class="hidden min-w-0 flex-1 truncate text-sm text-dim lg:inline" data-agent-id="app.session.title">{activeMeta.title}</span>
      {:else}
        <span class="flex-1"></span>
      {/if}
      {#if pendingList.length > 0}
        <span class="ml-auto rounded-lg bg-warn/20 px-2 py-0.5 text-xs font-medium text-warn" data-agent-id="queue.count">
          {pendingList.length} pending approval{pendingList.length === 1 ? "" : "s"}
        </span>
      {/if}
      <button
        data-agent-id="palette.open"
        onclick={() => (app.paletteOpen = true)}
        class="ml-auto shrink-0 rounded-lg border border-line px-2.5 py-1 font-mono text-xs text-dim hover:border-accent/60 hover:text-ink"
        title="Command palette"
      >
        ⌘K
      </button>
      <button
        data-agent-id="theme.toggle"
        onclick={toggleTheme}
        class="shrink-0 rounded-lg border border-line px-2.5 py-1 text-xs text-dim hover:border-accent/60 hover:text-ink"
        title="Toggle theme"
      >
        {app.theme === "dark" ? "☀" : "☾"}
      </button>
    </header>

    <div class="flex min-h-0 flex-1">
      <aside class="hidden w-64 shrink-0 border-r border-line bg-panel md:block" data-agent-id="session.rail.wrap">
        <SessionRail variant="rail" />
      </aside>

      <main class="flex min-h-0 flex-1 flex-col">
        <div class="shrink-0 border-b border-line bg-panel md:hidden" data-agent-id="session.chips.bar">
          <SessionRail variant="chips" />
        </div>

        {#if app.lastError && app.phase !== "failed"}
          <div
            class="flex shrink-0 items-center gap-2 border-b border-err/30 bg-err/10 px-4 py-1.5 text-xs text-err"
            data-agent-id="banner.error"
          >
            <span class="flex-1 truncate">{app.lastError}</span>
            <button onclick={() => (app.lastError = "")} data-agent-id="banner.error.dismiss">×</button>
          </div>
        {/if}

        {#if activeStore}
          <Transcript store={activeStore} onInspect={(b) => (inspect = b)} />
          {#each pendingList as p (p.request_id)}
            <PermissionCard pending={p} sessionId={app.activeId} />
          {/each}
          <Composer store={activeStore} />
          <StatusFooter store={activeStore} />
        {:else}
          <div class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center" data-state="no_session" data-agent-id="hero">
            <span class="dext-gradient-text text-2xl font-semibold tracking-tight">DextUI</span>
            <p class="max-w-sm text-sm text-dim">
              Create a session or pick one from the rail. Press
              <kbd class="rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-xs">⌘K</kbd>
              anytime for the command palette.
            </p>
            <button
              data-agent-id="hero.new"
              onclick={newSession}
              class="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-bg hover:opacity-90"
            >
              + New session
            </button>
          </div>
        {/if}
      </main>
    </div>
  {/if}
</div>

{#if inspect}
  <div
    class="fixed inset-y-0 right-0 z-30 flex w-[26rem] max-w-[90vw] flex-col border-l border-line bg-panel shadow-2xl"
    data-agent-id="drawer.block"
    data-state="open"
  >
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
      <span class="rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-[10px] uppercase text-accent2">{inspect.kind}</span>
      <span class="flex-1 truncate text-sm text-dim">raw block</span>
      <button class="text-xs text-dim hover:text-ink" data-agent-id="drawer.block.copy" onclick={() => copyText(JSON.stringify(inspect, null, 2), "Copied JSON")}>
        copy
      </button>
      <button class="rounded-lg border border-line px-2 py-0.5 text-xs text-dim hover:text-ink" data-agent-id="drawer.block.close" onclick={() => (inspect = null)}>
        esc
      </button>
    </div>
    <pre class="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed text-dim" data-agent-id="drawer.block.json">{JSON.stringify(inspect, null, 2)}</pre>
  </div>
{/if}

<CommandPalette />
<Toasts />
