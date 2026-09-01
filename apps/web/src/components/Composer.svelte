<script lang="ts">
  import type { SessionStore } from "@dextui/client";
  import { app, connection } from "../lib/state.svelte";

  let { store }: { store: SessionStore } = $props();

  let text = $state("");
  let menuIdx = $state(0);
  let inputEl: HTMLTextAreaElement | undefined = $state();

  const COMMANDS = [
    { cmd: "/compact", desc: "compact session context" },
    { cmd: "/model", desc: "show or switch model" },
    { cmd: "/todos", desc: "show the todo list" },
    { cmd: "/help", desc: "list host commands" },
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
    // Re-boxed per tick: see App.svelte note on Svelte 5 derived equality.
    return { ...store.state };
  });

  const slashOpen = $derived(text.startsWith("/") && !text.includes(" "));
  const slashList = $derived(
    slashOpen ? COMMANDS.filter((c) => c.cmd.startsWith(text.trim().toLowerCase())) : [],
  );
  // menuIdx can outlive a shrinking list (typing narrows matches); clamp before use.
  const menuCur = $derived(slashList.length === 0 ? 0 : Math.min(menuIdx, slashList.length - 1));
  const live = $derived(view.status === "live");
  const canSend = $derived(text.trim().length > 0 && app.phase === "live" && app.activeId !== "" && live);
  const placeholder = $derived(
    !live ? "Waking session…" : view.working ? "Steer the agent mid-turn…" : "Ask dext…  / for commands",
  );
  const rows = $derived(Math.min(6, 1 + (text.match(/\n/g)?.length ?? 0)));

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
    else if (view.working) c.steer(sid, t);
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
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }
</script>

<div class="relative border-t border-line bg-panel px-3 py-3 md:px-4" data-agent-id="composer.root">
  {#if slashOpen && slashList.length > 0}
    <div
      class="absolute bottom-full left-3 right-3 mb-1 overflow-hidden rounded-xl border border-line bg-panel shadow-2xl md:left-4 md:right-4"
      data-agent-id="composer.menu"
      data-state="open"
    >
      {#each slashList as c, i (c.cmd)}
        <button
          data-agent-id={`composer.menu.item.${c.cmd.slice(1)}`}
          data-state={i === menuCur ? "cursor" : "idle"}
          onclick={() => complete(c.cmd)}
          onmousemove={() => (menuIdx = i)}
          class={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm ${
            i === menuCur ? "bg-accent/15" : "hover:bg-raised"
          }`}
        >
          <span class="font-mono text-accent">{c.cmd}</span>
          <span class="truncate text-xs text-dim">{c.desc}</span>
          {#if i === menuCur}
            <span class="ml-auto shrink-0 rounded border border-line bg-raised px-1.5 font-mono text-[10px] text-faint">tab</span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}

  <div class="flex items-end gap-2">
    <textarea
      bind:this={inputEl}
      bind:value={text}
      onkeydown={onKey}
      {rows}
      {placeholder}
      class="flex-1 resize-none rounded-xl border border-line bg-raised px-3 py-2 text-[15px] leading-snug focus:border-accent focus:outline-none"
      data-agent-id="composer.input"
      data-state={view.working ? "working" : "idle"}
    ></textarea>
    {#if view.working}
      <button
        data-agent-id="composer.stop"
        onclick={stop}
        class="rounded-xl border border-err/50 px-4 py-2 text-sm font-medium text-err hover:bg-err/10"
      >
        Stop
      </button>
    {/if}
    <button
      data-agent-id={view.working ? "composer.steer" : "composer.send"}
      data-state={canSend ? "ready" : "disabled"}
      onclick={send}
      disabled={!canSend}
      class="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-bg transition-opacity disabled:opacity-40"
    >
      {view.working ? "Steer" : "Send"}
    </button>
  </div>
  <p class="mt-1.5 hidden px-1 text-[11px] text-faint md:block">
    enter to send · shift+enter newline · <span class="font-mono">/</span> commands · <span class="font-mono">⌘K</span> palette
  </p>
</div>
