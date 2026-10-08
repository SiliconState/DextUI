<script lang="ts">
  // Todo panel: full-width disclosure line above the status line. Reads dext's
  // own todo files through the host REST surface (no push event — clients
  // refresh on activation and on turn_end, debounced).
  import type { SessionStore } from "@dextui/client";
  import type { TodosResponse } from "@dextui/protocol";
  import { app } from "../lib/state.svelte";
  import { prettyPath } from "../lib/markdown";
  import { useSession } from "../lib/useSession.svelte";
  import { useDialog } from "../lib/dialog.svelte";
  import { popoverPos } from "../lib/popover";

  let { store }: { store: SessionStore } = $props();

  const sess = useSession(() => store);
  const view = $derived(sess.view ?? store.state);
  const sessCwd = $derived(app.sessions.find((s) => s.id === view.id)?.cwd ?? "");

  let open = $state(localStorage.getItem("dextui.todosOpen") === "1");
  let mobile = $state(matchMedia("(max-width: 900px)").matches);
  const shownOpen = $derived(mobile ? app.todosOpen : open);
  const dlg = useDialog(() => mobile && app.todosOpen, () => document.querySelector<HTMLElement>('[data-agent-id="status.details"]'));
  let layoutRevision = $state(0);
  $effect(() => {
    if (!app.todosOpen) return;
    const resize = () => { layoutRevision += 1; };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  });
  const posStyle = $derived.by(() => { void layoutRevision; return popoverPos(null, 304); });
  function onKey(event: KeyboardEvent) {
    dlg.onKey(event);
    if (event.key === "Escape") { app.todosOpen = false; event.preventDefault(); }
    event.stopPropagation();
  }
  $effect(() => {
    const media = matchMedia("(max-width: 900px)");
    const update = () => { mobile = media.matches; app.todosOpen = false; };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  });
  let data = $state(null as TodosResponse | null);
  let loading = $state(false);
  let failed = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loadSeq = 0;

  const supported = $derived(app.caps.includes("todos_read"));
  $effect(() => { void app.hostEpoch; app.todosOpen = false; });
  $effect(() => { if (!supported) app.todosOpen = false; });
  const done = $derived(data ? data.items.filter((i) => i.status === "completed").length : 0);

  const panelState = $derived(
    failed && !data
      ? "unavailable"
      : loading && !data
        ? "loading"
        : data && data.items.length === 0
          ? "empty"
          : shownOpen
            ? "open"
            : "closed",
  );

  let seenReveal = app.todosReveal;
  $effect(() => {
    const reveal = app.todosReveal;
    if (reveal !== seenReveal) {
      seenReveal = reveal;
      if (mobile) {
        app.statusDetailsOpen = false;
        app.sessionCtlOpen = false;
        app.settingsOpen = false;
        app.todosOpen = true;
      }
      else { open = true; localStorage.setItem("dextui.todosOpen", "1"); }
    }
  });

  const glyph: Record<string, string> = { pending: "○", in_progress: "◐", completed: "●" };

  function toggle() {
    if (mobile) app.todosOpen = !app.todosOpen;
    else {
      open = !open;
      localStorage.setItem("dextui.todosOpen", open ? "1" : "0");
    }
  }

  async function load(sid: string): Promise<void> {
    const mine = ++loadSeq;
    const token = localStorage.getItem("dextui.token") ?? "";
    loading = true;
    try {
      const r = await fetch(`/sessions/${encodeURIComponent(sid)}/todos`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!r.ok) throw new Error(String(r.status));
      const body = (await r.json()) as TodosResponse;
      if (mine !== loadSeq) return; // a newer activation superseded this fetch
      data = body;
      failed = false;
    } catch {
      if (mine !== loadSeq) return;
      failed = true; // quiet: no toast spam
    } finally {
      if (mine === loadSeq) loading = false;
    }
  }

  function schedule(sid: string, ms: number): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void load(sid);
    }, ms);
  }

  // Activation refresh (also refires once the capability arrives from hello).
  // A session switch drops the previous list at once rather than showing it
  // under the new session's name until the fetch lands.
  let shownSid = "";
  $effect(() => {
    const sid = view.id;
    const scope = `${app.hostEpoch}:${sid}`;
    if (scope !== shownSid) {
      shownSid = scope;
      app.todosOpen = false;
      ++loadSeq; // invalidate the previous session's in-flight request immediately
      loading = false;
      data = null;
      failed = false;
    }
    if (sid && supported) schedule(sid, 0);
    else if (timer) { clearTimeout(timer); timer = undefined; }
  });

  // turn_end refresh: working true → false, debounced 250 ms.
  let wasWorking = false;
  $effect(() => {
    const w = view.working;
    const sid = view.id;
    if (w) {
      wasWorking = true;
      return;
    }
    const refresh = wasWorking;
    wasWorking = false;
    if (refresh && sid && supported) schedule(sid, 250);
  });

  // Push refresh: the host journals todos.changed right after todo_write, so
  // the panel follows the agent's list mid-turn instead of at turn_end.
  let seenVersion = 0;
  $effect(() => {
    const v = view.todosVersion ?? 0;
    const sid = view.id;
    if (v !== seenVersion) {
      seenVersion = v;
      if (v > 0 && sid && supported) schedule(sid, 100);
    }
  });

  $effect(() => {
    return () => {
      ++loadSeq;
      if (timer) clearTimeout(timer);
    };
  });
</script>

{#snippet todoList()}
  <ul class="todos-list">
    {#if failed && !data}<li class="st-red" data-agent-id="todos.empty">Todos unavailable</li>
    {:else if data && data.items.length > 0}
      {#each data.items as it, i (i)}
        <li class="todo" data-agent-id={`todos.item.${i}`} data-state={it.status}><span class={`tg tg-${it.status}`} aria-hidden="true">{glyph[it.status] ?? "○"}</span><span class="tt">{it.text}</span></li>
      {/each}
    {:else}<li class="faint" data-agent-id="todos.empty">{loading ? "Loading…" : "None"}</li>{/if}
  </ul>
{/snippet}

{#if supported}
  <div class="todos content-axis" class:mobile-hidden={mobile} data-agent-id="todos.root" data-state={panelState}>
    <button class="todos-head" data-agent-id="todos.toggle" aria-expanded={shownOpen} onclick={toggle}>
      <span class="faint">{shownOpen ? "▾" : "▸"}</span>
      <span class="st-cyan">Todos</span>
      {#if data}
        <span class="st-cyan">({done}/{data.items.length})</span>
        <span class="faint todo-source">· {data.source}</span>
        {#if data.path}
          {@const shown = prettyPath(data.path, sessCwd)}
          <span class="faint t-path" title={shown}>{shown}</span>
        {/if}
      {:else if loading}
        <span class="faint">· …</span>
      {/if}
      {#if failed && !data}<span class="st-red">✗</span>{/if}
    </button>
    {#if !mobile && shownOpen}{@render todoList()}{/if}
  </div>
  {#if mobile && app.todosOpen}
    <div class="todos-scrim" role="presentation" onclick={() => (app.todosOpen = false)}></div>
    <div class="todos-popout compact-popover" style={posStyle} role="dialog" aria-modal="true" aria-label="Session todos" tabindex="-1" use:dlg.ref onkeydown={onKey} data-agent-id="todos.overlay" onfocusin={(event) => { if (event.target instanceof HTMLElement) event.target.scrollIntoView({ block: "nearest" }); }}>
      <header><span>Todos{data ? ` · ${done}/${data.items.length}` : ""}</span><button class="act" data-dialog-initial data-agent-id="todos.close" onclick={() => (app.todosOpen = false)}>Close</button></header>
      {#if data && data.items.length > 0}<progress class="todo-progress" aria-label="Todo progress" value={done} max={data.items.length}></progress>{/if}
      {@render todoList()}
    </div>
  {/if}
{/if}

<style>
  .todos {
    border-top: 1px solid var(--line);
    background: var(--bg1);
    min-width: 0;
  }
  .todos-head {
    display: flex;
    gap: 6px;
    width: 100%;
    padding: 3px 0 1px;
    align-items: baseline;
    min-width: 0;
  }
  .t-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    font-size: 11px;
  }
  .todos-list {
    max-height: 30dvh;
    overflow-y: auto;
    padding: 2px 0 6px 2ch;
    display: flex;
    flex-direction: column;
    gap: 1px;
    list-style: none;
  }
  .todo {
    display: flex;
    gap: 6px;
    align-items: baseline;
    min-width: 0;
  }
  .tt {
    white-space: pre-wrap;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .tg-pending {
    color: var(--faint);
  }
  .tg-in_progress {
    color: var(--yellow);
  }
  .tg-completed {
    color: var(--green);
  }
  .todo[data-state="pending"] .tt {
    color: var(--dim);
  }
  .todo[data-state="in_progress"] .tt {
    color: var(--fg);
  }
  .todo[data-state="completed"] .tt {
    color: var(--dim);
  }
  .mobile-hidden { display: none; }
  .todos-scrim { position: fixed; inset: 0; z-index: 36; background: color-mix(in srgb, var(--bg) 55%, transparent); }
  .todos-popout { position: fixed; z-index: 37; width: min(19rem, calc(100vw - 16px)); border: 1px solid var(--line); background: var(--bg3); padding: 0 12px 8px; border-radius: 3px; box-shadow: 0 8px 32px #0005; }
  .todos-popout header { position: sticky; top: 0; z-index: 1; background: var(--bg3); display: flex; align-items: center; justify-content: space-between; gap: 8px; border-bottom: 1px solid var(--line); font-weight: 600; font-size: 14px; }
  .todos-popout header button { min-height: 44px; min-width: 44px; margin-right: -10px; text-align: center; color: var(--cyan); font-weight: 400; }
  .todos-popout .todos-list { max-height: none; overflow: visible; padding: 8px 0 0; font: inherit; gap: 8px; }
  .todo-progress { display: block; width: 100%; height: 2px; appearance: none; border: 0; background: var(--line); accent-color: var(--cyan); margin-top: 6px; }
  .todo-progress::-webkit-progress-bar { background: var(--line); }
  .todo-progress::-webkit-progress-value { background: var(--cyan); }
  .todo-progress::-moz-progress-bar { background: var(--cyan); }
  .faint {
    color: var(--faint);
  }
  .st-cyan {
    color: var(--cyan);
  }
  .st-red {
    color: var(--red);
  }
</style>
