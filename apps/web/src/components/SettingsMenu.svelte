<script lang="ts">
  // Settings popover: the status bar's four scattered controls — theme,
  // notifications, providers, sign out — folded behind one trigger so the bar
  // reads as status, not a toolbar. Anchored to the trigger's viewport rect
  // (opens away from the nearest edge); a transparent catcher closes it on any
  // outside click. Theme offers explicit choices, not a blind cycle.
  import type { Theme } from "../lib/state.svelte";
  import { app, setTheme, setCompactTools, closeSettings, toggleNotify, rePair } from "../lib/state.svelte";
  import { openProviders, providersEnabled } from "../lib/connectors.svelte";
  import { popoverPos } from "../lib/popover";
  import { useDialog } from "../lib/dialog.svelte";

  const dlg = useDialog(() => app.settingsOpen);

  const THEMES: { value: Theme; label: string }[] = [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dim", label: "Dim" },
    { value: "dark", label: "Dark" },
  ];

  // Anchored away from the nearest edge by the shared popover geometry
  // (menu is 15rem wide); no anchor → bottom-right corner.
  const posStyle = $derived(popoverPos(app.settingsAnchor, 240));

  const notifyLabel = $derived(app.notify === "on" ? "On" : app.notify === "blocked" ? "Blocked" : "Off");

  function onKey(e: KeyboardEvent) {
    dlg.onKey(e);
    if (e.key === "Escape") {
      closeSettings();
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function pickProviders() {
    closeSettings();
    openProviders();
  }
</script>

{#if app.settingsOpen}
  <div class="menu-catch" data-agent-id="settings.scrim" onclick={closeSettings} onkeydown={() => {}} role="presentation"></div>
  <div
    class="menu"
    style={posStyle}
    role="dialog"
    aria-modal="true"
    aria-label="Settings"
    tabindex="-1"
    use:dlg.ref
    data-agent-id="settings.overlay"
    onkeydown={onKey}
  >
    <div class="sec">
      <span class="lbl">Theme</span>
      <div class="seg" role="group" aria-label="Theme">
        {#each THEMES as t (t.value)}
          <button
            class="seg-b"
            class:on={app.theme === t.value}
            aria-pressed={app.theme === t.value}
            data-agent-id={`theme.set.${t.value}`}
            onclick={() => setTheme(t.value)}
          >{t.label}</button>
        {/each}
      </div>
    </div>

    <div class="sec">
      <span class="lbl">Work details</span>
      <div class="seg two" role="group" aria-label="Work details">
        <button class="seg-b" class:on={app.compactTools} aria-pressed={app.compactTools} data-agent-id="tools.view.compact" onclick={() => setCompactTools(true)}>Compact</button>
        <button class="seg-b" class:on={!app.compactTools} aria-pressed={!app.compactTools} data-agent-id="tools.view.all" onclick={() => setCompactTools(false)}>Show all</button>
      </div>
      <span class="hint">Bash output stays visible in both views</span>
    </div>

    <div class="sec row">
      <span class="lbl">Notifications</span>
      <button
        class="pill"
        class:on={app.notify === "on"}
        data-agent-id="notify.toggle"
        data-state={app.notify}
        disabled={app.notify === "blocked"}
        title={app.notify === "blocked" ? "Your browser blocked notifications for this site" : "Notify while the tab is hidden"}
        onclick={toggleNotify}
      >{notifyLabel}</button>
    </div>

    <div class="div" aria-hidden="true"></div>

    {#if providersEnabled()}
      <button class="item" data-agent-id="providers.open" onclick={pickProviders}>
        <span>Providers</span>
        <span class="hint">Sign in to model vendors</span>
      </button>
    {/if}
    <button class="item danger" data-agent-id="pair.reset" onclick={rePair}>
      <span>Sign out</span>
      <span class="hint">Forget the access code on this device</span>
    </button>
  </div>
{/if}

<style>
  .menu-catch {
    position: fixed;
    inset: 0;
    z-index: 36;
  }
  .menu {
    position: fixed;
    z-index: 37;
    width: min(15rem, calc(100vw - 24px));
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border: 1px solid var(--line);
    background: var(--bg3);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
    font-size: 12px;
    animation: fade-in 0.1s ease-out;
  }
  .sec {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 2px;
  }
  .sec.row {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }
  .lbl {
    color: var(--faint);
    font-size: 0.85em;
    letter-spacing: 0.04em;
  }
  .seg {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
  }
  .seg.two { grid-template-columns: repeat(2, 1fr); }
  .seg-b {
    text-align: center;
    padding: 4px 0;
    border: 1px solid var(--line);
    color: var(--dim);
    background: var(--bg1);
  }
  .seg-b:hover {
    color: var(--fg);
    border-color: var(--faint);
  }
  .seg-b.on {
    color: var(--bg);
    background: var(--cyan);
    border-color: var(--cyan);
  }
  .pill {
    padding: 2px 12px;
    border: 1px solid var(--line);
    color: var(--dim);
    background: var(--bg1);
  }
  .pill.on {
    color: var(--green);
    border-color: var(--green);
  }
  .pill:disabled {
    color: var(--faint);
    cursor: default;
  }
  .div {
    height: 1px;
    background: var(--line);
    margin: 1px 0;
  }
  .item {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 6px 8px;
    color: var(--fg);
  }
  .item:hover {
    background: color-mix(in srgb, var(--bg2) 60%, transparent);
  }
  .item.danger:hover {
    color: var(--red);
  }
  .hint {
    color: var(--faint);
    font-size: 0.85em;
  }
</style>
