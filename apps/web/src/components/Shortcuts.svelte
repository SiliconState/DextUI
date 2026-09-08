<script lang="ts">
  // Shortcuts overlay: every binding in the app, one line each. `?` outside
  // inputs opens it; the Finder also exposes it as an action.
  import { app } from "../lib/state.svelte";
  import { useDialog } from "../lib/dialog.svelte";

  const dlg = useDialog(() => app.shortcutsOpen);

  const groups: { name: string; rows: [string, string][] }[] = [
    {
      name: "global",
      rows: [
        ["⌘/ctrl k", "finder"],
        ["⌘/ctrl b", "toggle sessions rail"],
        ["⌘/ctrl n", "new session"],
        ["ctrl [ / ]", "previous / next session"],
        ["?", "this overlay"],
        ["g", "pack gallery (outside inputs; hosts with packs)"],
        ["o", "folder picker — open a session in a folder; ⇧⏎ moves the current one"],
        ["esc", "close overlay / drawer"],
      ],
    },
    {
      name: "sessions",
      rows: [
        ["rail ⋯ / finder", "rename · close/wake · clear · delete"],
        ["sessions ⋯", "delete closed / delete all (confirmed)"],
        ["F2", "rename active session (outside inputs)"],
        ["⌘/ctrl backspace", "confirm deletion (outside inputs)"],
        ["clear vs close", "fresh context vs keep history for resuming"],
      ],
    },
    {
      name: "crew run sheet",
      rows: [
        ["rail / queue [open] / ticker", "open a run sheet (hosts with crew)"],
        ["j / k", "next / previous worker"],
        ["J / K", "next / previous step group"],
        ["⏎", "show this worker's log tail (one pane; ⏎ again hides)"],
        ["r", "refresh the tail"],
        ["x, then y", "stop the run (two-tap confirm; live runs only)"],
        ["a", "focus the answer box (paused runs only) · ⏎ submits"],
        ["esc", "leave the answer box, then close the sheet"],
      ],
    },
    {
      name: "compose",
      rows: [
        ["⏎", "send (steer when supported)"],
        ["shift ⏎", "newline"],
        ["↑ / ↓", "history — first / last line"],
        ["tab", "complete / command"],
      ],
    },
    {
      name: "turn",
      rows: [["^c", "stop the running turn"]],
    },
    {
      name: "approvals",
      rows: [
        ["a", "approve once"],
        ["s", "approve always"],
        ["d", "deny"],
      ],
    },
    {
      name: "app",
      rows: [
        ["status line", "model · effort · approval · ⚙ settings menu"],
        ["rail / finder", "open todos panel · inspect blocks · raw events"],
      ],
    },
  ];

  function onWindowKey(e: KeyboardEvent) {
    dlg.onKey(e);
    if (!app.shortcutsOpen) return;
    if (e.key === "Escape" || e.key === "?") {
      e.preventDefault();
      app.shortcutsOpen = false;
    }
  }
</script>

<svelte:window onkeydown={onWindowKey} />

{#if app.shortcutsOpen}
  <div
    class="sc-scrim"
    data-agent-id="shortcuts.overlay"
    onclick={() => (app.shortcutsOpen = false)}
    onkeydown={() => {}}
    role="presentation"
  ></div>
  <div
    class="sc fade-in"
    role="dialog"
    aria-modal="true"
    aria-label="Keyboard shortcuts"
    tabindex="-1"
    use:dlg.ref
    data-agent-id="shortcuts.root"
    data-state="open"
  >
    <div class="sc-head">
      <span class="st-cyan">Shortcuts</span>
      <span class="faint">· every binding</span>
      <span class="sc-acts">
        <button class="act" data-agent-id="shortcuts.close" onclick={() => (app.shortcutsOpen = false)}
          >esc</button
        >
      </span>
    </div>
    <div class="sc-body">
      {#each groups as g (g.name)}
        <p class="sc-group faint">{g.name}</p>
        {#each g.rows as [key, desc] (key)}
          <div class="sc-row">
            <span class="sc-key">{key}</span>
            <span class="sc-desc dim">{desc}</span>
          </div>
        {/each}
      {/each}
    </div>
  </div>
{/if}

<style>
  .sc-scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: rgba(0, 0, 0, 0.55);
  }
  /* Finder treatment: same border + scrim + shadow value, nothing new. */
  .sc {
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
  .sc-head {
    display: flex;
    gap: 10px;
    align-items: baseline;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
  }
  .sc-acts {
    margin-left: auto;
  }
  .sc-body {
    max-height: 60vh;
    overflow-y: auto;
    padding: 6px 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .sc-group {
    margin-top: 8px;
    font-size: 11px;
  }
  .sc-group:first-child {
    margin-top: 0;
  }
  .sc-row {
    display: flex;
    gap: 12px;
    align-items: baseline;
  }
  .sc-key {
    width: 12ch;
    flex-shrink: 0;
    color: var(--cyan);
  }
  .sc-desc {
    min-width: 0;
  }
  .dim {
    color: var(--dim);
  }
  .faint {
    color: var(--faint);
  }
  .st-cyan {
    color: var(--cyan);
  }
</style>
