<script lang="ts">
  import { app, dismissToast } from "../lib/state.svelte";

  const style: Record<string, string> = {
    info: "border-line bg-raised text-ink",
    ok: "border-ok/40 bg-ok/10 text-ok",
    warn: "border-warn/40 bg-warn/10 text-warn",
    err: "border-err/40 bg-err/10 text-err",
  };
  const icon: Record<string, string> = { info: "i", ok: "✓", warn: "!", err: "✕" };
</script>

<div
  class="pointer-events-none fixed right-3 top-3 z-50 flex w-[22rem] max-w-[calc(100vw-1.5rem)] flex-col gap-2"
  data-agent-id="toast.stack"
  data-state={app.toasts.length > 0 ? "active" : "empty"}
>
  {#each app.toasts as t (t.id)}
    <button
      data-agent-id={`toast.${t.id}`}
      data-state={t.kind}
      onclick={() => dismissToast(t.id)}
      class={`pointer-events-auto animate-[toast-in_.18s_ease-out] rounded-lg border px-3 py-2 text-left text-sm shadow-xl backdrop-blur ${style[t.kind]}`}
    >
      <span class="mr-2 font-mono text-xs opacity-70">{icon[t.kind]}</span>{t.text}
    </button>
  {/each}
</div>
