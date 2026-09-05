<script lang="ts">
  import { app, dismissToast } from "../lib/state.svelte";

  const icon: Record<string, string> = { info: "·", ok: "✓", warn: "⚠", err: "✗" };
</script>

<div class="toasts" data-agent-id="toast.stack" data-state={app.toasts.length > 0 ? "active" : "empty"} aria-live="polite">
  {#each app.toasts as t (t.id)}
    <div class={`toast t-${t.kind}`} data-agent-id={`toast.${t.id}`} data-state={t.kind} role="status">
      <button class="toast-text" onclick={() => dismissToast(t.id)}>{icon[t.kind]} {t.text}</button>
      {#if t.action}
        <button class="act accent toast-act" data-agent-id={`toast.${t.id}.action`} onclick={() => { t.action?.run(); dismissToast(t.id); }}>[{t.action.label}]</button>
      {/if}
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    left: 10px;
    bottom: 34px;
    z-index: 50;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: min(420px, calc(100vw - 20px));
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: flex;
    gap: 10px;
    align-items: baseline;
    padding: 5px 10px;
    border: 1px solid var(--line);
    background: var(--bg1);
    color: var(--fg);
    animation: fade-in 0.12s ease-out;
  }
  .toast-text {
    flex: 1;
    min-width: 0;
    color: inherit;
  }
  .toast-act {
    flex-shrink: 0;
  }
  .t-ok {
    border-left: 2px solid var(--green);
  }
  .t-warn {
    border-left: 2px solid var(--yellow);
  }
  .t-err {
    border-left: 2px solid var(--red);
  }
  .t-info {
    border-left: 2px solid var(--faint);
  }
</style>
