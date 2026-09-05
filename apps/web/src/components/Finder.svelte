<script lang="ts">
  // Finder: fzf in a browser. One input, one cursor, subsequence scoring.
  import {
    app,
    connection,
    activate,
    newSession,
    toggleTheme,
    copyText,
    rePair,
    queue,
    respondGlobal,
    requestSessionAction,
    closeSession,
    wakeSession,
  } from "../lib/state.svelte";
  import { useSession } from "../lib/useSession.svelte";
  import { useDialog } from "../lib/dialog.svelte";

  let query = $state("");
  let cursor = $state(0);

  // Reactive view of the active session so turn/approval actions (stop,
  // once/always/deny) refresh while the finder is open.
  const sess = useSession(() => {
    void app.hostEpoch;
    const c = connection();
    return c && app.activeId ? c.session(app.activeId) : null;
  });

  const dlg = useDialog(() => app.paletteOpen);

  interface Action {
    slug: string;
    label: string;
    hint?: string;
    group: string;
    run: () => void;
  }

  const actions = $derived.by<Action[]>(() => {
    const view = sess.view;
    const out: Action[] = [];
    // Approvals first — the global queue, oldest first, across every session.
    for (const e of queue.entries) {
      const short = e.pending.summary ? ` — ${e.pending.summary.slice(0, 40)}` : "";
      const respond = (choice: "once" | "always" | "deny") =>
        respondGlobal(e.sessionId, e.pending.request_id, choice);
      out.push({
        slug: `approve.${e.sessionId}.${e.pending.request_id}.once`,
        label: `approve once: ${e.pending.tool}${short}`,
        hint: e.sessionTitle,
        group: "appr",
        run: () => respond("once"),
      });
      out.push({
        slug: `approve.${e.sessionId}.${e.pending.request_id}.always`,
        label: `approve always: ${e.pending.tool}${short}`,
        hint: e.sessionTitle,
        group: "appr",
        run: () => respond("always"),
      });
      out.push({
        slug: `approve.${e.sessionId}.${e.pending.request_id}.deny`,
        label: `deny: ${e.pending.tool}${short}`,
        hint: e.sessionTitle,
        group: "appr",
        run: () => respond("deny"),
      });
    }
    // Count-only sessions: no request ids to act on — jump instead.
    for (const s of queue.counts) {
      out.push({
        slug: `approvals.${s.id}.open`,
        label: `open approvals: ${s.title}`,
        hint: `${s.count}`,
        group: "appr",
        run: () => activate(s.id),
      });
    }
    if (view?.working) {
      out.push({
        slug: "turn.stop",
        label: "stop the running turn",
        hint: "^c",
        group: "turn",
        run: () => connection()?.interrupt(app.activeId),
      });
    }
    out.push({ slug: "session.new", label: "new session", hint: "⌘n", group: "sess", run: newSession });
    if (view) {
      out.push({
        slug: "session.copyid",
        label: "copy session id",
        group: "sess",
        run: () => copyText(app.activeId, "session id"),
      });
      out.push({
        slug: "session.events",
        label: "show raw events",
        hint: `${view.recent.length}`,
        group: "sess",
        run: () => (app.eventsOpen = true),
      });
    }
    if (app.phase === "live" && app.caps.includes("session_manage")) {
      const id = app.activeId;
      const meta = app.sessions.find((s) => s.id === id);
      if (meta) {
        for (const kind of ["rename", "clear", "delete"] as const) {
          out.push({ slug: `session.${kind}`, label: `${kind} session${kind === "clear" ? " — fresh context" : kind === "delete" ? " — permanent purge" : ""}`, group: "sess", run: () => requestSessionAction({ kind, id }) });
        }
        out.push({ slug: "session.close-wake", label: meta.status === "cold" ? "wake session" : "close session — keep history", group: "sess", run: () => meta.status === "cold" ? wakeSession(id) : closeSession(id) });
      }
      if (app.sessions.length) out.push({ slug: "sessions.delete_all", label: "delete all sessions — permanent purge", group: "sess", run: () => requestSessionAction({ kind: "bulk", scope: "all" }) });
      if (app.sessions.some((s) => s.status === "cold" || s.status === "exited")) out.push({ slug: "sessions.delete_cold", label: "delete closed sessions — permanent purge", group: "sess", run: () => requestSessionAction({ kind: "bulk", scope: "cold" }) });
    }
    for (const s of app.sessions) {
      if (s.id === app.activeId) continue;
      out.push({
        slug: `goto.${s.id}`,
        label: `switch: ${s.title}`,
        hint: s.status,
        group: "sess",
        run: () => activate(s.id),
      });
    }
    out.push({
      slug: "app.shortcuts",
      label: "show shortcuts",
      hint: "?",
      group: "app",
      run: () => (app.shortcutsOpen = true),
    });
    out.push({
      slug: "theme.toggle",
      label: `theme: ${app.theme} → ${app.theme === "dark" ? "light" : app.theme === "light" ? "system" : "dark"}`,
      group: "app",
      run: toggleTheme,
    });
    out.push({ slug: "pair.reset", label: "re-pair with agent host", hint: "clears token", group: "app", run: rePair });
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
    return actions
      .map((a) => ({ a, s: score(a, q) }))
      .filter((x) => x.s >= 0)
      .sort((x, y) => y.s - x.s)
      .slice(0, 14)
      .map((x) => x.a);
  });

  $effect(() => {
    if (app.paletteOpen) {
      cursor = 0;
    } else {
      query = "";
    }
  });

  // Cursor can outlive a shrinking result list; clamp before use.
  const cur = $derived(filtered.length === 0 ? 0 : Math.min(cursor, filtered.length - 1));

  function close() {
    app.paletteOpen = false;
  }

  function run(a: Action) {
    close();
    a.run();
  }

  function onWindowKey(e: KeyboardEvent) {
    if (e.isComposing || app.sessionAction) return;
    dlg.onKey(e);
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
      cursor = Math.min(filtered.length - 1, cur + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      cursor = Math.max(0, cur - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const a = filtered[cur];
      if (a) run(a);
    }
  }
</script>

<svelte:window onkeydown={onWindowKey} />

{#if app.paletteOpen}
  <div class="fz-scrim" data-agent-id="palette.overlay" onclick={close} onkeydown={() => {}} role="presentation"></div>
  <div
    class="fz fade-in"
    role="dialog"
    aria-modal="true"
    aria-label="finder"
    tabindex="-1"
    use:dlg.ref
    data-agent-id="palette.root"
    data-state="open"
  >
    <div class="fz-input-row">
      <span class="st-green">❯</span>
      <input
        bind:value={query}
        placeholder="command or session…"
        data-agent-id="palette.input"
      />
      <span class="faint">esc</span>
    </div>
    <div class="fz-list" data-agent-id="palette.list">
      {#each filtered as a, i (a.slug)}
        <button
          class="fz-row"
          class:cursor={i === cur}
          data-agent-id={`palette.item.${a.slug}`}
          data-state={i === cur ? "cursor" : "idle"}
          onclick={() => run(a)}
          onmousemove={() => (cursor = i)}
        >
          <span class="fz-cur">{i === cur ? "❯" : " "}</span>
          <span class="fz-group">{a.group}</span>
          <span class="fz-label">{a.label}</span>
          {#if a.hint}
            <span class="fz-hint">{a.hint}</span>
          {/if}
        </button>
      {:else}
        <p class="fz-empty" data-agent-id="palette.empty">no matches</p>
      {/each}
    </div>
  </div>
{/if}

<style>
  .fz-scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: rgba(0, 0, 0, 0.55);
  }
  .fz {
    position: fixed;
    left: 50%;
    top: 14vh;
    transform: translateX(-50%);
    z-index: 41;
    width: min(620px, 94vw);
    border: 1px solid var(--line);
    background: var(--bg1);
    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5);
  }
  .fz-input-row {
    display: flex;
    gap: 8px;
    align-items: baseline;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
  }
  .fz-input-row input {
    flex: 1;
  }
  .fz-list {
    max-height: 46vh;
    overflow-y: auto;
    padding: 4px 0;
  }
  .fz-row {
    display: flex;
    gap: 10px;
    width: 100%;
    padding: 3px 12px;
    align-items: baseline;
  }
  .fz-row.cursor {
    background: var(--fg);
    color: var(--bg);
  }
  .fz-cur {
    color: var(--cyan);
    width: 12px;
    flex-shrink: 0;
  }
  .fz-row.cursor .fz-cur,
  .fz-row.cursor .fz-group,
  .fz-row.cursor .fz-hint {
    color: var(--bg);
  }
  .fz-group {
    color: var(--faint);
    width: 4ch;
    flex-shrink: 0;
  }
  .fz-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fz-hint {
    color: var(--faint);
    flex-shrink: 0;
  }
  .fz-empty {
    padding: 14px 12px;
    color: var(--faint);
  }
  .st-green {
    color: var(--green);
  }
  .faint {
    color: var(--faint);
  }
</style>
