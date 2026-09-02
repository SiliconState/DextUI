<script lang="ts">
  // Todo panel: full-width disclosure line above the status line. Reads dext's
  // own todo files through the host REST surface (no push event — clients
  // refresh on activation and on turn_end, debounced).
  import type { SessionStore } from "@dextui/client";
  import type { TodosResponse } from "@dextui/protocol";
  import { app } from "../lib/state.svelte";
  import { prettyPath } from "../lib/markdown";
  import { useSession } from "../lib/useSession.svelte";

  let { store }: { store: SessionStore } = $props();

  const sess = useSession(() => store);
  const view = $derived(sess.view ?? store.state);
  const sessCwd = $derived(app.sessions.find((s) => s.id === view.id)?.cwd ?? "");

  let open = $state(localStorage.getItem("dextui.todosOpen") === "1");
  let data = $state(null as TodosResponse | null);
  let loading = $state(false);
  let failed = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loadSeq = 0;

  const supported = $derived(app.caps.includes("todos_read"));
  const done = $derived(data ? data.items.filter((i) => i.status === "completed").length : 0);

  const panelState = $derived(
    failed && !data
      ? "unavailable"
      : loading && !data
        ? "loading"
        : data && data.items.length === 0
          ? "empty"
          : open
            ? "open"
            : "closed",
  );

  const glyph: Record<string, string> = { pending: "○", in_progress: "◐", completed: "●" };

  function toggle() {
    open = !open;
    localStorage.setItem("dextui.todosOpen", open ? "1" : "0");
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
    void supported;
    if (sid !== shownSid) {
      shownSid = sid;
      data = null;
      failed = false;
    }
    if (sid && supported) schedule(sid, 0);
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

  $effect(() => {
    return () => {
      if (timer) clearTimeout(timer);
    };
  });
</script>

{#if supported}
  <div class="todos content-axis" data-agent-id="todos.root" data-state={panelState}>
    <button class="todos-head" data-agent-id="todos.toggle" aria-expanded={open} onclick={toggle}>
      <span class="faint">{open ? "▾" : "▸"}</span>
      <span class="st-cyan">todos</span>
      {#if data}
        <span class="st-cyan">({done}/{data.items.length})</span>
        <span class="faint">· {data.source}</span>
        {#if data.path}
          {@const shown = prettyPath(data.path, sessCwd)}
          <span class="faint t-path" title={shown}>{shown}</span>
        {/if}
      {:else if loading}
        <span class="faint">· …</span>
      {/if}
      {#if failed && !data}<span class="st-red">✗</span>{/if}
    </button>
    {#if open}
      <ul class="todos-list">
        {#if failed && !data}
          <li class="st-red" data-agent-id="todos.empty">✗ todos unavailable</li>
        {:else if data && data.items.length > 0}
          {#each data.items as it, i (i)}
            <li class="todo" data-agent-id={`todos.item.${i}`} data-state={it.status}>
              <span class={`tg tg-${it.status}`} aria-hidden="true">{glyph[it.status] ?? "○"}</span>
              <span class="tt">{it.text}</span>
            </li>
          {/each}
        {:else}
          <li class="faint" data-agent-id="todos.empty">— none</li>
        {/if}
      </ul>
    {/if}
  </div>
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
