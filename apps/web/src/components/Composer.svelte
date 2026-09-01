<script lang="ts">
  // Inline ❯ prompt — the composer is a terminal input line, not a chat box.
  import type { SessionStore } from "@dextui/client";
  import { app, connection } from "../lib/state.svelte";

  let { store }: { store: SessionStore } = $props();

  let text = $state("");
  let menuIdx = $state(0);
  let inputEl: HTMLTextAreaElement | undefined = $state();

  const ALL_COMMANDS = [
    { cmd: "/approval", desc: "set dext approval profile", cap: "slash.approval" },
    { cmd: "/compact", desc: "compact session context", cap: "slash.compact" },
    { cmd: "/model", desc: "show or switch model", cap: "slash.model" },
    { cmd: "/todos", desc: "show the todo list", cap: "slash.todos" },
    { cmd: "/help", desc: "list host commands", cap: "slash.help" },
  ];

  let tick = $state(0);
  $effect(() => {
    const unsub = store.subscribe(() => {
      tick++;
    });
    return () => {
      unsub();
    };
  });
  const view = $derived.by(() => {
    void tick;
    return { ...store.state };
  });

  const commands = $derived(ALL_COMMANDS.filter((c) => app.caps.includes(c.cap)));
  const slashOpen = $derived(text.startsWith("/") && !text.includes(" "));
  const slashList = $derived(
    slashOpen ? commands.filter((c) => c.cmd.startsWith(text.trim().toLowerCase())) : [],
  );
  // menuIdx can outlive a shrinking list (typing narrows matches); clamp before use.
  const menuCur = $derived(slashList.length === 0 ? 0 : Math.min(menuIdx, slashList.length - 1));
  const live = $derived(view.status === "live");
  // Real hosts may not support mid-turn steering; honor the hello capability
  // (snapshotted into reactive app.caps at phase=live).
  const canSteer = $derived(app.caps.includes("steering"));
  const canSend = $derived(
    text.trim().length > 0 &&
      app.phase === "live" &&
      app.activeId !== "" &&
      live &&
      (!view.working || canSteer),
  );
  const placeholder = $derived(
    view.status === "exited"
      ? "session closed"
      : !live
        ? "waking session…"
        : view.working
          ? canSteer
            ? "steer the agent mid-turn…"
            : "turn running… (^c to stop)"
          : "type a request…   / commands",
  );
  const rows = $derived(Math.min(8, 1 + (text.match(/\n/g)?.length ?? 0)));

  // Per-session draft persistence: restore on switch, save on leave/send.
  $effect(() => {
    const sid = app.activeId;
    if (!sid) return;
    text = localStorage.getItem(`dextui.draft.${sid}`) ?? "";
    return () => {
      if (text) localStorage.setItem(`dextui.draft.${sid}`, text);
      else localStorage.removeItem(`dextui.draft.${sid}`);
    };
  });

  function complete(c: string) {
    text = `${c} `;
    menuIdx = 0;
    inputEl?.focus();
  }

  function send() {
    const c = connection();
    if (!canSend || !c) return;
    const sid = app.activeId;
    const t = text;
    if (t.trim().startsWith("/")) c.slash(sid, t.trim());
    else if (view.working && canSteer) c.steer(sid, t);
    else c.prompt(sid, t);
    localStorage.removeItem(`dextui.draft.${sid}`);
    text = "";
  }

  function stop() {
    const c = connection();
    if (c && app.activeId) c.interrupt(app.activeId);
  }

  function onKey(e: KeyboardEvent) {
    if (slashOpen && slashList.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        menuIdx = (menuCur + 1) % slashList.length;
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        menuIdx = (menuCur - 1 + slashList.length) % slashList.length;
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const item = slashList[menuCur];
        if (item) complete(item.cmd);
        return;
      }
      if (e.key === "Escape") {
        text = "";
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }
</script>

<div class="c-root" data-agent-id="composer.root">
  {#if slashOpen && slashList.length > 0}
    <div class="c-menu" data-agent-id="composer.menu" data-state="open">
      {#each slashList as c, i (c.cmd)}
        <button
          class="c-menu-row"
          class:cursor={i === menuCur}
          data-agent-id={`composer.menu.item.${c.cmd.slice(1)}`}
          data-state={i === menuCur ? "cursor" : "idle"}
          onclick={() => complete(c.cmd)}
          onmousemove={() => (menuIdx = i)}
        >
          <span class="c-cur">{i === menuCur ? "❯" : " "}</span>
          <span class="st-accent">{c.cmd}</span>
          <span class="dim">{c.desc}</span>
        </button>
      {/each}
    </div>
  {/if}

  <div class="c-row">
    <span class="pg" class:pg-busy={view.working}>❯</span>
    <textarea
      bind:this={inputEl}
      bind:value={text}
      onkeydown={onKey}
      {rows}
      {placeholder}
      data-agent-id="composer.input"
      data-state={view.working ? "working" : "idle"}
    ></textarea>
    <span class="c-side">
      {#if view.working}
        <button class="act err" data-agent-id="composer.stop" onclick={stop}>^c stop</button>
      {/if}
      <button
        class="act accent"
        data-agent-id={view.working && canSteer ? "composer.steer" : "composer.send"}
        data-state={canSend ? "ready" : "disabled"}
        onclick={send}
        disabled={!canSend}
      >
        [⏎] {view.working && canSteer ? "steer" : "send"}
      </button>
    </span>
  </div>
</div>

<style>
  .c-root {
    position: relative;
    padding: 4px 10px 6px;
  }
  .c-row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
  }
  .pg {
    color: var(--green);
    font-weight: bold;
    padding-bottom: 3px;
    user-select: none;
  }
  .pg-busy {
    color: var(--yellow);
  }
  textarea {
    flex: 1;
    resize: none;
    padding: 2px 0;
    line-height: 1.5;
    caret-color: var(--green);
  }
  .c-side {
    display: flex;
    gap: 12px;
    align-items: baseline;
    padding-bottom: 3px;
    flex-shrink: 0;
  }
  .c-menu {
    position: absolute;
    bottom: 100%;
    left: 10px;
    right: 10px;
    margin-bottom: 2px;
    border: 1px solid var(--line);
    background: var(--bg1);
    z-index: 20;
  }
  .c-menu-row {
    display: flex;
    gap: 10px;
    width: 100%;
    padding: 3px 8px;
    align-items: baseline;
  }
  .c-menu-row.cursor {
    background: var(--fg);
    color: var(--bg);
  }
  .c-menu-row.cursor .st-accent,
  .c-menu-row.cursor .dim {
    color: var(--bg);
  }
  .c-cur {
    color: var(--cyan);
    width: 12px;
    flex-shrink: 0;
  }
  .c-menu-row.cursor .c-cur {
    color: var(--bg);
  }
  .st-accent {
    color: var(--cyan);
  }
  .dim {
    color: var(--dim);
  }
</style>
