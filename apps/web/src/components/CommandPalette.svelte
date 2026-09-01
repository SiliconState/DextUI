<script lang="ts">
  import {
    app,
    connection,
    activate,
    newSession,
    toggleTheme,
    copyText,
    rePair,
  } from "../lib/state.svelte";

  let query = $state("");
  let cursor = $state(0);
  let inputEl: HTMLInputElement | undefined = $state();

  interface Action {
    slug: string;
    label: string;
    hint?: string;
    group: string;
    run: () => void;
  }

  const actions = $derived.by<Action[]>(() => {
    const c = connection();
    const out: Action[] = [
      { slug: "session.new", label: "New session", hint: "switches to it", group: "Session", run: newSession },
      { slug: "theme.toggle", label: `Switch to ${app.theme === "dark" ? "light" : "dark"} theme`, group: "App", run: toggleTheme },
      { slug: "pair.reset", label: "Re-pair with agent host…", hint: "clears token", group: "App", run: rePair },
    ];
    if (c && app.activeId) {
      out.push({
        slug: "session.copyid",
        label: "Copy session id",
        group: "Session",
        run: () => copyText(app.activeId, "Session id"),
      });
      const store = c.session(app.activeId);
      if (store.state.working) {
        out.push({
          slug: "turn.stop",
          label: "Stop the running turn",
          group: "Turn",
          run: () => connection()?.interrupt(app.activeId),
        });
      }
      for (const p of store.state.pending.values()) {
        const short = p.summary ? ` — ${p.summary.slice(0, 40)}` : "";
        out.push({
          slug: `approve.${p.request_id}.once`,
          label: `Approve once: ${p.tool}${short}`,
          hint: "a",
          group: "Approvals",
          run: () => connection()?.respond(app.activeId, p.request_id, "once"),
        });
        out.push({
          slug: `approve.${p.request_id}.always`,
          label: `Approve always: ${p.tool}${short}`,
          hint: "s",
          group: "Approvals",
          run: () => connection()?.respond(app.activeId, p.request_id, "always"),
        });
        out.push({
          slug: `approve.${p.request_id}.deny`,
          label: `Deny: ${p.tool}${short}`,
          hint: "d",
          group: "Approvals",
          run: () => connection()?.respond(app.activeId, p.request_id, "deny"),
        });
      }
    }
    for (const s of app.sessions) {
      if (s.id === app.activeId) continue;
      out.push({
        slug: `goto.${s.id}`,
        label: `Switch to: ${s.title}`,
        hint: s.status,
        group: "Sessions",
        run: () => activate(s.id),
      });
    }
    return out;
  });

  function score(a: Action, q: string): number {
    if (!q) return 1;
    const l = a.label.toLowerCase();
    let i = 0;
    let s = 0;
    for (const ch of q) {
      const idx = l.indexOf(ch, i);
      if (idx < 0) return -1;
      s += idx === i ? 2 : 1;
      i = idx + 1;
    }
    return s + (l.startsWith(q) ? 5 : 0);
  }

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    void actions.length; // recompute when session/app state shifts the action list
    return actions
      .map((a) => ({ a, s: score(a, q) }))
      .filter((x) => x.s >= 0)
      .sort((x, y) => y.s - x.s)
      .slice(0, 12)
      .map((x) => x.a);
  });

  $effect(() => {
    if (app.paletteOpen) {
      cursor = 0;
      requestAnimationFrame(() => inputEl?.focus());
    } else {
      query = "";
    }
  });

  function close() {
    app.paletteOpen = false;
  }

  function run(a: Action) {
    close();
    a.run();
  }

  function onWindowKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      app.paletteOpen = !app.paletteOpen;
      return;
    }
    if (!app.paletteOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      cursor = Math.min(filtered.length - 1, cursor + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      cursor = Math.max(0, cursor - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const a = filtered[cursor];
      if (a) run(a);
    }
  }
</script>

<svelte:window onkeydown={onWindowKey} />

{#if app.paletteOpen}
  <div
    class="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]"
    data-agent-id="palette.overlay"
    onclick={close}
    onkeydown={() => {}}
    role="presentation"
  ></div>
  <div
    class="fixed left-1/2 top-20 z-40 w-[36rem] max-w-[92vw] -translate-x-1/2 animate-[rise_.15s_ease-out] rounded-2xl border border-line bg-panel shadow-2xl"
    data-agent-id="palette.root"
    data-state="open"
  >
    <div class="flex items-center gap-2 border-b border-line px-4 py-3">
      <span class="font-mono text-sm text-faint">⌘K</span>
      <input
        bind:this={inputEl}
        bind:value={query}
        placeholder="Type a command or session name…"
        class="w-full bg-transparent text-[15px] outline-none placeholder:text-faint"
        data-agent-id="palette.input"
      />
      <span class="text-xs text-faint">esc</span>
    </div>
    <div class="max-h-80 overflow-y-auto p-1.5" data-agent-id="palette.list">
      {#each filtered as a, i (a.slug)}
        <button
          data-agent-id={`palette.item.${a.slug}`}
          data-state={i === cursor ? "cursor" : "idle"}
          onclick={() => run(a)}
          onmousemove={() => (cursor = i)}
          class={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${
            i === cursor ? "bg-accent/15 text-ink" : "text-dim hover:bg-raised"
          }`}
        >
          <span class="w-20 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-faint">{a.group}</span>
          <span class="flex-1 truncate">{a.label}</span>
          {#if a.hint}
            <span class="shrink-0 rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-[10px] text-faint">{a.hint}</span>
          {/if}
        </button>
      {:else}
        <p class="px-3 py-6 text-center text-sm text-faint" data-agent-id="palette.empty">No matches.</p>
      {/each}
    </div>
  </div>
{/if}
